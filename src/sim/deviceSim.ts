/**
 * Simulated MTF-02P: builds real Micolink byte frames and feeds them through
 * the same parser path as the serial source, so the whole app can be exercised
 * without hardware.
 *
 * Behaviour: ~0.85 m altitude with slow drift, gentle sway, a scripted slide
 * every 15 s, occasional ToF dropouts and a realistic quality signal.
 */
export interface SimInfo {
  usbVendorId: number;
  usbProductId: number;
}

export interface SimCallbacks {
  onChunk: (data: Uint8Array) => void;
  onOpen: (info: SimInfo) => void;
  onClose: (error?: string) => void;
}

export interface FrameParts {
  seq: number;
  timeMs: number;
  distanceMm: number;
  strength: number;
  precision: number;
  disStatus: number;
  flowVelX: number;
  flowVelY: number;
  flowQuality: number;
  flowStatus: number;
  devId?: number;
  sysId?: number;
}

const HEAD = 0xef;
const MSG_RANGE_SENSOR = 0x51;
const PAYLOAD_LEN = 20;
/** head + dev + sys + msg + seq + len + payload */
const FRAME_LEN = PAYLOAD_LEN + 7;
const CHECKSUM_SPAN = PAYLOAD_LEN + 6;

export function buildMicolinkFrame(p: FrameParts): Uint8Array {
  const buf = new ArrayBuffer(FRAME_LEN);
  const dv = new DataView(buf);
  dv.setUint8(0, HEAD);
  dv.setUint8(1, p.devId ?? 0x01);
  dv.setUint8(2, p.sysId ?? 0x01);
  dv.setUint8(3, MSG_RANGE_SENSOR);
  dv.setUint8(4, p.seq & 0xff);
  dv.setUint8(5, PAYLOAD_LEN);
  dv.setUint32(6, p.timeMs >>> 0, true);
  dv.setUint32(10, p.distanceMm >>> 0, true);
  dv.setUint8(14, p.strength & 0xff);
  dv.setUint8(15, p.precision & 0xff);
  dv.setUint8(16, p.disStatus & 0xff);
  dv.setUint8(17, 0);
  dv.setInt16(18, p.flowVelX | 0, true);
  dv.setInt16(20, p.flowVelY | 0, true);
  dv.setUint8(22, p.flowQuality & 0xff);
  dv.setUint8(23, p.flowStatus & 0xff);
  dv.setUint16(24, 0, true);
  let sum = 0;
  for (let i = 0; i < CHECKSUM_SPAN; i++) {
    sum = (sum + dv.getUint8(i)) & 0xff;
  }
  dv.setUint8(FRAME_LEN - 1, sum);
  return new Uint8Array(buf);
}

export class DeviceSimSource {
  private cb: SimCallbacks;
  private timer: ReturnType<typeof setInterval> | null = null;
  private t = 0;
  private seq = 0;

  constructor(cb: SimCallbacks) {
    this.cb = cb;
  }

  start(): void {
    this.t = 0;
    this.seq = 0;
    this.cb.onOpen({ usbVendorId: 0x2e8a, usbProductId: 0x0003 });
    this.timer = setInterval(() => this.tick(), 20);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cb.onClose();
  }

  private tick(): void {
    this.t += 20;
    const t = this.t;
    const heightM = 0.85 + 0.12 * Math.sin(t / 4700);

    let velXCms = 6 * Math.sin(t / 2500);
    let velYCms = 4 * Math.cos(t / 3300);
    const slidePhase = t % 15000;
    if (slidePhase < 4000) {
      velXCms += 42 * Math.sin((slidePhase / 4000) * Math.PI);
    }

    const dropout = t % 21000 > 20500;
    const distanceMm = dropout ? 0 : Math.round(heightM * 1000 + (Math.random() - 0.5) * 4);

    let quality = 96 + 5 * Math.sin(t / 900) - (dropout ? 65 : 0);
    quality = Math.max(0, Math.min(100, Math.round(quality + (Math.random() - 0.5) * 6)));

    const chunk = buildMicolinkFrame({
      seq: this.seq++,
      timeMs: t,
      distanceMm,
      strength: 180 + Math.round(Math.random() * 10),
      precision: 2,
      disStatus: distanceMm > 0 ? 1 : 0,
      flowVelX: Math.round(velXCms / heightM),
      flowVelY: Math.round(velYCms / heightM),
      flowQuality: quality,
      flowStatus: quality >= 50 ? 1 : 0,
    });
    this.cb.onChunk(chunk);
  }
}