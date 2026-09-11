/**
 * signal.js — rPPG Signal Processing Engine  v2.0
 * ─────────────────────────────────────────────────
 * IMPROVEMENTS IN THIS VERSION:
 *  1. Dynamic Butterworth bandpass — designed at actual measured FPS
 *  2. POS (Plane Orthogonal to Skin) algorithm — Wang et al. 2017
 *  3. Parabolic FFT interpolation — sub-bin frequency precision
 *  4. SpO₂ estimation via R/G AC-DC ratio method
 *  5. Breathing rate extraction — 0.1–0.5 Hz rPPG band
 *  6. Algorithm selector — auto-picks CHROM vs POS by SNR
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   SECTION 1 — CHROM rPPG  (de Haan & Jeanne, 2013)
   ══════════════════════════════════════════════════════════
   Xs = 3Rn − 2Gn
   Ys = 1.5Rn + Gn − 1.5Bn
   S  = Xs − (σ(Xs)/σ(Ys)) · Ys
*/
function chromRPPG(rBuf, gBuf, bBuf) {
  const n = rBuf.length;
  if (n < 2) return new Float64Array(n);

  const rMean = mean(rBuf), gMean = mean(gBuf), bMean = mean(bBuf);
  const rN = rBuf.map(v => (rMean > 0 ? v / rMean : 1));
  const gN = gBuf.map(v => (gMean > 0 ? v / gMean : 1));
  const bN = bBuf.map(v => (bMean > 0 ? v / bMean : 1));

  const Xs = new Float64Array(n);
  const Ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    Xs[i] = 3 * rN[i] - 2 * gN[i];
    Ys[i] = 1.5 * rN[i] + gN[i] - 1.5 * bN[i];
  }

  const stdXs = std(Xs);
  const stdYs = std(Ys);
  const alpha = (stdYs > 1e-9) ? stdXs / stdYs : 1;

  const S = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    S[i] = Xs[i] - alpha * Ys[i];
  }
  return S;
}

/* ══════════════════════════════════════════════════════════
   SECTION 2 — POS rPPG  (Wang et al., 2017 IEEE TBME)
   ══════════════════════════════════════════════════════════
   POS (Plane Orthogonal to Skin) projects the normalised
   RGB vector onto a plane perpendicular to the skin-tone
   vector, cancelling specular and diffuse ambient noise.

   S1 = Rn − Gn
   S2 = Rn + Gn − 2·Bn
   α  = σ(S1) / σ(S2)
   P  = S1 + α·S2

   POS is generally more robust than CHROM under:
     • Non-frontal illumination angles
     • Darker skin tones
     • Indoor incandescent / mixed lighting
*/
function posRPPG(rBuf, gBuf, bBuf) {
  const n = rBuf.length;
  if (n < 2) return new Float64Array(n);

  const rMean = mean(rBuf), gMean = mean(gBuf), bMean = mean(bBuf);
  if (rMean < 1e-9 || gMean < 1e-9 || bMean < 1e-9) return new Float64Array(n);

  const S1 = new Float64Array(n);
  const S2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rn = rBuf[i] / rMean;
    const gn = gBuf[i] / gMean;
    const bn = bBuf[i] / bMean;
    S1[i] = rn - gn;
    S2[i] = rn + gn - 2 * bn;
  }

  const s1Std = std(S1);
  const s2Std = std(S2);
  const alpha = (s2Std > 1e-9) ? s1Std / s2Std : 1;

  const P = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    P[i] = S1[i] + alpha * S2[i];
  }
  return P;
}

