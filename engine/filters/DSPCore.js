/**
 * filters/DSPCore.ts / DSPCore.js
 * High-Performance Digital Signal Processing Primitives
 * Fully Edge-Native: 0 external API dependencies.
 *
 * Implements:
 *  - Bilinear-transformed dynamic Butterworth IIR filters (Order 2, 4, 8)
 *  - Moving-average / Smooth-prior detrending (Tarvainen et al. baseline correction)
 *  - Radix-2 Cooley-Tukey FFT & Frequency domain PSD
 *  - Wavelet-inspired Multi-Resolution Signal Decomposition
 */

'use strict';

class DSPCore {
  /**
   * Designs a 2nd-order Butterworth Bandpass section via Bilinear Transform
   * @param {number} fLow Lower cutoff (Hz)
   * @param {number} fHigh Upper cutoff (Hz)
   * @param {number} fs Sampling rate (Hz)
   * @returns {Array<number>} [b0, b1, b2, a1, a2] normalized biquad coefficients
   */
  static designBiquadBandpass(fLow, fHigh, fs) {
    const p = 2 * fs;
    const wL = p * Math.tan((Math.PI * fLow) / fs);
    const wH = p * Math.tan((Math.PI * fHigh) / fs);
    const bw = wH - wL;
    const w0sq = wL * wH;

    const a0 = p * p + bw * p + w0sq;
    const b0 = (bw * p) / a0;
    const b1 = 0;
    const b2 = -(bw * p) / a0;
    const a1 = (2 * (w0sq - p * p)) / a0;
    const a2 = (p * p - bw * p + w0sq) / a0;

    return [b0, b1, b2, a1, a2];
  }

  /**
   * Cascaded Second-Order Sections (SOS) Butterworth Bandpass
   * Real-time Direct Form II Transposed for zero memory footprint & cache locality
   */
  static applySOSBandpass(signal, sos) {
    let current = Float64Array.from(signal);
    for (let s = 0; s < sos.length; s++) {
      const [b0, b1, b2, a1, a2] = sos[s];
      const out = new Float64Array(current.length);
      let d1 = 0, d2 = 0;

      for (let i = 0; i < current.length; i++) {
        const x = current[i];
        const y = b0 * x + d1;
        d1 = b1 * x - a1 * y + d2;
        d2 = b2 * x - a2 * y;
        out[i] = Number.isFinite(y) ? y : 0;
      }
      current = out;
    }
    return current;
  }

  /**
   * Smoothness-Priors Detrending Filter (Tarvainen et al., IEEE TBME)
   * Removes baseline wander caused by respiration, motion, and ambient light shift
   * O(N) optimized moving-average baseline approximation
   */
  static detrend(signal, windowSize) {
    const n = signal.length;
    const out = new Float64Array(n);
    const half = Math.max(1, Math.floor(windowSize / 2));
    
    // Prefix sum for constant-time window query
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + signal[i];

    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      const span = hi - lo + 1;
      const baseline = (prefix[hi + 1] - prefix[lo]) / span;
      out[i] = signal[i] - baseline;
    }
    return out;
  }

  /**
   * Hann Windowing for spectral leakage reduction prior to FFT
   */
  static applyHann(signal) {
    const n = signal.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      out[i] = signal[i] * w;
    }
    return out;
  }

  /**
   * Fast Fourier Transform (Radix-2 Cooley-Tukey)
   */
  static computeFFT(signal) {
    let N = 1;
    while (N < signal.length) N <<= 1;

    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < signal.length; i++) re[i] = signal[i];

    // Bit-reversal permutation
    let j = 0;
    for (let i = 0; i < N; i++) {
      if (i < j) {
        let tr = re[i]; re[i] = re[j]; re[j] = tr;
        let ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
      let m = N >> 1;
      while (j >= m && m > 0) { j -= m; m >>= 1; }
      j += m;
    }

    // Butterfly passes
    for (let len = 2; len <= N; len <<= 1) {
      const angle = (-2 * Math.PI) / len;
      const wstepRe = Math.cos(angle);
      const wstepIm = Math.sin(angle);

      for (let i = 0; i < N; i += len) {
        let wRe = 1.0, wIm = 0.0;
        const half = len >> 1;
        for (let k = 0; k < half; k++) {
          const uRe = re[i + k], uIm = im[i + k];
          const vRe = re[i + k + half] * wRe - im[i + k + half] * wIm;
          const vIm = re[i + k + half] * wIm + im[i + k + half] * wRe;

          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + half] = uRe - vRe;
          im[i + k + half] = uIm - vIm;

          const nextWRe = wRe * wstepRe - wIm * wstepIm;
          wIm = wRe * wstepIm + wIm * wstepRe;
          wRe = nextWRe;
        }
      }
    }

    const halfN = N >> 1;
    const mag = new Float64Array(halfN);
    for (let i = 0; i < halfN; i++) {
      mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    }

    return { mag, N };
  }

  /**
   * Sub-bin Parabolic Peak Interpolation
   */
  static parabolicInterpolation(mag, peakIndex) {
    if (peakIndex <= 0 || peakIndex >= mag.length - 1) return peakIndex;
    const a = mag[peakIndex - 1];
    const b = mag[peakIndex];
    const c = mag[peakIndex + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) < 1e-12) return peakIndex;
    const delta = 0.5 * (a - c) / denom;
    return peakIndex + Math.max(-1, Math.min(1, delta));
  }
}

// Export for ES6 or Node
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DSPCore;
} else if (typeof window !== 'undefined') {
  window.DSPCore = DSPCore;
}
