/**
 * app.js — Main Application Controller  v3.0
 * ─────────────────────────────────────────────
 * NEW in this version:
 *   • Camera device enumerator — lists all video inputs at startup
 *   • Camera selector dropdown — lets user switch between webcams
 *   • Live camera diagnostics — brightness, noise, skin%, quality grade
 *   • Adaptive scan duration — extends to 60s automatically if SNR stays poor
 *   • Pixel quality indicator — shows % of ROI pixels that passed quality gate
 *   • Better camera constraints — requests higher resolution when available
 *   • Camera resolution display — shows actual W×H in diagnostics
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════════════ */
const SCAN_DURATION_S    = 30;     // base scan duration
const SCAN_MAX_S         = 60;     // auto-extend up to 60s if signal is poor
const ESTIMATE_EVERY_MS  = 1200;
const MIN_SAMPLES        = 75;
const MAX_BUFFER_S       = 90;
const MOTION_REJECT_THR  = 0.30;
const SNR_ACCEPT_THR_DB  = 1.0;
const SNR_EXTEND_THR_DB  = 3.0;   // if best SNR stays < this after 30s → auto-extend

/* ══════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════ */
let state = {
  mode: 'idle', startTime: null, lastEstMs: 0,
  faceMesh: null, camera: null, stream: null,
  fps: 30, frameTs: [],
  rBuf: [], gBuf: [], bBuf: [],
  motionFrames: 0, totalFrames: 0,
  // Camera info
  selectedDeviceId: null,
  cameraDevices: [],
  cameraResolution: { w: 0, h: 0 },
  cameraQuality: null,   // latest analyzeFrameQuality result
  pixQualityHistory: [], // rolling last 30 qualityScore values
  bestSNR: -Infinity,    // track best SNR to decide on auto-extension
  scanExtended: false,
  // Vitals
  hrBPM: null, hrv: null, snrDB: null, stress: null,
  spo2: null, breath: null, algo: 'CHROM',
  overlayCtx: null, hiddenCtx: null,
  bpmSmoother: null,
};

/* ══════════════════════════════════════════════════════════
   DOM
════════════════════════════════════════════════════════════ */
const video         = document.getElementById('webcamVideo');
const overlayCanvas = document.getElementById('overlayCanvas');
const scanBarFill   = document.getElementById('scanBarFill');
const scanSeconds   = document.getElementById('scanSeconds');
const startBtn      = document.getElementById('startBtn');
const resetBtn      = document.getElementById('resetBtn');
const statusDot     = document.getElementById('statusDot');
const statusText    = document.getElementById('statusText');

const $ = id => document.getElementById(id);

/* ══════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {
  Charts.initWaveformChart();
  Charts.initSpectrumChart();
  Charts.initRGBChart();
  Charts.initTrendChart();

  const hiddenCanvas  = document.createElement('canvas');
  state.hiddenCtx     = hiddenCanvas.getContext('2d', { willReadFrequently: true });
  state.overlayCtx    = overlayCanvas.getContext('2d');
  state.bpmSmoother   = new SignalEngine.BPMSmoother(7);

  startBtn.addEventListener('click', onStartClicked);
  resetBtn.addEventListener('click', onResetClicked);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Enumerate cameras on load (requires no permission yet)
  await enumerateCameras();

  setStatus('idle', 'Ready — click Start Scan');
});

/* ══════════════════════════════════════════════════════════
   CAMERA ENUMERATION
   ══════════════════════════════════════════════════════════
   Lists all video input devices. Populates the camera selector
   dropdown. This needs to run AFTER the user grants camera
   permission (or the labels will be hidden by the browser).
   We do a first pass without permission, then re-enumerate
   after the first getUserMedia call succeeds.
*/
async function enumerateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    state.cameraDevices = videoDevices;
    populateCameraDropdown(videoDevices);
  } catch (e) {
    console.warn('Camera enumeration failed:', e);
  }
}

