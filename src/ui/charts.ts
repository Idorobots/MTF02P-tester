import Chart from 'chart.js/auto';
import type { ChartDataset, ChartOptions } from 'chart.js';
import type { MicolinkFrame } from '../protocol/types.ts';

const TEXT = '#8a94a6';
const GRID = 'rgba(148, 163, 184, 0.08)';
const WINDOW_S = 60;
/** Display every Nth frame: 50 Hz input -> 10 Hz on the chart. */
const DECIMATE = 5;

interface Point {
  x: number;
  y: number;
}

type LineChart = Chart<'line', Point[], string>;

function dataset(label: string, color: string, yAxisID = 'y'): ChartDataset<'line', Point[]> {
  return {
    label,
    data: [],
    borderColor: color,
    backgroundColor: color,
    borderWidth: 1.5,
    pointRadius: 0,
    pointHoverRadius: 3,
    tension: 0.25,
    yAxisID,
  };
}

function lineOpts(xTitle: string, yTitle: string, extra?: (o: ChartOptions<'line'>) => void): ChartOptions<'line'> {
  const opts: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    scales: {
      x: {
        type: 'linear',
        title: { display: true, text: xTitle, color: TEXT, font: { size: 10 } },
        grid: { color: GRID },
        border: { color: GRID },
        ticks: { color: TEXT, maxTicksLimit: 8, font: { size: 10 }, maxRotation: 0 },
      },
      y: {
        title: { display: true, text: yTitle, color: TEXT, font: { size: 10 } },
        grid: { color: GRID },
        border: { color: GRID },
        ticks: { color: TEXT, maxTicksLimit: 6, font: { size: 10 } },
      },
    },
    plugins: {
      legend: {
        labels: { color: '#c6cfdd', boxWidth: 8, boxHeight: 8, usePointStyle: true, font: { size: 11 } },
      },
      tooltip: {
        backgroundColor: '#161b26',
        borderColor: '#263041',
        borderWidth: 1,
        titleColor: '#e6eaf2',
        bodyColor: '#aeb8c8',
      },
    },
  };
  extra?.(opts);
  return opts;
}

function pushPoint(chart: LineChart, dsIndex: number, p: Point): void {
  const data = chart.data.datasets[dsIndex].data as Point[];
  data.push(p);
  while (data.length > 0 && data[0].x < p.x - WINDOW_S) {
    data.shift();
  }
}

export class ChartsManager {
  private frameIndex = 0;
  private readonly alt: LineChart;
  private readonly flow: LineChart;
  private readonly quality: LineChart;

  constructor(altCanvas: HTMLCanvasElement, flowCanvas: HTMLCanvasElement, qualityCanvas: HTMLCanvasElement) {
    this.alt = new Chart(altCanvas, {
      type: 'line',
      data: { datasets: [dataset('Altitude (m)', '#22d3ee')] },
      options: lineOpts('session time (s)', 'altitude (m)', (o) => {
        (o.scales!.y as unknown as Record<string, unknown>).beginAtZero = true;
      }),
    });

    this.flow = new Chart(flowCanvas, {
      type: 'line',
      data: {
        datasets: [dataset('Flow X (raw)', '#a78bfa'), dataset('Flow Y (raw)', '#f472b6')],
      },
      options: lineOpts('session time (s)', 'flow / motion (raw)'),
    });

    this.quality = new Chart(qualityCanvas, {
      type: 'line',
      data: {
        datasets: [
          dataset('Flow quality (%)', '#34d399'),
          dataset('ToF strength (0-255)', '#fbbf24', 'y1'),
        ],
      },
      options: lineOpts('session time (s)', 'flow quality (%)', (o) => {
        o.scales!.y!.min = 0;
        o.scales!.y!.max = 100;
        (o.scales as Record<string, unknown>)['y1'] = {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 255,
          grid: { drawOnChartArea: false },
          border: { color: GRID },
          title: { display: true, text: 'ToF strength', color: TEXT, font: { size: 10 } },
          ticks: { color: TEXT, maxTicksLimit: 6, font: { size: 10 } },
        };
      }),
    });
  }

  /** Feed every frame; internally decimates to keep charts light. */
  push(f: MicolinkFrame, sessionT: number): void {
    this.frameIndex++;
    if (this.frameIndex % DECIMATE !== 0) return;
    pushPoint(this.alt, 0, { x: sessionT, y: f.distanceMm > 0 ? f.distanceMm / 1000 : NaN });
    pushPoint(this.flow, 0, { x: sessionT, y: f.flowVelX });
    pushPoint(this.flow, 1, { x: sessionT, y: f.flowVelY });
    pushPoint(this.quality, 0, { x: sessionT, y: f.flowQuality });
    pushPoint(this.quality, 1, { x: sessionT, y: f.strength });
  }

  update(): void {
    this.alt.update('none');
    this.flow.update('none');
    this.quality.update('none');
  }

  reset(): void {
    this.frameIndex = 0;
    for (const chart of [this.alt, this.flow, this.quality]) {
      for (const ds of chart.data.datasets) {
        (ds.data as Point[]).length = 0;
      }
      chart.update('none');
    }
  }
}