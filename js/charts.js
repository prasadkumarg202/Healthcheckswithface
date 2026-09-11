/**
 * charts.js — Real-time Chart.js Visualisations  v2.0
 * ─────────────────────────────────────────────────────
 * IMPROVEMENTS:
 *   • BPM Trend chart — history of estimates, shows confidence band
 *   • Waveform chart now shows BOTH filtered signal + peak markers
 *   • Spectrum chart highlights harmonic bins (2×BPM, 0.5×BPM)
 */

'use strict';

const CHART_DEFAULTS = {
  animation:  false,
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend:  { display: false },
    tooltip: { enabled: false },
  },
};

const DISPLAY_WINDOW = 300;

const C = {
  green:   'rgba(0,212,170,1)',
  greenBg: 'rgba(0,212,170,0.12)',
  red:     'rgba(255,99,132,0.9)',
  redBg:   'rgba(255,99,132,0.1)',
  blue:    'rgba(124,131,253,0.9)',
  blueBg:  'rgba(124,131,253,0.1)',
  peak:    'rgba(255,183,3,0.9)',
  muted:   'rgba(255,255,255,0.06)',
  grid:    'rgba(255,255,255,0.04)',
  tickClr: 'rgba(255,255,255,0.28)',
};

const yScaleShared = {
  display: true,
  grid:    { color: C.grid, drawBorder: false },
  ticks:   { color: C.tickClr, font: { size: 9 }, maxTicksLimit: 4 },
};

/* ─────────────────────────────────────────────────────────
   1. WAVEFORM CHART
   ───────────────────────────────────────────────────────── */
let waveformChart = null;
let waveformData  = [];

function initWaveformChart() {
  const ctx = document.getElementById('waveformChart').getContext('2d');
  waveformChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels:   Array(DISPLAY_WINDOW).fill(''),
      datasets: [{
        data:            Array(DISPLAY_WINDOW).fill(null),
        borderColor:     C.green,
        backgroundColor: C.greenBg,
        borderWidth:     1.8,
        pointRadius:     0,
        fill:            true,
        tension:         0.4,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { display: false },
        y: { ...yScaleShared },
      },
    },
  });
}

function pushWaveformBatch(values) {
  for (const v of values) {
    if (!isFinite(v)) continue;
    waveformData.push(v);
    if (waveformData.length > DISPLAY_WINDOW) waveformData.shift();
  }
  waveformChart.data.datasets[0].data = [...waveformData];
  waveformChart.update('none');
}

/* ─────────────────────────────────────────────────────────
   2. FFT SPECTRUM CHART
   ───────────────────────────────────────────────────────── */
let spectrumChart = null;

function initSpectrumChart() {
  const ctx = document.getElementById('spectrumChart').getContext('2d');
  spectrumChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels:   [],
      datasets: [{
        data:            [],
        backgroundColor: [],
        borderWidth:     0,
        borderRadius:    2,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: {
          display: true,
          grid:  { display: false },
          ticks: {
            color: C.tickClr, font: { size: 9 }, maxTicksLimit: 10,
            callback: (val, idx) => {
              const f = parseFloat(spectrumChart?.data?.labels?.[idx] ?? '');
              if (isNaN(f)) return '';
              const rounded = Math.round(f * 2) / 2;
              return Math.abs(rounded - f) < 0.02 ? f.toFixed(1) : '';
            },
          },
        },
        y: { display: false },
      },
      barPercentage:      1.0,
      categoryPercentage: 1.0,
    },
  });
}

function updateSpectrumChart(mag, freqRes, binLow, binHigh, peakBin, bpm) {
  const labels = [], data = [], bgColors = [];

  // Harmonics to highlight (2× fundamental = 1st harmonic)
  const harmBin = bpm ? Math.round((bpm / 60 * 2) / freqRes) : -1;

  for (let b = binLow; b <= binHigh && b < mag.length; b++) {
    labels.push((b * freqRes).toFixed(2));
    data.push(mag[b]);
    const dist = Math.abs(b - peakBin);
    if (b === peakBin)       bgColors.push(C.peak);
    else if (dist <= 1)      bgColors.push('rgba(255,183,3,0.45)');
    else if (b === harmBin)  bgColors.push('rgba(124,131,253,0.7)');
    else                     bgColors.push(C.blue);
  }

  const ds = spectrumChart.data.datasets[0];
  spectrumChart.data.labels  = labels;
  ds.data            = data;
  ds.backgroundColor = bgColors;
  spectrumChart.update('none');
}

/* ─────────────────────────────────────────────────────────
   3. RGB CHANNEL CHART
   ───────────────────────────────────────────────────────── */
let rgbChart = null;
const rgbBufs = { r: [], g: [], b: [] };

