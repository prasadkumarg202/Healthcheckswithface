/**
 * roi.js — MediaPipe Face Mesh ROI Extraction  v3.0
 * ───────────────────────────────────────────────────
 * NEW in this version:
 *   • Pixel quality gate — rejects dark, saturated, non-skin pixels
 *   • Returns qualityScore + rejectedPct per frame for diagnostics
 *   • analyzeFrameQuality() — lightweight camera diagnostic function
 *   • Adaptive pixel threshold — loosens gate when camera is dim
 */

'use strict';

/* ── MediaPipe landmark indices ── */
const LANDMARKS = {
  FOREHEAD: [10,109,67,103,54,21,162,139,71,68,104,69,108,151,337,299,333,298,301,368,264,389,356,454,323,361,340,346,347,449],
  LEFT_CHEEK: [116,123,147,187,207,206,203,36,142,126,100,101,50,118,117,111],
  RIGHT_CHEEK: [345,352,376,411,427,426,423,266,371,355,329,330,280,347,346,340],
  MOTION_REFS: [4,6,168,1,2],
};

/* ══════════════════════════════════════════════════════════
   CAMERA QUALITY DIAGNOSTIC
   ══════════════════════════════════════════════════════════
   Samples a centre strip of the video frame to assess:
     • meanBrightness  — 0–255 (< 60 = too dark, > 200 = too bright)
     • noiseEstimate   — std dev of neighbouring pixel differences
     • skinPixelRatio  — fraction of the sample that looks like skin
     • qualityGrade    — 'good' | 'dim' | 'bright' | 'noisy' | 'poor'
   This is intentionally cheap — O(W) samples, not O(W×H).
*/
function analyzeFrameQuality(imageData, videoW, videoH) {
  const data  = imageData.data;
  const midY  = Math.floor(videoH / 2);
  const x0    = Math.floor(videoW * 0.25);
  const x1    = Math.floor(videoW * 0.75);

  let sumR = 0, sumG = 0, sumB = 0, skinCount = 0, totalPix = 0;
  let noiseAcc = 0;
  let prevR = -1;

  for (let px = x0; px <= x1; px++) {
    const idx = (midY * videoW + px) * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    sumR += r; sumG += g; sumB += b;
    totalPix++;

    // Skin heuristic: R dominant, warm colour
    if (r > 60 && r > b && g > b * 0.85 && r < 240) skinCount++;

    // Noise: pixel-to-pixel variance along row
    if (prevR >= 0) noiseAcc += Math.abs(r - prevR);
    prevR = r;
  }

  const meanBrightness = totalPix > 0 ? (sumR + sumG + sumB) / (3 * totalPix) : 0;
  const skinRatio      = totalPix > 0 ? skinCount / totalPix : 0;
  const noisePerPixel  = totalPix > 1 ? noiseAcc / (totalPix - 1) : 0;

  let grade = 'good';
  if (meanBrightness < 35)  grade = 'dim';
  else if (meanBrightness > 225) grade = 'bright';
  else if (noisePerPixel > 25)   grade = 'noisy';
  else if (skinRatio < 0.08)     grade = 'poor';

  return { meanBrightness, skinRatio, noisePerPixel, grade };
}

/* ══════════════════════════════════════════════════════════
   MOTION DETECTION
   ══════════════════════════════════════════════════════════ */
let _prevLandmarks = null;
let _motionSmooth  = 0;
const MOTION_ALPHA = 0.35;

function computeMotionScore(landmarks, videoW, videoH) {
  if (!landmarks || landmarks.length < 200) { _prevLandmarks = null; return 0; }

  const leftEye  = landmarks[33]  || landmarks[0];
  const rightEye = landmarks[263] || landmarks[1];
  const faceScale = Math.sqrt(
    (leftEye.x - rightEye.x) ** 2 + (leftEye.y - rightEye.y) ** 2
  );
  if (faceScale < 0.01) return 0;

  if (!_prevLandmarks) { _prevLandmarks = landmarks; return 0; }

  let totalDisp = 0;
  for (const idx of LANDMARKS.MOTION_REFS) {
    if (idx >= landmarks.length) continue;
    const dx = landmarks[idx].x - _prevLandmarks[idx].x;
    const dy = landmarks[idx].y - _prevLandmarks[idx].y;
    totalDisp += Math.sqrt(dx * dx + dy * dy);
  }
  const meanDisp = totalDisp / LANDMARKS.MOTION_REFS.length;
  const rawScore = Math.min(1, meanDisp / (faceScale * 0.05));

  _motionSmooth = MOTION_ALPHA * rawScore + (1 - MOTION_ALPHA) * _motionSmooth;
  _prevLandmarks = landmarks;
  return _motionSmooth;
}

