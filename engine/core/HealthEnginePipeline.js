/**
 * core/HealthEnginePipeline.js
 * Master Orchestration Engine for Contactless Health-Data Extraction
 *
 * Edge-First: Coordinates FaceMesh tracking, multi-region ROI pixel extraction,
 * rPPG (CHROM/POS) & rBCG decomposition, DSP filtering, and biomarker regressors.
 *
 * Zero third-party cloud API dependencies.
 */

'use strict';

class HealthEnginePipeline {
  constructor(config = {}) {
    this.fs = config.fs || 30;
    this.windowDurationSec = config.windowDurationSec || 30;
    this.maxBufferSize = Math.round(this.fs * this.windowDurationSec);

    // Sub-modules
    this.rbcg = new RBCGExtractor(this.fs);
    
    // Internal Circular Buffers
    this.rBuf = [];
    this.gBuf = [];
    this.bBuf = [];
    this.timestamps = [];

    // State
    this.isMeasuring = false;
    this.frameCount = 0;
    this.latestBiomarkers = null;

    // Temporal smoothing
    this.smoothedBPM = null;
  }

  /**
   * Starts a new measurement session
   */
  start() {
    this.reset();
    this.isMeasuring = true;
  }

  /**
   * Resets all buffers and filters
   */
  reset() {
    this.rBuf = [];
    this.gBuf = [];
    this.bBuf = [];
    this.timestamps = [];
    this.frameCount = 0;
    this.rbcg.reset();
    this.latestBiomarkers = null;
    this.smoothedBPM = null;
  }

  /**
   * Ingests a video frame with detected facial landmarks
   * @param {ImageData} imageData Raw canvas pixel data
   * @param {Array<{x:number, y:number, z:number}>} landmarks MediaPipe 478/468 landmarks
   * @param {number} timestamp DOMHighResTimeStamp
   */
  ingestFrame(imageData, landmarks, timestamp) {
    if (!this.isMeasuring || !landmarks || landmarks.length < 200) {
      return null;
    }

    this.frameCount++;
    const vw = imageData.width;
    const vh = imageData.height;

    // 1. Remote Ballistocardiography (rBCG) Tracking
    this.rbcg.processFrame(landmarks, timestamp);

    // 2. ROI Pixel Extraction with Skin & Quality Filtering
    let rgb = null;
    if (typeof ROIEngine !== 'undefined') {
      rgb = ROIEngine.extractROIPixels(imageData, landmarks, vw, vh);
    } else {
      rgb = this.fallbackROIExtract(imageData, landmarks, vw, vh);
    }

    if (rgb && rgb.pixelCount > 40) {
      this.rBuf.push(rgb.r);
      this.gBuf.push(rgb.g);
      this.bBuf.push(rgb.b);
      this.timestamps.push(timestamp);

      if (this.rBuf.length > this.maxBufferSize) {
        this.rBuf.shift();
        this.gBuf.shift();
        this.bBuf.shift();
        this.timestamps.shift();
      }
    }

    // 3. Periodic Biomarker Extraction (Every 30 frames ~ 1 sec)
    if (this.rBuf.length >= Math.round(this.fs * 3.5) && this.frameCount % 15 === 0) {
      this.latestBiomarkers = this.deriveAllBiomarkers();
    }

    return {
      samplesCollected: this.rBuf.length,
      progressPercent: Math.min(100, Math.round((this.rBuf.length / this.maxBufferSize) * 100)),
      biomarkers: this.latestBiomarkers
    };
  }

