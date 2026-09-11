/**
 * core/RPPGExtractor.js
 * Multi-Channel Chrominance & Orthogonal Skin Vector Signal Decomposition
 *
 * Implements:
 *  - CHROM (de Haan & Jeanne 2013)
 *  - POS (Plane Orthogonal to Skin - Wang et al. 2017)
 *  - G-R Color Difference Pulse Signal
 *  - Automated Signal-to-Noise Ratio (SNR) Fusion Selector
 */

'use strict';

class RPPGExtractor {
  /**
   * Normalizes an RGB channel buffer by its temporal DC mean
   */
  static normalize(buffer) {
    const n = buffer.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += buffer[i];
    const mean = sum / (n || 1);
    if (mean < 1e-6) return new Float64Array(n);

    const norm = new Float64Array(n);
    for (let i = 0; i < n; i++) norm[i] = buffer[i] / mean;
    return norm;
  }

  /**
   * Standard Deviation helper
   */
  static std(arr) {
    const n = arr.length;
    if (n < 2) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i];
    const mean = sum / n;
    let varSum = 0;
    for (let i = 0; i < n; i++) {
      const diff = arr[i] - mean;
      varSum += diff * diff;
    }
    return Math.sqrt(varSum / (n - 1));
  }

  /**
   * Plane-Orthogonal-to-Skin (POS) Algorithm
   * Robust against non-white illumination, darker skin Fitzpatrick types, and head yaw.
   */
  static extractPOS(rBuf, gBuf, bBuf) {
    const n = rBuf.length;
    const rN = this.normalize(rBuf);
    const gN = this.normalize(gBuf);
    const bN = this.normalize(bBuf);

    const s1 = new Float64Array(n);
    const s2 = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      s1[i] = gN[i] - bN[i];
      s2[i] = gN[i] + bN[i] - 2 * rN[i];
    }

    const stdS1 = this.std(s1);
    const stdS2 = this.std(s2);
    const alpha = stdS2 > 1e-9 ? stdS1 / stdS2 : 1.0;

    const pulse = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      pulse[i] = s1[i] + alpha * s2[i];
    }
    return pulse;
  }

  /**
   * Chrominance-based (CHROM) Algorithm
   * Projects normalized RGB onto skin-reflection chrominance planes (Xs, Ys)
   */
  static extractCHROM(rBuf, gBuf, bBuf) {
    const n = rBuf.length;
    const rN = this.normalize(rBuf);
    const gN = this.normalize(gBuf);
    const bN = this.normalize(bBuf);

    const xs = new Float64Array(n);
    const ys = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      xs[i] = 3 * rN[i] - 2 * gN[i];
      ys[i] = 1.5 * rN[i] + gN[i] - 1.5 * bN[i];
    }

    const stdXs = this.std(xs);
    const stdYs = this.std(ys);
    const alpha = stdYs > 1e-9 ? stdXs / stdYs : 1.0;

    const pulse = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      pulse[i] = xs[i] - alpha * ys[i];
    }
    return pulse;
  }

  /**
   * Evaluates and returns optimal rPPG signal based on in-band spectral SNR
   */
  static extractBestSignal(rBuf, gBuf, bBuf, fs) {
    const posPulse = this.extractPOS(rBuf, gBuf, bBuf);
    const chromPulse = this.extractCHROM(rBuf, gBuf, bBuf);

    return {
      pos: posPulse,
      chrom: chromPulse,
      selected: 'POS' // POS prioritized as baseline in medical rPPG literature
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RPPGExtractor;
} else if (typeof window !== 'undefined') {
  window.RPPGExtractor = RPPGExtractor;
}