function resetMotionDetector() { _prevLandmarks = null; _motionSmooth = 0; }

/* ══════════════════════════════════════════════════════════
   OVERLAY RENDERING
   ══════════════════════════════════════════════════════════ */
function drawROIOverlay(ctx, landmarks, videoW, videoH, isScanning, motionScore) {
  ctx.clearRect(0, 0, videoW, videoH);
  if (!landmarks || landmarks.length === 0) return;

  const lm       = landmarks;
  const motion   = motionScore || 0;
  const stability = 1 - Math.min(1, motion);
  const rVal = Math.round(motion * 255);
  const gVal = Math.round(212 * stability);
  const meshColor = `rgba(${rVal},${gVal},${Math.round(170 * stability)},${0.25 + 0.2 * stability})`;
  const roiColor  = `rgba(${rVal},${gVal},${Math.round(170 * stability)},0.85)`;
  const roiFill   = `rgba(${rVal},${gVal},${Math.round(170 * stability)},0.18)`;

  // Jawline
  const JAWLINE = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
  ctx.beginPath();
  ctx.strokeStyle = meshColor;
  ctx.lineWidth   = 1.2;
  for (let i = 0; i < JAWLINE.length; i++) {
    if (JAWLINE[i] >= lm.length) continue;
    const { x, y } = lm[JAWLINE[i]];
    if (i === 0) ctx.moveTo(x * videoW, y * videoH);
    else         ctx.lineTo(x * videoW, y * videoH);
  }
  ctx.closePath();
  ctx.stroke();

  // ROI patches
  const patches = [
    { points: LANDMARKS.FOREHEAD,    label: 'Forehead', fill: 'rgba(124,131,253,0.18)', stroke: '#7c83fd' },
    { points: LANDMARKS.LEFT_CHEEK,  label: 'L.Cheek',  fill: roiFill, stroke: roiColor },
    { points: LANDMARKS.RIGHT_CHEEK, label: 'R.Cheek',  fill: roiFill, stroke: roiColor },
  ];

  for (const patch of patches) {
    const valid = patch.points.filter(i => i < lm.length);
    if (valid.length < 3) continue;

    ctx.beginPath();
    for (let i = 0; i < valid.length; i++) {
      const { x, y } = lm[valid[i]];
      if (i === 0) ctx.moveTo(x * videoW, y * videoH);
      else         ctx.lineTo(x * videoW, y * videoH);
    }
    ctx.closePath();
    ctx.fillStyle   = patch.fill;
    ctx.fill();
    ctx.strokeStyle = patch.stroke;
    ctx.lineWidth   = isScanning ? (1.5 + stability * 0.5) : 1;
    ctx.stroke();

    if (isScanning) {
      const cx = valid.reduce((s, i) => s + lm[i].x, 0) / valid.length * videoW;
      const cy = valid.reduce((s, i) => s + lm[i].y, 0) / valid.length * videoH;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = 'bold 9px Segoe UI';
      ctx.textAlign = 'center';
      ctx.fillText(patch.label, cx, cy);
    }
  }

  // Pulse ring
  if (isScanning) {
    const noseTip = lm[4];
    if (noseTip) {
      const cx     = noseTip.x * videoW;
      const cy     = noseTip.y * videoH;
      const radius = Math.abs((lm[10]?.y || 0.2) - (lm[152]?.y || 0.8)) * videoH * 0.72;
      const pulse  = 0.3 + 0.2 * Math.sin(Date.now() / 300);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rVal},${gVal},${Math.round(170*stability)},${pulse})`;
      ctx.lineWidth   = 2;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawMotionBadge(ctx, videoW, videoH, motion, isScanning);
}

function drawMotionBadge(ctx, vw, vh, motion, isScanning) {
  const x = vw - 14, y = 14, r = 8;
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fillStyle = motion > 0.25 ? 'rgba(255,77,109,0.3)' : 'rgba(6,214,160,0.2)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = motion > 0.25 ? '#ff4d6d' : '#06d6a0';
  ctx.fill();
  ctx.fillStyle = 'white';
  ctx.font = '10px Segoe UI';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(motion > 0.25 ? '!' : '✓', x, y + 1);
  ctx.textBaseline = 'alphabetic';
  if (motion > 0.25 && isScanning) {
    ctx.fillStyle = 'rgba(255,77,109,0.9)';
    ctx.font = 'bold 12px Segoe UI';
    ctx.textAlign = 'center';
    ctx.fillText('⚠ Hold Still', vw / 2, vh - 22);
  }
}

/* ══════════════════════════════════════════════════════════
   PIXEL EXTRACTION — with quality filtering
   ══════════════════════════════════════════════════════════
   Accepts pixels that are:
     • Not too dark  (R+G+B > PIX_MIN_SUM)
     • Not saturated (R < PIX_SAT_MAX, G < PIX_SAT_MAX)
     • Skin-tone plausible (R dominant, warm hue)

   The thresholds are adaptive: in dim conditions (meanBrightness < 80)
   we relax PIX_MIN_SUM so we don't reject every pixel.

   Returns { r, g, b, pixelCount, qualityScore, rejectedPct }
*/
function extractROIPixels(imageData, landmarks, videoW, videoH, cameraQuality) {
  if (!landmarks || landmarks.length === 0) return null;

  const data = imageData.data;

  // Adaptive thresholds based on camera brightness and diverse skin tones
  const isDim       = cameraQuality?.grade === 'dim' || (cameraQuality?.meanBrightness || 100) < 90;
  const pixMinSum   = isDim ? 30 : 55;     // relaxed for indoor and lower-lit environments
  const pixSatMax   = cameraQuality?.grade === 'bright' ? 225 : 248;
  const skinRMin    = isDim ? 25 : 38;

  let totalR = 0, totalG = 0, totalB = 0, count = 0, rejected = 0;

  const patches = [
    LANDMARKS.FOREHEAD,
    LANDMARKS.LEFT_CHEEK,
    LANDMARKS.RIGHT_CHEEK,
  ];

  for (const patchIndices of patches) {
    const valid = patchIndices.filter(i => i < landmarks.length);
    if (valid.length < 3) continue;

    const poly = valid.map(i => ({
      x: Math.round(landmarks[i].x * videoW),
      y: Math.round(landmarks[i].y * videoH),
    }));

    const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
    const x0 = Math.max(0, Math.min(...xs));
    const x1 = Math.min(videoW - 1, Math.max(...xs));
    const y0 = Math.max(0, Math.min(...ys));
    const y1 = Math.min(videoH - 1, Math.max(...ys));

    for (let py = y0; py <= y1; py++) {
      const intersections = scanLineIntersections(poly, py);
      if (intersections.length < 2) continue;
      intersections.sort((a, b) => a - b);

      for (let k = 0; k < intersections.length - 1; k += 2) {
        const xStart = Math.max(x0, Math.round(intersections[k]));
        const xEnd   = Math.min(x1, Math.round(intersections[k + 1]));
        for (let px = xStart; px <= xEnd; px++) {
          const idx = (py * videoW + px) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2];

          // Quality gate — inclusive of Fitzpatrick skin types I–VI
          if (r + g + b < pixMinSum) { rejected++; continue; }
          if (r > pixSatMax || g > pixSatMax) { rejected++; continue; }
          if (r < skinRMin) { rejected++; continue; }
          // Relaxed blue rejection: allow higher blue ratios under cool/fluorescent or darker skin lighting
          if (b > r * 1.15)  { rejected++; continue; }

          totalR += r; totalG += g; totalB += b;
          count++;
        }
      }
    }
  }

  const total = count + rejected;
  if (count < 20) return null;  // relaxed threshold for robust signal collection

  return {
    r: totalR / count,
    g: totalG / count,
    b: totalB / count,
    pixelCount:   count,
    qualityScore: total > 0 ? count / total : 0,
    rejectedPct:  total > 0 ? Math.round(rejected / total * 100) : 0,
  };
}

function scanLineIntersections(poly, y) {
  const intersections = [];
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = poly[i].y, yj = poly[j].y;
    const xi = poly[i].x, xj = poly[j].x;
    if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
      intersections.push(xi + (y - yi) / (yj - yi) * (xj - xi));
    }
  }
  return intersections;
}

// Export
window.ROIEngine = {
  LANDMARKS,
  drawROIOverlay,
  extractROIPixels,
  computeMotionScore,
  resetMotionDetector,
  analyzeFrameQuality,
};