  /**
   * Full Multimodal Derivation Pipeline
   */
  deriveAllBiomarkers() {
    const fs = this.fs;
    const r = Float64Array.from(this.rBuf);
    const g = Float64Array.from(this.gBuf);
    const b = Float64Array.from(this.bBuf);

    // 1. Multi-Channel Signal Decomposition (POS & CHROM)
    const { pos, chrom, selected } = RPPGExtractor.extractBestSignal(r, g, b, fs);
    const activePulse = selected === 'POS' ? pos : chrom;

    // 2. Filtering & Detrending (0.7 Hz - 3.8 Hz Bandpass)
    const detrended = DSPCore.detrend(activePulse, Math.round(fs * 2));
    const sos = [
      DSPCore.designBiquadBandpass(0.7, 3.8, fs),
      DSPCore.designBiquadBandpass(0.8, 3.5, fs)
    ];
    const filteredPulse = DSPCore.applySOSBandpass(detrended, sos);

    // 3. Heart Rate (Pulse Rate) & SNR
    const hrResult = VitalSignsEngine.estimateHeartRate(filteredPulse, fs);
    if (!hrResult) return null;

    // Weighted median / temporal smoothing
    if (this.smoothedBPM === null) this.smoothedBPM = hrResult.bpm;
    else this.smoothedBPM = Math.round((this.smoothedBPM * 0.7 + hrResult.bpm * 0.3) * 10) / 10;

    // 4. Heart Rate Variability (HRV)
    const hrv = VitalSignsEngine.computeHRV(filteredPulse, fs);

    // 5. Respiration Rate (Breathing Rate)
    const breathRate = VitalSignsEngine.estimateBreathingRate(activePulse, fs);

    // 6. Remote Ballistocardiography (rBCG) & Pulse Transit Time (PTT)
    const rbcgSignal = this.rbcg.getSignal();
    const pttMs = this.rbcg.computePulseTransitTime(filteredPulse, rbcgSignal);

    // 7. Blood Pressure Estimation (PTT elastance fusion)
    const bp = VitalSignsEngine.estimateBloodPressure(pttMs, this.smoothedBPM, hrv ? hrv.rmssd : null);

    // 8. Baevsky Stress Index
    const stress = VitalSignsEngine.computeBaevskyStressIndex(hrv);

    // 9. Machine Learning & Statistical Inference (ASCVD, Heart Age, RPP)
    const ascvd = BiomarkerRegressor.estimateASCVD10YearRisk(45, 'male', bp.meanArterialPressure, this.smoothedBPM, hrv ? hrv.rmssd : 30);
    const heartAge = BiomarkerRegressor.estimateHeartAge(45, bp.systolic, hrv ? hrv.rmssd : 30);
    const workload = BiomarkerRegressor.computeCardiacWorkload(bp.systolic, this.smoothedBPM);

    return {
      heartRate: {
        bpm: this.smoothedBPM,
        snrDb: hrResult.snr,
        confidence: hrResult.snr > 3 ? 'High' : 'Moderate'
      },
      hrv: hrv,
      respirationRate: breathRate,
      bloodPressure: bp,
      stress: stress,
      cardiacWorkload: workload,
      ascvdRisk: ascvd,
      heartAge: heartAge,
      signalDecomposition: selected
    };
  }

  /**
   * Fallback ROI pixel extractor if external roi.js is not loaded
   */
  fallbackROIExtract(imageData, landmarks, w, h) {
    const data = imageData.data;
    const cheekIdx = [117, 118, 50, 101, 347, 346, 280, 330];
    let totalR = 0, totalG = 0, totalB = 0, count = 0;

    for (let i = 0; i < cheekIdx.length; i++) {
      const lm = landmarks[cheekIdx[i]];
      if (!lm) continue;
      const px = Math.floor(lm.x * w);
      const py = Math.floor(lm.y * h);
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const idx = (py * w + px) * 4;
        totalR += data[idx];
        totalG += data[idx + 1];
        totalB += data[idx + 2];
        count++;
      }
    }
    return count > 0 ? { r: totalR / count, g: totalG / count, b: totalB / count, pixelCount: count } : null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HealthEnginePipeline;
} else if (typeof window !== 'undefined') {
  window.HealthEnginePipeline = HealthEnginePipeline;
}