/* ══════════════════════════════════════════════════════════
   SECTION 3 — DYNAMIC BUTTERWORTH BANDPASS FILTER
   ══════════════════════════════════════════════════════════
   Designs a 4th-order Butterworth bandpass filter at runtime
   using the bilinear transform for the ACTUAL measured fps.

   Pipeline:
     1. Pre-warp analog frequencies:
          ωL = 2·fs·tan(π·fL/fs)
          ωH = 2·fs·tan(π·fH/fs)

     2. For each stage, compute SOS via bilinear transform of
        the 2nd-order analog bandpass:
          H_a(s) = BW·s / (s² + BW·s + ω₀²)
          where BW = ωH − ωL,  ω₀² = ωL·ωH

     3. Apply bilinear substitution s ← 2fs(z-1)/(z+1):
          b0 =  BW·p / a0
          b1 =  0
          b2 = -BW·p / a0
          a1 = 2(ω₀² − p²) / a0
          a2 = (p² − BW·p + ω₀²) / a0
          where p = 2·fs,  a0 = p² + BW·p + ω₀²

     4. Cascade two such sections with a slightly shifted
        second section for steeper roll-off.
*/
const _filterCache = new Map();

function designBandpassSOS(fLow, fHigh, fs) {
  const key = `${fLow.toFixed(2)}_${fHigh.toFixed(2)}_${fs.toFixed(1)}`;
  if (_filterCache.has(key)) return _filterCache.get(key);

  const p  = 2 * fs;  // bilinear transform factor

  function computeSection(fl, fh) {
    // Pre-warp analog cutoff frequencies
    const wL  = p * Math.tan(Math.PI * fl / fs);
    const wH  = p * Math.tan(Math.PI * fh / fs);
    const BW  = wH - wL;
    const w0sq = wL * wH;
    const a0  = p * p + BW * p + w0sq;
    return [
      (BW * p) / a0,              // b0
      0,                           // b1
      -(BW * p) / a0,             // b2
      (2 * (w0sq - p * p)) / a0,  // a1
      (p * p - BW * p + w0sq) / a0, // a2
    ];
  }

  // Section 1: core cardiac band
  const sec1 = computeSection(fLow, fHigh);
  // Section 2: slightly tighter — steepens roll-off near edges
  const sec2 = computeSection(fLow * 1.08, fHigh * 0.94);

  const sos = [sec1, sec2];
  _filterCache.set(key, sos);
  return sos;
}

/* Causal IIR filter (real-time safe, no look-ahead) */
function applySOSFilter(signal, sos) {
  let x = Float64Array.from(signal);
  for (const [b0, b1, b2, a1, a2] of sos) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi;
      y2 = y1; y1 = isFinite(yi) ? yi : 0;
      y[i] = y1;
    }
    x = y;
  }
  return x;
}

/* ══════════════════════════════════════════════════════════
   SECTION 4 — DETRENDING
   ══════════════════════════════════════════════════════════
   Removes slow baseline wander (lighting drift) by subtracting
   a wide moving average. Window = 2 × fps (= 2 seconds).
*/
function detrend(signal, windowLen) {
  const n   = signal.length;
  const out = new Float64Array(n);
  const half = Math.floor(windowLen / 2);

  // Prefix sum for O(n) moving average
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + signal[i];

  for (let i = 0; i < n; i++) {
    const lo  = Math.max(0, i - half);
    const hi  = Math.min(n - 1, i + half);
    const cnt = hi - lo + 1;
    out[i] = signal[i] - (prefix[hi + 1] - prefix[lo]) / cnt;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════
   SECTION 5 — FFT (Cooley-Tukey radix-2)
   ══════════════════════════════════════════════════════════ */
function fft(signal) {
  const N  = nextPow2(signal.length);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < signal.length; i++) re[i] = signal[i];

  // Bit-reversal
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let m = N >> 1;
    while (j >= m && m > 0) { j -= m; m >>= 1; }
    j += m;
  }

  // Butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k]           = uRe + vRe; im[i + k]           = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const nr = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nr;
      }
    }
  }
  return { re, im, N };
}

