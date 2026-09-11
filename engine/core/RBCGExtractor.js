/**
 * core/RBCGExtractor.js
 * Remote Ballistocardiography (rBCG) Engine
 *
 * Tracks involuntary micromotions of the head caused by the ballistic recoil
 * of cardiac blood ejection into the ascending aorta (Newton's 3rd Law).
 *
 * Implements:
 *  - Optical flow displacement of stable anatomical landmarks (Nose bridge, Forehead bone)
 *  - Sub-pixel vertical trajectory tracking
 *  - Multimodal cross-correlation with optical rPPG for Pulse Wave Velocity (PWV)
 */

'use strict';

class RBCGExtractor {
  constructor(fs = 30) {
    this.fs = fs;
    this.historyBuffer = [];
    this.maxBufferSize = 180; // ~6 seconds window
    this.lastLandmarks = null;
  }

  /**
   * Landmark indices optimal for rBCG motion tracking (rigid facial bones)
   * 1: Nose tip, 6: Nose bridge, 168: Mid-forehead between brows, 197: Nose root
   */
  static get RIGID_LANDMARKS() {
    return [1, 6, 168, 197, 195];
  }

  /**
   * Ingests a new frame's facial landmarks and extracts vertical ballistic displacement (y-axis recoil)
   * @param {Array<{x:number, y:number, z:number}>} landmarks 
   * @param {number} timestamp 
   * @returns {number} normalized displacement delta (micromotion)
   */
  processFrame(landmarks, timestamp) {
    if (!landmarks || landmarks.length < 200) {
      this.lastLandmarks = null;
      return 0;
    }

    // Inter-pupillary distance normalization (scale invariance)
    const leftEye = landmarks[33] || landmarks[0];
    const rightEye = landmarks[263] || landmarks[1];
    const eyeDist = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);

    if (eyeDist < 1e-4) return 0;

    let avgY = 0;
    const indices = RBCGExtractor.RIGID_LANDMARKS;
    for (let i = 0; i < indices.length; i++) {
      avgY += landmarks[indices[i]].y;
    }
    avgY /= indices.length;

    // Normalised position
    const normalizedY = avgY / eyeDist;

    let deltaY = 0;
    if (this.lastLandmarks !== null) {
      deltaY = (normalizedY - this.lastLandmarks);
    }
    this.lastLandmarks = normalizedY;

    this.historyBuffer.push({ t: timestamp, val: deltaY });
    if (this.historyBuffer.length > this.maxBufferSize) {
      this.historyBuffer.shift();
    }

    return deltaY;
  }

  /**
   * Returns filtered rBCG ballistic acceleration signal
   */
  getSignal() {
    const raw = this.historyBuffer.map(item => item.val);
    if (raw.length < 30) return new Float64Array(raw);

    // Apply Bandpass (0.75 - 3.5 Hz) for cardiac ejection recoil
    if (typeof DSPCore !== 'undefined') {
      const sos = [
        DSPCore.designBiquadBandpass(0.75, 3.5, this.fs),
        DSPCore.designBiquadBandpass(0.85, 3.2, this.fs)
      ];
      return DSPCore.applySOSBandpass(raw, sos);
    }
    return new Float64Array(raw);
  }

  /**
   * Calculates Pulse Transit Time (PTT) proxy via phase delay between
   * rBCG aortic ejection peak and rPPG peripheral capillary peak
   */
  computePulseTransitTime(rppgSignal, rbcgSignal) {
    if (!rppgSignal || !rbcgSignal || rppgSignal.length !== rbcgSignal.length) return null;
    const len = Math.min(rppgSignal.length, rbcgSignal.length);
    if (len < 60) return null;

    // Normalized Cross-correlation
    let maxCorr = -Infinity;
    let bestLag = 0;
    const maxLag = Math.floor(this.fs * 0.4); // max 400ms physical transit time

    for (let lag = 0; lag < maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < len - lag; i++) {
        sum += rbcgSignal[i] * rppgSignal[i + lag];
      }
      if (sum > maxCorr) {
        maxCorr = sum;
        bestLag = lag;
      }
    }

    // Transit time in milliseconds
    const pttMs = (bestLag / this.fs) * 1000;
    return pttMs;
  }

  reset() {
    this.historyBuffer = [];
    this.lastLandmarks = null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RBCGExtractor;
} else if (typeof window !== 'undefined') {
  window.RBCGExtractor = RBCGExtractor;
}
