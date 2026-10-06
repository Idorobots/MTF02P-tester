import type { MicolinkFrame } from './types.ts';

/**
 * MSP v2 wire format ("$X...") as spoken by MicoAir MTF sensors in INAV mode:
 *
 *   '$' 'X' | dir ('<' request / '>' reply / '!') | flags u8 | command u16 LE |
 *   payload_len u16 LE | payload[len] | CRC8
 *
 * The CRC is CRC-8/DVB-S2 style (poly 0xD5, init 0, MSB-first, 8 iterations
 * per byte) accumulated over flags through the last payload byte. The sensor
 * streams two messages unsolicited at 50 Hz each:
 *
 *   0x1F01 MSP2_SENSOR_RANGEFINDER (>= 5 bytes):
 *     strength u8 | distance i32 (mm, negative = invalid)
 *   0x1F02 MSP2_SENSOR_OPTIC_FLOW (>= 9 bytes):
 *     quality u8 | motion_x i32 | motion_y i32   (raw sensor units)
 *
 * Range and flow arrive as separate frames, so a combiner attaches the most
 * recent range reading to each flow frame and emits one merged measurement
 * event shaped like a Micolink frame, keeping the rest of the app uniform.
 * Motion values are NOT unit-verified: the app shows them raw and marks the
 * height-scaled velocity as an estimate.
 */
export const MSP2_SENSOR_RANGEFINDER = 0x1f01;
export const MSP2_SENSOR_OPTIC_FLOW = 0x1f02;
const MSP_MAX_PAYLOAD_LEN = 64;

export interface MspV2Frame {
  flags: number;
  command: number;
  payload: Uint8Array;
}

export class MspV2Parser {
  /** Returns true on the byte that completes a frame with a good CRC. */
  onValid: ((frame: MspV2Frame) => void) | null = null;

  frames = 0;
  checksumErrors = 0;
  garbageBytes = 0;

  private payload = new Uint8Array(MSP_MAX_PAYLOAD_LEN);
  private state = 0;
  private flags = 0;
  private command = 0;
  private len = 0;
  private count = 0;
  private crc = 0;

  feed(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.parseByte(data[i]);
    }
  }

  reset(): void {
    this.state = 0;
    this.count = 0;
    this.crc = 0;
    this.frames = 0;
    this.checksumErrors = 0;
    this.garbageBytes = 0;
  }

  private crcAdd(b: number): void {
    this.crc ^= b;
    for (let i = 0; i < 8; i++) {
      this.crc = this.crc & 0x80 ? ((this.crc << 1) ^ 0xd5) & 0xff : (this.crc << 1) & 0xff;
    }
  }

  private parseByte(b: number): void {
    switch (this.state) {
      case 0:
        if (b === 0x24) {
          this.state = 1;
        } else {
          this.garbageBytes++;
        }
        break;
      case 1:
        if (b === 0x58) {
          this.state = 2;
        } else if (b !== 0x24) {
          this.resetState();
        }
        break;
      case 2:
        if (b === 0x3c || b === 0x3e || b === 0x21) {
          this.crc = 0;
          this.count = 0;
          this.command = 0;
          this.len = 0;
          this.state = 3;
        } else {
          this.resetState();
        }
        break;
      case 3:
        this.flags = b;
        this.crcAdd(b);
        this.state = 4;
        break;
      case 4:
        this.command = b;
        this.crcAdd(b);
        this.state = 5;
        break;
      case 5:
        this.command |= (b << 8) & 0xffff;
        this.crcAdd(b);
        this.state = 6;
        break;
      case 6:
        this.len = b;
        this.crcAdd(b);
        this.state = 7;
        break;
      case 7:
        this.len |= (b << 8) & 0xffff;
        this.crcAdd(b);
        if (this.len === 0) {
          this.state = 9;
        } else if (this.len > MSP_MAX_PAYLOAD_LEN) {
          this.garbageBytes++;
          this.resetState();
        } else {
          this.count = 0;
          this.state = 8;
        }
        break;
      case 8:
        this.payload[this.count++] = b;
        this.crcAdd(b);
        if (this.count === this.len) {
          this.state = 9;
        }
        break;
      case 9: {
        const valid = this.crc === b;
        this.resetState();
        if (valid) {
          this.frames++;
          this.onValid?.({
            flags: this.flags,
            command: this.command,
            payload: this.payload.slice(0, this.len),
          });
        } else {
          this.checksumErrors++;
        }
        break;
      }
    }
  }

  private resetState(): void {
    this.state = 0;
    this.count = 0;
    this.crc = 0;
  }
}

interface LatestRange {
  distanceMm: number;
  strength: number;
  precision: number;
  disStatus: number;
}

/** Combines MSP range + flow frames into MicolinkFrame-shaped events. */
export class MspMeasurementSource {
  /** Called for every valid frame (range or flow) — used for protocol detection. */
  onValidFrame: (() => void) | null = null;
  /** Emits one event per MSP2_SENSOR_OPTIC_FLOW frame. */
  onEvent: ((frame: MicolinkFrame) => void) | null = null;

  frames = 0;
  rangeFrames = 0;
  flowFrames = 0;

  private parser = new MspV2Parser();
  private latestRange: LatestRange = { distanceMm: 0, strength: 0, precision: 0, disStatus: 1 };
  private seq = 0;

  constructor() {
    this.parser.onValid = (frame) => this.handle(frame);
  }

  get checksumErrors(): number {
    return this.parser.checksumErrors;
  }

  get garbageBytes(): number {
    return this.parser.garbageBytes;
  }

  feed(data: Uint8Array): void {
    this.parser.feed(data);
  }

  reset(): void {
    this.parser.reset();
    this.frames = 0;
    this.rangeFrames = 0;
    this.flowFrames = 0;
    this.seq = 0;
    this.latestRange = { distanceMm: 0, strength: 0, precision: 0, disStatus: 1 };
  }

  private handle(frame: MspV2Frame): void {
    this.frames++;
    this.onValidFrame?.();
    const p = frame.payload;
    if (frame.command === MSP2_SENSOR_RANGEFINDER && p.length >= 5) {
      this.rangeFrames++;
      const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
      const distance = dv.getInt32(1, true);
      this.latestRange = {
        // negative distance = invalid reading per MicoAir MSP mapping
        distanceMm: distance >= 0 ? distance : 0,
        strength: p[0],
        precision: 0,
        disStatus: distance >= 0 ? 0 : 1,
      };
      return;
    }
    if (frame.command === MSP2_SENSOR_OPTIC_FLOW && p.length >= 9) {
      this.flowFrames++;
      const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
      const quality = p[0];
      this.onEvent?.({
        devId: 0x0f,
        sysId: 0x00,
        msgId: frame.command,
        seq: this.seq++ & 0xff,
        timeMs: Math.round(performance.now()),
        distanceMm: this.latestRange.distanceMm,
        strength: this.latestRange.strength,
        precision: this.latestRange.precision,
        disStatus: this.latestRange.disStatus,
        flowVelX: dv.getInt32(1, true),
        flowVelY: dv.getInt32(5, true),
        flowQuality: quality,
        flowStatus: quality > 0 ? 1 : 0,
        receivedAt: performance.now(),
        proto: 'msp',
      });
    }
  }
}