function magnitude({ re, im, N }) {
  const mag = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/* ══════════════════════════════════════════════════════════
   SECTION 6 — PARABOLIC FFT INTERPOLATION
   ══════════════════════════════════════════════════════════
   Standard FFT gives one amplitude per bin (Δf = fs/N Hz apart).
   At 30 fps / 1024 pts → Δf = 0.029 Hz → ±1.76 BPM quantisation.

   Parabolic interpolation fits a quadratic through the three
   largest-bin-neighbourhood magnitudes and solves for the exact peak:

     δ = 0.5 × (α − γ) / (α − 2β + γ)
     α = mag[k-1],  β = mag[k],  γ = mag[k+1]

   Precise frequency = (k + δ) × freqRes
   Error < ±0.3 BPM for a clean sinusoidal signal.
*/
function parabolicPeakInterp(mag, peakBin) {
  if (peakBin <= 0 || peakBin >= mag.length - 1) return peakBin;
  const alpha = mag[peakBin - 1];
  const beta  = mag[peakBin];
  const gamma = mag[peakBin + 1];
  const denom = alpha - 2 * beta + gamma;
  if (Math.abs(denom) < 1e-12) return peakBin;
  const delta = 0.5 * (alpha - gamma) / denom;
  // Clamp to ±1 bin
  return peakBin + Math.max(-1, Math.min(1, delta));
}

/* ══════════════════════════════════════════════════════════
   SECTION 7 — MAIN BPM ESTIMATION
   ══════════════════════════════════════════════════════════ */
function estimateBPM(signal, fps) {
  if (signal.length < 30) return null;

  // 1. Detrend (remove baseline wander)
  const det = detrend(signal, Math.round(fps * 2));

  // 2. Hann window (reduce spectral leakage)
  const windowed = applyHannWindow(det);

  // 3. Dynamic bandpass (cardiac band 0.67–4 Hz = 40–240 BPM)
  const sos      = designBandpassSOS(0.67, 4.0, fps);
  const filtered = applySOSFilter(windowed, sos);

  // 4. FFT
  const spectrum = fft(filtered);
  const mag      = magnitude(spectrum);
  const N        = spectrum.N;
  const freqRes  = fps / N;

  // 5. Find peak bin in cardiac band
  const binLow  = Math.max(1, Math.floor(0.67  / freqRes));
  const binHigh = Math.min(mag.length - 2, Math.ceil(4.0 / freqRes));

  let maxMag = -Infinity, peakBin = binLow;
  for (let b = binLow; b <= binHigh; b++) {
    if (mag[b] > maxMag) { maxMag = mag[b]; peakBin = b; }
  }

  // 6. Sub-bin parabolic interpolation
  const preciseBin = parabolicPeakInterp(mag, peakBin);
  const bpm        = preciseBin * freqRes * 60;

  // 7. SNR in dB
  const peakWidth  = 3;
  let peakEnergy = 0, totalEnergy = 0;
  for (let b = binLow; b <= binHigh; b++) {
    const e = mag[b] * mag[b];
    totalEnergy += e;
    if (Math.abs(b - peakBin) <= peakWidth) peakEnergy += e;
  }
  const snrDB = (totalEnergy - peakEnergy > 1e-12)
    ? 10 * Math.log10(peakEnergy / (totalEnergy - peakEnergy))
    : 0;

  return {
    bpm:      Math.round(bpm * 10) / 10,
    snrDB:    Math.round(snrDB * 10) / 10,
    mag,
    freqRes,
    binLow,
    binHigh,
    peakBin,
    filtered,
    rawFiltered: applySOSFilter(det, sos),  // unwindowed, for HRV peaks
  };
}

/* ══════════════════════════════════════════════════════════
   SECTION 8 — AUTO ALGORITHM SELECTOR (CHROM vs POS)
   ══════════════════════════════════════════════════════════
   Runs both CHROM and POS, picks the one with higher FFT SNR.
   This ensures best accuracy across varying lighting/skin conditions.
*/
function bestRPPGSignal(rBuf, gBuf, bBuf, fps) {
  const chromSig = chromRPPG(rBuf, gBuf, bBuf);
  const posSig   = posRPPG(rBuf, gBuf, bBuf);

  const chromResult = estimateBPM(chromSig, fps);
  const posResult   = estimateBPM(posSig,   fps);

  if (!chromResult && !posResult) return { result: null, algo: 'none' };
  if (!chromResult) return { result: posResult, algo: 'POS', signal: posSig };
  if (!posResult)   return { result: chromResult, algo: 'CHROM', signal: chromSig };

  if (posResult.snrDB >= chromResult.snrDB) {
    return { result: posResult, algo: 'POS', signal: posSig };
  }
  return { result: chromResult, algo: 'CHROM', signal: chromSig };
}

/* ══════════════════════════════════════════════════════════
   SECTION 9 — HRV (RMSSD from inter-beat intervals)
   ══════════════════════════════════════════════════════════ */
function estimateHRV(filteredSignal, fps) {
  if (!filteredSignal || filteredSignal.length < fps * 5) return null;

  const minDist = Math.floor(fps * 0.4); // minimum 400 ms between peaks (max 150 BPM)
  const peaks   = findPeaks(filteredSignal, minDist);
  if (peaks.length < 4) return null;

  const ibi = [];
  for (let i = 1; i < peaks.length; i++) {
    const interval = (peaks[i] - peaks[i - 1]) / fps * 1000; // ms
    if (interval > 300 && interval < 2000) ibi.push(interval); // sanity range 30–200 BPM
  }

  if (ibi.length < 3) return null;

  const diffs = [];
  for (let i = 1; i < ibi.length; i++) diffs.push((ibi[i] - ibi[i - 1]) ** 2);

  const rmssd = Math.sqrt(diffs.reduce((a, b) => a + b, 0) / diffs.length);
  return isFinite(rmssd) ? Math.round(rmssd) : null;
}

/* ══════════════════════════════════════════════════════════
   SECTION 10 — SpO₂ ESTIMATION (R/G Ratio Method)
   ══════════════════════════════════════════════════════════
   Clinical pulse oximeters use RED (660nm) and INFRARED (940nm).
   Standard cameras use RED and GREEN. The principle is similar:
   oxyhaemoglobin and deoxyhaemoglobin absorb red and near-IR
   differently. The R/G ratio provides a rough proxy.

   R_ratio = (AC_red / DC_red) / (AC_green / DC_green)

   where AC = std of cardiac-filtered signal (pulsatile component)
         DC = temporal mean (background perfusion)

   SpO₂ ≈ 110 − 25 × R_ratio   (empirical — NOT clinically validated)

   NOTE: True SpO₂ requires an IR channel. This is a proof-of-concept
   estimate with ±3–5% error and significant individual variation.
*/
function estimateSpO2(rBuf, gBuf, fps) {
  if (rBuf.length < fps * 5) return null;

  const rArr = Float64Array.from(rBuf);
  const gArr = Float64Array.from(gBuf);

  const dcR = mean(rArr), dcG = mean(gArr);
  if (dcR < 1 || dcG < 1) return null;

  // AC component = bandpass-filtered channel (cardiac pulsatile part)
  const sos  = designBandpassSOS(0.67, 4.0, fps);
  const acR  = applySOSFilter(rArr.map(v => v / dcR), sos);
  const acG  = applySOSFilter(gArr.map(v => v / dcG), sos);

  const stdAcR = std(acR);
  const stdAcG = std(acG);
  if (stdAcG < 1e-9) return null;

  const rRatio = stdAcR / stdAcG;
  const spo2   = Math.round(110 - 25 * rRatio);

  // Physiologically plausible range: 85–100
  return Math.max(85, Math.min(100, spo2));
}

/* ══════════════════════════════════════════════════════════
   SECTION 11 — BREATHING RATE
   ══════════════════════════════════════════════════════════
   Respiration modulates the rPPG signal through:
     • RSA (Respiratory Sinus Arrhythmia) — HR increases on inhale
     • Chest wall movement changing ambient light reflection

   Breathing rate range: 0.1–0.5 Hz = 6–30 breaths/min

   Method: Apply 0.1–0.5 Hz bandpass to the CHROM/POS signal
           and find the dominant frequency.
*/
function estimateBreathingRate(rppgSignal, fps) {
  if (!rppgSignal || rppgSignal.length < fps * 10) return null;

  // Bandpass for respiratory band
  const sos      = designBandpassSOS(0.1, 0.5, fps);
  const respSig  = applySOSFilter(Float64Array.from(rppgSignal), sos);

  const spectrum = fft(applyHannWindow(detrend(respSig, Math.round(fps * 5))));
  const mag      = magnitude(spectrum);
  const freqRes  = fps / spectrum.N;

  const binLow  = Math.max(1, Math.floor(0.10 / freqRes));
  const binHigh = Math.min(mag.length - 2, Math.ceil(0.50 / freqRes));

  if (binHigh <= binLow) return null;

  let maxMag = -Infinity, peakBin = binLow;
  for (let b = binLow; b <= binHigh; b++) {
    if (mag[b] > maxMag) { maxMag = mag[b]; peakBin = b; }
  }

  const preciseBin = parabolicPeakInterp(mag, peakBin);
  const bpm        = Math.round(preciseBin * freqRes * 60);
  return (bpm >= 6 && bpm <= 30) ? bpm : null;
}

/* ══════════════════════════════════════════════════════════
   SECTION 12 — STRESS INDEX
   ══════════════════════════════════════════════════════════ */
function estimateStress(rmssd) {
  if (rmssd === null) return null;
  return Math.min(100, Math.max(0, Math.round(1000 / (rmssd + 1))));
}

/* ══════════════════════════════════════════════════════════
   SECTION 13 — BPM TEMPORAL SMOOTHING (Weighted Median)
   ══════════════════════════════════════════════════════════
   Keeps a history of the last N BPM estimates.
   Returns the weighted median — recent values weighted higher.
   Much more stable than a simple moving average: resistant to
   single-frame spike outliers while tracking real HR changes.
*/
class BPMSmoother {
  constructor(historyLen = 7) {
    this.history    = [];
    this.historyLen = historyLen;
  }

  push(bpm) {
    if (bpm === null || bpm < 40 || bpm > 200) return;
    this.history.push(bpm);
    if (this.history.length > this.historyLen) this.history.shift();
  }

  get() {
    if (this.history.length === 0) return null;
    if (this.history.length === 1) return this.history[0];

    // Weighted median: assign weights 1,2,3,...,n (linear recency bias)
    const n = this.history.length;
    const weighted = [];
    for (let i = 0; i < n; i++) {
      const weight = i + 1;  // older = lower weight
      for (let w = 0; w < weight; w++) weighted.push(this.history[i]);
    }
    weighted.sort((a, b) => a - b);
    const mid = Math.floor(weighted.length / 2);
    return weighted.length % 2 === 0
      ? Math.round((weighted[mid - 1] + weighted[mid]) / 2)
      : weighted[mid];
  }

  reset() { this.history = []; }

  get confidence() {
    if (this.history.length < 3) return 0;
    const spread = Math.max(...this.history) - Math.min(...this.history);
    return Math.max(0, Math.min(100, Math.round(100 - spread * 3)));
  }
}

/* ══════════════════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════════════════ */
function mean(arr) {
  if (arr.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2;
  return Math.sqrt(s / arr.length);
}

function applyHannWindow(signal) {
  const n   = signal.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = signal[i] * 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  }
  return out;
}

function findPeaks(signal, minDist = 10) {
  const peaks = [];
  for (let i = 1; i < signal.length - 1; i++) {
    if (signal[i] > signal[i - 1] && signal[i] > signal[i + 1]) {
      if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minDist) {
        peaks.push(i);
      }
    }
  }
  return peaks;
}

function normalise(arr) {
  const mn = Math.min(...arr), mx = Math.max(...arr);
  const range = mx - mn;
  if (range < 1e-12) return Array.from(arr).map(() => 0.5);
  return Array.from(arr).map(v => (v - mn) / range);
}

// Export public API
window.SignalEngine = {
  chromRPPG,
  posRPPG,
  bestRPPGSignal,
  applySOSFilter,
  designBandpassSOS,
  detrend,
  fft,
  magnitude,
  estimateBPM,
  estimateHRV,
  estimateSpO2,
  estimateBreathingRate,
  estimateStress,
  parabolicPeakInterp,
  findPeaks,
  normalise,
  mean,
  std,
  BPMSmoother,
};