function initRGBChart() {
  const ctx = document.getElementById('rgbChart').getContext('2d');
  rgbChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels:   Array(DISPLAY_WINDOW).fill(''),
      datasets: [
        { data: Array(DISPLAY_WINDOW).fill(null), borderColor: C.red,   backgroundColor: C.redBg,  borderWidth: 1.2, pointRadius: 0, fill: false, tension: 0.3, label: 'R' },
        { data: Array(DISPLAY_WINDOW).fill(null), borderColor: C.green, backgroundColor: C.greenBg,borderWidth: 1.2, pointRadius: 0, fill: false, tension: 0.3, label: 'G' },
        { data: Array(DISPLAY_WINDOW).fill(null), borderColor: C.blue,  backgroundColor: C.blueBg, borderWidth: 1.2, pointRadius: 0, fill: false, tension: 0.3, label: 'B' },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: {
          display: true, position: 'top',
          labels: { color: 'rgba(255,255,255,0.5)', font: { size: 9 }, boxWidth: 12, padding: 8 },
        },
        tooltip: { enabled: false },
      },
      scales: {
        x: { display: false },
        y: { ...yScaleShared },
      },
    },
  });
}

function pushRGBSample(r, g, b) {
  for (const [buf, val] of [[rgbBufs.r, r], [rgbBufs.g, g], [rgbBufs.b, b]]) {
    if (isFinite(val)) { buf.push(val); if (buf.length > DISPLAY_WINDOW) buf.shift(); }
  }
  rgbChart.data.datasets[0].data = [...rgbBufs.r];
  rgbChart.data.datasets[1].data = [...rgbBufs.g];
  rgbChart.data.datasets[2].data = [...rgbBufs.b];
  rgbChart.update('none');
}

/* ─────────────────────────────────────────────────────────
   4. BPM TREND CHART  (NEW)
   ─────────────────────────────────────────────────────────
   Shows the last N BPM estimates as a line, plus a ±5 BPM
   confidence band (shaded area around the line).
   Makes it visually clear whether the reading has stabilised.
*/
let trendChart    = null;
const trendBPMs   = [];
const TREND_LEN   = 40;

function initTrendChart() {
  const ctx = document.getElementById('trendChart').getContext('2d');
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels:   Array(TREND_LEN).fill(''),
      datasets: [
        {
          // Upper confidence band
          data:            Array(TREND_LEN).fill(null),
          borderColor:     'transparent',
          backgroundColor: 'rgba(0,212,170,0.10)',
          borderWidth:     0,
          pointRadius:     0,
          fill:            '+1',
          tension:         0.4,
          label:           'upper',
        },
        {
          // BPM line
          data:            Array(TREND_LEN).fill(null),
          borderColor:     C.green,
          backgroundColor: 'transparent',
          borderWidth:     2,
          pointRadius:     3,
          pointBackgroundColor: C.green,
          fill:            false,
          tension:         0.4,
          label:           'BPM',
        },
        {
          // Lower confidence band
          data:            Array(TREND_LEN).fill(null),
          borderColor:     'transparent',
          backgroundColor: 'rgba(0,212,170,0.10)',
          borderWidth:     0,
          pointRadius:     0,
          fill:            '-1',
          tension:         0.4,
          label:           'lower',
        },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: { display: false },
        y: {
          display:  true,
          min:      40,
          max:      180,
          grid:     { color: C.grid, drawBorder: false },
          ticks:    { color: C.tickClr, font: { size: 9 }, stepSize: 20 },
        },
      },
    },
  });
}

function pushTrendBPM(bpm) {
  if (!bpm || !isFinite(bpm)) return;
  const BAND = 4;  // ± BPM confidence band width
  trendBPMs.push(bpm);
  if (trendBPMs.length > TREND_LEN) trendBPMs.shift();

  const pad  = TREND_LEN - trendBPMs.length;
  const nulls = Array(pad).fill(null);

  trendChart.data.datasets[0].data = [...nulls, ...trendBPMs.map(v => v + BAND)];
  trendChart.data.datasets[1].data = [...nulls, ...trendBPMs];
  trendChart.data.datasets[2].data = [...nulls, ...trendBPMs.map(v => v - BAND)];
  trendChart.update('none');
}

/* ─────────────────────────────────────────────────────────
   RESET ALL CHARTS
   ───────────────────────────────────────────────────────── */
function resetCharts() {
  waveformData.length = 0;
  trendBPMs.length    = 0;
  rgbBufs.r.length = rgbBufs.g.length = rgbBufs.b.length = 0;

  const nullWave = Array(DISPLAY_WINDOW).fill(null);
  waveformChart.data.datasets[0].data = [...nullWave];
  rgbChart.data.datasets.forEach(ds => { ds.data = [...nullWave]; });

  const nullTrend = Array(TREND_LEN).fill(null);
  trendChart.data.datasets.forEach(ds => { ds.data = [...nullTrend]; });

  spectrumChart.data.labels = [];
  spectrumChart.data.datasets[0].data = [];

  [waveformChart, rgbChart, trendChart, spectrumChart].forEach(c => c.update('none'));
}

// Export
window.Charts = {
  initWaveformChart,
  initSpectrumChart,
  initRGBChart,
  initTrendChart,
  pushWaveformBatch,
  updateSpectrumChart,
  pushRGBSample,
  pushTrendBPM,
  resetCharts,
};