function populateCameraDropdown(devices) {
  const sel = $('cameraSelect');
  if (!sel) return;
  sel.innerHTML = '';

  if (devices.length === 0) {
    sel.innerHTML = '<option value="">No cameras found</option>';
    return;
  }

  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i + 1}`;
    if (d.deviceId === state.selectedDeviceId) opt.selected = true;
    sel.appendChild(opt);
  });

  sel.addEventListener('change', () => {
    state.selectedDeviceId = sel.value;
    // If scanning, restart with new camera
    if (state.mode === 'scanning') {
      stopSession();
      Charts.resetCharts();
      state.bpmSmoother.reset();
      ROIEngine.resetMotionDetector();
      startSession();
    }
  });
}

/* ══════════════════════════════════════════════════════════
   BUTTON HANDLERS
════════════════════════════════════════════════════════════ */
async function onStartClicked() {
  if (['idle', 'done', 'error'].includes(state.mode)) {
    // Capture selected camera
    const sel = $('cameraSelect');
    if (sel && sel.value) state.selectedDeviceId = sel.value;
    await startSession();
  }
}

function onResetClicked() {
  stopSession();
  resetUI();
  Charts.resetCharts();
  state.bpmSmoother.reset();
  ROIEngine.resetMotionDetector();
  state.bestSNR = -Infinity;
  state.scanExtended = false;
  setStatus('idle', 'Ready — click Start Scan');
}

/* ══════════════════════════════════════════════════════════
   WEBCAM INIT
   ══════════════════════════════════════════════════════════
   Tries ideal constraints first. If camera can't deliver ideal,
   browser automatically negotiates — we read the actual track
   settings after opening to show the user what they actually got.
*/
async function startSession() {
  setStatus('active', 'Requesting camera…');
  startBtn.disabled = true;

  try {
    // Build video constraints — use selected device if available
    const videoConstraints = {
      width:     { ideal: 1280, min: 320 },
      height:    { ideal: 720,  min: 240 },
      frameRate: { ideal: 30,   min: 15  },
      facingMode: 'user',
    };
    if (state.selectedDeviceId) {
      videoConstraints.deviceId = { exact: state.selectedDeviceId };
    }

    state.stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });

    // Re-enumerate now that we have permission (browser reveals labels)
    await enumerateCameras();

    video.srcObject = state.stream;
    await new Promise(res => { video.onloadedmetadata = res; });
    await video.play();

    // Read actual track settings
    const track    = state.stream.getVideoTracks()[0];
    const settings = track.getSettings();
    state.cameraResolution = { w: settings.width || video.videoWidth, h: settings.height || video.videoHeight };
    const actualFPS        = settings.frameRate || 30;
    state.fps              = actualFPS;

    // Update camera info panel
    updateCameraInfoPanel(track.label, settings);

    const vw = video.videoWidth, vh = video.videoHeight;
    overlayCanvas.width  = vw; overlayCanvas.height = vh;
    state.hiddenCtx.canvas.width  = vw;
    state.hiddenCtx.canvas.height = vh;

    state.faceMesh = new FaceMesh({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
    });
    state.faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence:  0.5,
    });
    state.faceMesh.onResults(onFaceMeshResults);

    state.camera = new Camera(video, {
      onFrame: async () => { await state.faceMesh.send({ image: video }); },
      width: vw, height: vh,
    });
    await state.camera.start();

    state.rBuf = []; state.gBuf = []; state.bBuf = [];
    state.frameTs = [];
    state.motionFrames = 0; state.totalFrames = 0;
    state.bestSNR = -Infinity;
    state.scanExtended = false;
    state.pixQualityHistory = [];
    state.mode = 'scanning';
    state.startTime = performance.now();
    state.lastEstMs = 0;

    setStatus('scanning', 'Scanning — hold still…');
    resetBtn.disabled = false;

  } catch (err) {
    console.error('Camera error:', err);
    const tip = err.name === 'NotAllowedError'
      ? 'Camera permission denied. Allow access in browser settings.'
      : err.name === 'NotFoundError'
      ? 'No camera found. Connect a webcam and try again.'
      : `Camera error: ${err.message}`;
    setStatus('error', tip);
    updateDiagnosticBanner('error', '❌ ' + tip);
    startBtn.disabled = false;
  }
}

function stopSession() {
  try { state.camera?.stop(); }   catch(e) {}
  try { state.faceMesh?.close(); } catch(e) {}
  state.stream?.getTracks().forEach(t => t.stop());
  video.srcObject = null;
  state.camera = null; state.faceMesh = null; state.stream = null;
  state.rBuf = []; state.gBuf = []; state.bBuf = [];
  state.frameTs = [];
  state.mode = 'idle';
}

/* ══════════════════════════════════════════════════════════
   onFaceMeshResults — CORE FRAME LOOP
════════════════════════════════════════════════════════════ */
function onFaceMeshResults(results) {
  if (state.mode !== 'scanning') return;

  const vw = overlayCanvas.width, vh = overlayCanvas.height;
  const lm = results.multiFaceLandmarks?.[0];
  const elapsedMs = performance.now() - state.startTime;
  const elapsedS  = elapsedMs / 1000;
  const scanLimit = state.scanExtended ? SCAN_MAX_S : SCAN_DURATION_S;

  // Actual FPS measurement
  const now = performance.now();
  state.frameTs.push(now);
  if (state.frameTs.length > 90) state.frameTs.shift();
  if (state.frameTs.length > 5) {
    const span = state.frameTs[state.frameTs.length - 1] - state.frameTs[0];
    state.fps  = (state.frameTs.length - 1) / (span / 1000);
  }

  if (lm) {
    // Motion
    const motionScore = ROIEngine.computeMotionScore(lm, vw, vh);
    const isMoving    = motionScore > MOTION_REJECT_THR;

    // Overlay
    ROIEngine.drawROIOverlay(state.overlayCtx, lm, vw, vh, true, motionScore);

    // Camera diagnostics (run every 10th frame to save CPU)
    if (state.totalFrames % 10 === 0) {
      state.hiddenCtx.drawImage(results.image, 0, 0, vw, vh);
      const fullImageData = state.hiddenCtx.getImageData(0, 0, vw, vh);
      state.cameraQuality = ROIEngine.analyzeFrameQuality(fullImageData, vw, vh);
      updateCameraQualityIndicator(state.cameraQuality);
    }

    state.totalFrames++;

    if (!isMoving) {
      // Draw frame to hidden canvas for pixel extraction
      if (state.totalFrames % 10 !== 0) {
        // Already drawn above on diagnostic frames; skip redundant draw
        state.hiddenCtx.drawImage(results.image, 0, 0, vw, vh);
      }
      const imageData = state.hiddenCtx.getImageData(0, 0, vw, vh);
      const rgb = ROIEngine.extractROIPixels(imageData, lm, vw, vh, state.cameraQuality);

      if (rgb) {
        state.rBuf.push(rgb.r); state.gBuf.push(rgb.g); state.bBuf.push(rgb.b);

        // Track pixel quality
        state.pixQualityHistory.push(rgb.qualityScore);
        if (state.pixQualityHistory.length > 30) state.pixQualityHistory.shift();

        const maxLen = Math.round(state.fps * MAX_BUFFER_S);
        if (state.rBuf.length > maxLen) {
          state.rBuf.shift(); state.gBuf.shift(); state.bBuf.shift();
        }

        Charts.pushRGBSample(rgb.r, rgb.g, rgb.b);
        updatePixelQualityBar(rgb.qualityScore, rgb.rejectedPct);
      }
    } else {
      state.motionFrames++;
    }

    updateMotionIndicator(motionScore, state.totalFrames > 0
      ? Math.round(state.motionFrames / state.totalFrames * 100) : 0);

  } else {
    state.overlayCtx.clearRect(0, 0, vw, vh);
    drawNoFaceMsg(state.overlayCtx, vw, vh);
    ROIEngine.resetMotionDetector();
  }

  // Progress bar — scales to scanLimit
  const pct = Math.min(100, (elapsedS / scanLimit) * 100);
  scanBarFill.style.width = pct + '%';
  scanSeconds.textContent = `${Math.min(Math.round(elapsedS), scanLimit)} / ${scanLimit} s${state.scanExtended ? ' (extended)' : ''}`;

  // Signal processing
  if (elapsedMs - state.lastEstMs > ESTIMATE_EVERY_MS && state.rBuf.length >= MIN_SAMPLES) {
    state.lastEstMs = elapsedMs;
    runSignalPipeline();
  }

  // Auto-extend scan if SNR is poor at end of base scan
  if (!state.scanExtended && elapsedS >= SCAN_DURATION_S) {
    if (state.bestSNR < SNR_EXTEND_THR_DB) {
      state.scanExtended = true;
      updateDiagnosticBanner('warning', `⏱ Signal quality low (SNR ${state.bestSNR.toFixed(1)} dB) — extending scan to 60 s for better accuracy`);
    }
  }

  // Complete
  if (elapsedS >= scanLimit) completeScan();
}

/* ══════════════════════════════════════════════════════════
   SIGNAL PIPELINE
════════════════════════════════════════════════════════════ */
function runSignalPipeline() {
  const fps = Math.max(10, Math.min(60, state.fps || 30));
  const r   = Float64Array.from(state.rBuf);
  const g   = Float64Array.from(state.gBuf);
  const b   = Float64Array.from(state.bBuf);

  const { result, algo, signal } = SignalEngine.bestRPPGSignal(r, g, b, fps);
  if (!result) return;

  state.algo = algo;
  $('algoLabel') && ($('algoLabel').textContent = algo);

  const { bpm, snrDB, mag, freqRes, binLow, binHigh, peakBin, rawFiltered } = result;

  // Track best SNR for auto-extend decision
  if (snrDB > state.bestSNR) state.bestSNR = snrDB;

  if (snrDB < SNR_ACCEPT_THR_DB) {
    $('snrValue') && ($('snrValue').textContent = snrDB.toFixed(1));
    if ($('snrStatus')) { $('snrStatus').textContent = 'Poor'; $('snrStatus').className = 'vital-status danger'; }
    updateDiagnosticBanner('warning', getCameraAdvice(state.cameraQuality, snrDB));
    return;
  }

  // Clear any warning once SNR is good
  if (snrDB >= SNR_EXTEND_THR_DB) clearDiagnosticBanner();

  state.bpmSmoother.push(bpm);
  const smoothBPM  = state.bpmSmoother.get();
  const confidence = state.bpmSmoother.confidence;

  const hrv    = SignalEngine.estimateHRV(rawFiltered, fps);
  const stress = SignalEngine.estimateStress(hrv);
  const spo2   = SignalEngine.estimateSpO2(r, g, fps);
  const breath = SignalEngine.estimateBreathingRate(signal, fps);

  state.hrBPM = smoothBPM; state.hrv = hrv; state.snrDB = snrDB;
  state.stress = stress; state.spo2 = spo2; state.breath = breath;

  // Waveform
  const lastN = rawFiltered.slice(-300);
  Charts.pushWaveformBatch(SignalEngine.normalise(Array.from(lastN)));

  // Spectrum + trend
  Charts.updateSpectrumChart(mag, freqRes, binLow, binHigh, peakBin, smoothBPM);
  Charts.pushTrendBPM(smoothBPM);

  // FPS
  $('fpsValue') && ($('fpsValue').textContent = Math.round(fps));

  updateVitalCards(confidence);
}

/* ══════════════════════════════════════════════════════════
   VITAL CARDS UI
════════════════════════════════════════════════════════════ */
function updateVitalCards(confidence) {
  const { hrBPM, hrv, snrDB, stress, spo2, breath } = state;

  if (hrBPM !== null)  { animVal('hrValue', hrBPM);  setChip('hrStatus',    classifyHR(hrBPM));     $('hrConfidence') && ($('hrConfidence').textContent = `${confidence}% conf.`); $('cardHR').classList.add('active'); }
  if (hrv   !== null)  { animVal('hrvValue', hrv);    setChip('hrvStatus',   classifyHRV(hrv));     $('cardHRV').classList.add('active'); }
  if (snrDB !== null)  { $('snrValue').textContent = snrDB.toFixed(1); setChip('snrStatus', classifySNR(snrDB)); $('cardSNR').classList.add('active'); }
  if (stress !== null) { animVal('stressValue', stress); setChip('stressStatus', classifyStress(stress)); $('cardStress').classList.add('active'); }
  if (spo2  !== null)  { animVal('spo2Value', spo2);  setChip('spo2Status',  classifySpO2(spo2));   $('cardSPO2').classList.add('active'); }
  if (breath !== null) { animVal('breathValue', breath); setChip('breathStatus', classifyBreath(breath)); $('cardBreath').classList.add('active'); }
}

function animVal(id, v) {
  const el = $(id); if (!el) return;
  el.textContent = v;
  el.classList.add('updating');
  setTimeout(() => el.classList.remove('updating'), 450);
}
function setChip(id, { label, cls }) {
  const el = $(id); if (!el) return;
  el.textContent = label; el.className = `vital-status ${cls}`;
}

/* ══════════════════════════════════════════════════════════
   CAMERA DIAGNOSTICS UI
════════════════════════════════════════════════════════════ */
function updateCameraInfoPanel(label, settings) {
  const w = settings.width  || video.videoWidth;
  const h = settings.height || video.videoHeight;
  const f = Math.round(settings.frameRate || state.fps);
  const camNameEl = $('camName');
  const camResEl  = $('camRes');
  const camFpsEl  = $('camFpsLabel');
  if (camNameEl) camNameEl.textContent = label || 'Unknown camera';
  if (camResEl)  camResEl.textContent  = `${w}×${h}`;
  if (camFpsEl)  camFpsEl.textContent  = `${f} fps`;

  // Quality warning for very low resolution cameras
  if (w < 480 || h < 360) {
    updateDiagnosticBanner('warning', `⚠ Low resolution (${w}×${h}). rPPG needs at least 640×480 for reliable readings. Try an external USB webcam.`);
  }
}

function updateCameraQualityIndicator(quality) {
  if (!quality) return;
  const gradeEl = $('camGrade');
  const briEl   = $('camBrightness');
  const noiseEl = $('camNoise');
  const skinEl  = $('camSkin');

  if (gradeEl) {
    const icons = { good: '🟢 Good', dim: '🟡 Too Dark', bright: '🟠 Too Bright', noisy: '🟠 Noisy', poor: '🔴 Poor' };
    gradeEl.textContent = icons[quality.grade] || quality.grade;
    gradeEl.className   = `cam-grade-value ${quality.grade}`;
  }
  if (briEl)   briEl.textContent   = Math.round(quality.meanBrightness);
  if (noiseEl) noiseEl.textContent  = quality.noisePerPixel.toFixed(1);
  if (skinEl)  skinEl.textContent   = Math.round(quality.skinRatio * 100) + '%';

  // Contextual advice
  if (quality.grade !== 'good') {
    updateDiagnosticBanner('warning', getCameraAdvice(quality, state.snrDB || 0));
  } else if (!state.scanExtended) {
    clearDiagnosticBanner();
  }
}

function updatePixelQualityBar(qualityScore, rejectedPct) {
  const bar = $('pixQualityBar');
  const lbl = $('pixQualityLabel');
  if (bar) bar.style.width = Math.round(qualityScore * 100) + '%';
  if (lbl) lbl.textContent = `${Math.round(qualityScore * 100)}% valid pixels (${rejectedPct}% rejected)`;
}

function updateMotionIndicator(score, pct) {
  const el = $('motionBadge');
  if (!el) return;
  const moving = score > MOTION_REJECT_THR;
  el.textContent = moving ? `⚡ Moving (${pct}% rejected)` : `✓ Stable (${pct}% rejected)`;
  el.className   = `motion-badge ${moving ? 'moving' : 'stable'}`;
}

function updateDiagnosticBanner(type, msg) {
  const el = $('diagBanner');
  if (!el) return;
  el.textContent  = msg;
  el.className    = `diag-banner ${type}`;
  el.style.display = 'block';
}

function clearDiagnosticBanner() {
  const el = $('diagBanner');
  if (el) el.style.display = 'none';
}

/* ──────────────────────────────────────────────────────────
   Contextual camera advice string
────────────────────────────────────────────────────────── */
function getCameraAdvice(quality, snrDB) {
  if (!quality) return '📡 Collecting signal — hold still…';
  switch (quality.grade) {
    case 'dim':    return '🌑 Too dark — turn on a lamp facing your face. Avoid sitting with a window behind you.';
    case 'bright': return '☀️ Too bright or overexposed — move away from direct light or lower camera exposure.';
    case 'noisy':  return '📷 Camera noise is high — try an external USB webcam for better rPPG accuracy.';
    case 'poor':   return snrDB < 1
      ? '❓ Face not clearly detected. Centre your face, remove glasses, and ensure even lighting.'
      : '📷 Signal quality is low. Consider an external webcam or improved lighting.';
    default: return '📡 Collecting signal…';
  }
}

/* ══════════════════════════════════════════════════════════
   SCAN COMPLETION
════════════════════════════════════════════════════════════ */
function completeScan() {
  state.mode = 'done';
  stopSession();
  setStatus('done', 'Scan Complete ✓');
  startBtn.disabled    = false;
  startBtn.textContent = '▶ New Scan';
  scanBarFill.style.width = '100%';
  clearDiagnosticBanner();
  runSignalPipeline();
  setTimeout(showResultModal, 700);
}

function showResultModal() {
  const { hrBPM, hrv, snrDB, stress, spo2, breath, algo } = state;
  const motPct = state.totalFrames > 0 ? Math.round(state.motionFrames / state.totalFrames * 100) : 0;
  const avgPixQ = state.pixQualityHistory.length > 0
    ? Math.round(state.pixQualityHistory.reduce((a,b)=>a+b,0)/state.pixQualityHistory.length * 100) : '--';

  $('modalBody').innerHTML = `
    ${mb('Heart Rate',     hrBPM,  'BPM',  classifyHR(hrBPM||0))}
    ${mb('HRV (RMSSD)',    hrv,    'ms',   classifyHRV(hrv))}
    ${mb('SpO₂ (est.)',    spo2,   '%',    classifySpO2(spo2||95))}
    ${mb('Breathing Rate', breath, 'br/m', classifyBreath(breath||15))}
    ${mb('Stress Index',   stress, '/100', classifyStress(stress||30))}
    ${mb('Signal SNR',     snrDB !== null ? snrDB.toFixed(1) : null, 'dB', classifySNR(snrDB||0))}
    <div class="modal-metric" style="grid-column:1/-1">
      <div class="m-label">AI Insight</div>
      <div class="m-interp" style="font-size:0.84rem">${generateInsight(hrBPM, hrv, stress, spo2)}</div>
    </div>
    <div class="modal-metric" style="grid-column:1/-1;text-align:center;font-size:0.7rem;opacity:0.55">
      Algorithm: ${algo} · Motion rejected: ${motPct}% · Pixel quality: ${avgPixQ}% · FPS: ${Math.round(state.fps)}
      ${state.scanExtended ? ' · Scan auto-extended to 60 s' : ''}
    </div>
  `;
  $('resultModal').style.display = 'flex';
}

function mb(label, value, unit, { label: interp, cls }) {
  return `<div class="modal-metric">
    <div class="m-label">${label}</div>
    <div class="m-value">${(value !== null && value !== undefined) ? value : '—'}</div>
    <div class="m-unit">${unit}</div>
    <div class="m-interp vital-status ${cls}" style="display:inline-block;margin-top:6px">${interp}</div>
  </div>`;
}

function generateInsight(bpm, hrv, stress, spo2) {
  const lines = [];
  if (!bpm) return 'Insufficient signal — improve lighting and rescan.';
  if (bpm >= 60 && bpm <= 100) lines.push('Heart rate is within the normal resting range.');
  else if (bpm < 60) lines.push('Heart rate appears lower than average (possible bradycardia).');
  else lines.push('Heart rate is elevated — ensure you were fully at rest during the scan.');
  if (hrv !== null) {
    if (hrv >= 50) lines.push('HRV is good — autonomic system is well-recovered.');
    else if (hrv >= 20) lines.push('Moderate HRV — consider deep breathing or rest.');
    else lines.push('Low HRV suggests physiological stress or fatigue.');
  }
  if (spo2 !== null && spo2 < 95) lines.push('SpO₂ estimate is below normal range — note this is a rough proxy only.');
  lines.push('<em style="color:rgba(255,255,255,0.3);font-size:0.7rem">PoC only · Not a medical diagnosis</em>');
  return lines.join(' ');
}

/* ══════════════════════════════════════════════════════════
   MODAL ACTIONS
════════════════════════════════════════════════════════════ */
window.closeModal = () => { $('resultModal').style.display = 'none'; };

window.downloadReport = () => {
  const { hrBPM, hrv, snrDB, stress, spo2, breath, algo } = state;
  const motPct = Math.round(state.motionFrames / Math.max(1, state.totalFrames) * 100);
  const avgPixQ = state.pixQualityHistory.length > 0
    ? Math.round(state.pixQualityHistory.reduce((a,b)=>a+b,0)/state.pixQualityHistory.length * 100) : 'N/A';
  const lines = [
    '═══════════════════════════════════════',
    '        EROS WELLNESS AI REPORT  v3',
    '═══════════════════════════════════════',
    `Date/Time       : ${new Date().toISOString()}`,
    `Camera          : ${$('camName')?.textContent || 'N/A'}`,
    `Resolution      : ${state.cameraResolution.w}×${state.cameraResolution.h}`,
    `FPS             : ${Math.round(state.fps)}`,
    `Algorithm       : ${algo}`,
    `Motion rejected : ${motPct}%`,
    `Pixel quality   : ${avgPixQ}%`,
    `Scan extended   : ${state.scanExtended ? 'Yes (60s)' : 'No (30s)'}`,
    '───────────────────────────────────────',
    `Heart Rate      : ${hrBPM ?? 'N/A'} BPM`,
    `HRV (RMSSD)     : ${hrv   ?? 'N/A'} ms`,
    `SpO₂ (est.)     : ${spo2  ?? 'N/A'} %`,
    `Breathing Rate  : ${breath ?? 'N/A'} br/min`,
    `Stress Index    : ${stress ?? 'N/A'} / 100`,
    `Signal SNR      : ${snrDB !== null ? snrDB.toFixed(1) : 'N/A'} dB`,
    '───────────────────────────────────────',
    'DISCLAIMER: Proof-of-concept only.',
    '═══════════════════════════════════════',
  ].join('\n');

  const a = document.createElement('a');
  a.href    = URL.createObjectURL(new Blob([lines], { type: 'text/plain' }));
  a.download= `eros_report_${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
};

