/**
 * Top-down "XY scope" that draws the integrated position trail of the sensor.
 * Coordinates are in cm; the view auto-scales to the furthest visited point.
 */
interface Pt {
  x: number;
  y: number;
}

const TRAIL_CAP = 2400;
const GRID_COLOR = '#1a2130';
const AXIS_COLOR = '#2a3344';
const LABEL_COLOR = '#5b6478';

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * pow) return m * pow;
  }
  return 10 * pow;
}

export class PositionPlot {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private trail: Pt[] = [];
  private scaleCm = 10;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  add(x: number, y: number): void {
    this.trail.push({ x, y });
    if (this.trail.length > TRAIL_CAP) this.trail.shift();
  }

  reset(): void {
    this.trail = [];
    this.scaleCm = 10;
  }

  scaleLabel(): string {
    return `±${(this.scaleCm / 100).toFixed(2)} m`;
  }

  render(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let maxR = 0;
    for (const p of this.trail) {
      maxR = Math.max(maxR, Math.abs(p.x), Math.abs(p.y));
    }
    this.scaleCm = Math.max(10, niceStep(maxR * 1.15));

    const k = (Math.min(w, h) / 2) * 0.86 / this.scaleCm;
    const cx = w / 2;
    const cy = h / 2;
    const toPx = (x: number, y: number): [number, number] => [cx + x * k, cy - y * k];

    // grid
    const step = niceStep(this.scaleCm / 4);
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_COLOR;
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = LABEL_COLOR;
    const showMeters = step >= 100;
    for (let v = step; v <= this.scaleCm; v += step) {
      for (const sign of [-1, 1]) {
        const [x1, y1] = toPx(sign * v, sign * v);
        ctx.beginPath();
        ctx.moveTo(x1, 0);
        ctx.lineTo(x1, h);
        ctx.moveTo(0, y1);
        ctx.lineTo(w, y1);
        ctx.stroke();
        const label = showMeters ? `${(v / 100).toFixed(step % 100 === 0 ? 0 : 1)} m` : `${v} cm`;
        if (x1 > 30 && x1 < w - 30) ctx.fillText(label, x1 + 3, cy - 4);
        if (y1 > 24 && y1 < h - 10) ctx.fillText(label, cx + 5, y1 - 3);
      }
    }

    // center axes
    ctx.strokeStyle = AXIS_COLOR;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();

    // trail, older points fade out
    const n = this.trail.length;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 1; i < n; i++) {
      const a = Math.min(1, (i / n) + 0.06);
      const [x0, y0] = toPx(this.trail[i - 1].x, this.trail[i - 1].y);
      const [x1, y1] = toPx(this.trail[i].x, this.trail[i].y);
      ctx.strokeStyle = `rgba(34, 211, 238, ${a})`;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // current position
    if (n > 0) {
      const [hx, hy] = toPx(this.trail[n - 1].x, this.trail[n - 1].y);
      ctx.shadowColor = 'rgba(34, 211, 238, 0.9)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#e6fefd';
      ctx.beginPath();
      ctx.arc(hx, hy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}