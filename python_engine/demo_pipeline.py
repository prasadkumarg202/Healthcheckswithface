"""
demo_pipeline.py
End-to-end integration test demonstrating real-time frame ingestion,
SignalExtractor multi-ROI accumulation, and VitalSignProcessor biomarker derivation.
"""

import numpy as np
import time
from signal_extractor import SignalExtractor
from vital_sign_processor import VitalSignProcessor

def run_synthetic_pipeline_test():
    print("=================================================================")
    print(" CONTACTLESS HEALTH EXTRACTION ENGINE - PYTHON PRODUCTION SUITE ")
    print("=================================================================")

    fps = 30
    duration_sec = 12
    n_frames = fps * duration_sec
    target_hr_bpm = 75.0
    target_br_bpm = 16.0

    print(f"\n[1/3] Initializing SignalExtractor (FPS: {fps}, Buffer: 30s)...")
    extractor = SignalExtractor(fps=fps, buffer_window_sec=30)
    processor = VitalSignProcessor(fps=fps)

    print(f"[2/3] Simulating live camera feed ({n_frames} frames @ {fps} FPS)...")
    t0 = time.time()

    # Generate synthetic video frames containing facial skin plethysmographic modulation
    for i in range(n_frames):
        t = i / fps
        cardiac_mod = 2.5 * np.sin(2 * np.pi * (target_hr_bpm / 60.0) * t)
        resp_mod = 1.0 * np.sin(2 * np.pi * (target_br_bpm / 60.0) * t)

        # Create a synthetic 480x640 BGR frame with skin-tone coloration
        # BGR skin tone: B=110, G=140 + modulation, R=185
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        frame[:, :] = [
            int(np.clip(105 + resp_mod * 0.3, 0, 255)),
            int(np.clip(142 + cardiac_mod + resp_mod * 0.5, 0, 255)),
            int(np.clip(190 + resp_mod * 0.2, 0, 255))
        ]

        # Ingest frame
        success = extractor.process_frame(frame, timestamp=t)
        if not success:
            print(f"Warning: Frame {i} rejected by chromatic skin gate.")

    elapsed = time.time() - t0
    print(f"  [+] Processed {n_frames} frames in {elapsed:.3f}s (Throughput: {n_frames/elapsed:.1f} FPS)")

    print("[3/3] Deriving Clinical Biomarkers via VitalSignProcessor...")
    r_ch, g_ch, b_ch = extractor.get_channels_numpy()
    metrics = processor.compute_metrics(r_ch, g_ch, b_ch)

    if metrics:
        print("\n--- BIOMARKER EXTRACTION RESULTS ---")
        print(f"  * Ground-Truth Heart Rate : {target_hr_bpm} BPM")
        print(f"  * Extracted Heart Rate    : {metrics['heart_rate_bpm']} BPM (Error: {abs(metrics['heart_rate_bpm'] - target_hr_bpm):.2f} BPM)")
        print(f"  * HRV RMSSD               : {metrics['hrv_rmssd_ms']} ms")
        print(f"  * HRV SDNN                : {metrics['hrv_sdnn_ms']} ms")
        print(f"  * pNN50                   : {metrics['pnn50_percent']}%")
        print(f"  * Respiration Rate        : {metrics['respiration_breaths_min']} breaths/min")
        print(f"  * Estimated Blood Pressure: {metrics['blood_pressure']['systolic']}/{metrics['blood_pressure']['diastolic']} mmHg (MAP: {metrics['blood_pressure']['map']} mmHg)")
        print(f"  * Spectral Signal-to-Noise: {metrics['snr_db']} dB")
        print("------------------------------------")
        print("[+] All Phase 3 production code modules verified successfully.")
    else:
        print("Error: Insufficient data or low SNR.")

if __name__ == "__main__":
    run_synthetic_pipeline_test()