/* ══════════════════════════════════════════════════════════
   CLASSIFICATIONS
════════════════════════════════════════════════════════════ */
function classifyHR(bpm)   { return bpm<60?{label:'Bradycardia',cls:'warning'}:bpm<=100?{label:'Normal',cls:'good'}:bpm<=120?{label:'Elevated',cls:'warning'}:{label:'Tachycardia',cls:'danger'}; }
function classifyHRV(ms)   { if(!ms)return{label:'—',cls:''}; return ms>=50?{label:'Relaxed',cls:'good'}:ms>=20?{label:'Moderate',cls:'warning'}:{label:'High Stress',cls:'danger'}; }
function classifySNR(db)   { return db>=6?{label:'Excellent',cls:'good'}:db>=2?{label:'Good',cls:'good'}:db>=0?{label:'Fair',cls:'warning'}:{label:'Poor',cls:'danger'}; }
function classifyStress(s) { return s<=25?{label:'Low',cls:'good'}:s<=50?{label:'Moderate',cls:'warning'}:s<=75?{label:'High',cls:'warning'}:{label:'Very High',cls:'danger'}; }
function classifySpO2(v)   { return v>=98?{label:'Optimal',cls:'good'}:v>=95?{label:'Normal',cls:'good'}:v>=90?{label:'Low',cls:'warning'}:{label:'Very Low',cls:'danger'}; }
function classifyBreath(v) { return v>=12&&v<=20?{label:'Normal',cls:'good'}:v<12?{label:'Slow',cls:'warning'}:{label:'Fast',cls:'warning'}; }

/* ══════════════════════════════════════════════════════════
   STATUS & UI HELPERS
════════════════════════════════════════════════════════════ */
function setStatus(mode, text) {
  statusDot.className    = `badge-dot ${mode}`;
  statusText.textContent = text;
}

function resetUI() {
  ['hrValue','hrvValue','snrValue','stressValue','spo2Value','breathValue']
    .forEach(id => { const el=$(id); if(el) el.textContent='--'; });
  ['hrStatus','hrvStatus','snrStatus','stressStatus','spo2Status','breathStatus']
    .forEach(id => { const el=$(id); if(el){ el.textContent='—'; el.className='vital-status'; } });
  ['cardHR','cardHRV','cardSNR','cardStress','cardSPO2','cardBreath']
    .forEach(id => { const el=$(id); if(el) el.classList.remove('active'); });
  ['hrConfidence','algoLabel','fpsValue'].forEach(id => { const el=$(id); if(el) el.textContent='—'; });
  const mb2 = $('motionBadge'); if(mb2){ mb2.textContent='—'; mb2.className='motion-badge'; }
  const pb = $('pixQualityBar');  if(pb) pb.style.width = '0%';
  const pl = $('pixQualityLabel'); if(pl) pl.textContent = '';
  scanBarFill.style.width  = '0%';
  scanSeconds.textContent  = `0 / ${SCAN_DURATION_S} s`;
  startBtn.textContent     = '▶ Start Scan';
  startBtn.disabled        = false;
  resetBtn.disabled        = true;
  state.overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  clearDiagnosticBanner();
}

function drawNoFaceMsg(ctx, w, h) {
  ctx.fillStyle = 'rgba(255,77,109,0.85)';
  ctx.font      = 'bold 12px Segoe UI';
  ctx.textAlign = 'center';
  ctx.fillText('⚠ No face detected — centre your face in the frame', w / 2, h - 20);
}
