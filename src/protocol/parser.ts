import type { MicolinkFrame } from './types.ts';

/**
 * Byte-oriented decoder for the Micolink protocol used by MicoAir MTF-01/02/02P
 * sensors (UART 115200 8N1, 50 Hz).
 *
 * Frame layout:
 *   [0xEF head][dev_id][sys_id][msg_id][seq][len][payload...][checksum]
 * The checksum is the byte-sum (mod 256) of head through payload (len + 6 bytes).
 *
 * Message 0x51 RANGE_SENSOR carries a 20-byte payload:
 *   time_ms u32 | distance_mm u32 | strength u8 | precision u8 |
 *   dis_status u8 | rsvd u8 | flow_vel_x i16 | flow_vel_y i16 |
 *   flow_quality u8 | flow_status u8 | rsvd u16  (all little-endian)
 */
const HEAD = 0xef;
const MSG_RANGE_SENSOR = 0x51;
const MAX_PAYLOAD_LEN = 64;
const RANGE_SENSOR_PAYLOAD_LEN = 20;

/** Published Micolink checksum is an 8-bit sum; variants cover firmware deviations. */
export type ChecksumMode = 'sum' | 'xor' | 'inv-sum' | 'inv-xor';

export class MicolinkParser {
  onFrame: ((frame: MicolinkFrame) => void) | null = null;
  checksumMode: ChecksumMode = 'sum';

  frames = 0;
  checksumErrors = 0;
  garbageBytes = 0;
  unknownMessages = 0;

  private payload = new Uint8Array(MAX_PAYLOAD_LEN);
  private state = 0;
  private devId = 0;
  private sysId = 0;
  private msgId = 0;
  private seq = 0;
  private len = 0;
  private count = 0;
  private sum = 0;
  private xorAcc = 0;

  feed(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.parseByte(data[i]);
    }
  }

  reset(): void {
    this.state = 0;
    this.count = 0;
    this.sum = 0;
    this.xorAcc = 0;
    this.frames = 0;
    this.checksumErrors = 0;
    this.garbageBytes = 0;
    this.unknownMessages = 0;
  }

  private accum(b: number): void {
    this.sum = (this.sum + b) & 0xff;
    this.xorAcc ^= b;
  }

  private expectedChecksum(): number {
    switch (this.checksumMode) {
      case 'sum':
        return this.sum;
      case 'xor':
        return this.xorAcc;
      case 'inv-sum':
        return ~this.sum & 0xff;
      case 'inv-xor':
        return ~this.xorAcc & 0xff;
    }
  }

  private parseByte(b: number): void {
    switch (this.state) {
      case 0:
        if (b === HEAD) {
          this.sum = b;
          this.xorAcc = b;
          this.state = 1;
        } else {
          this.garbageBytes++;
        }
        break;
      case 1:
        this.devId = b;
        this.accum(b);
        this.state = 2;
        break;
      case 2:
        this.sysId = b;
        this.accum(b);
        this.state = 3;
        break;
      case 3:
        this.msgId = b;
        this.accum(b);
        this.state = 4;
        break;
      case 4:
        this.seq = b;
        this.accum(b);
        this.state = 5;
        break;
      case 5:
        this.len = b;
        this.accum(b);
        if (this.len === 0) {
          this.state = 7;
        } else if (this.len > MAX_PAYLOAD_LEN) {
          this.garbageBytes++;
          this.state = 0;
        } else {
          this.count = 0;
          this.state = 6;
        }
        break;
      case 6:
        this.payload[this.count++] = b;
        this.accum(b);
        if (this.count === this.len) {
          this.state = 7;
        }
        break;
      case 7: {
        const valid = this.expectedChecksum() === b;
        this.state = 0;
        if (!valid) {
          this.checksumErrors++;
          break;
        }
        if (this.msgId !== MSG_RANGE_SENSOR || this.len < RANGE_SENSOR_PAYLOAD_LEN) {
          this.unknownMessages++;
          break;
        }
        const dv = new DataView(this.payload.buffer, this.payload.byteOffset, this.len);
        this.frames++;
        this.onFrame?.({
          devId: this.devId,
          sysId: this.sysId,
          msgId: this.msgId,
          seq: this.seq,
          timeMs: dv.getUint32(0, true),
          distanceMm: dv.getUint32(4, true),
          strength: dv.getUint8(8),
          precision: dv.getUint8(9),
          disStatus: dv.getUint8(10),
          flowVelX: dv.getInt16(12, true),
          flowVelY: dv.getInt16(14, true),
          flowQuality: dv.getUint8(16),
          flowStatus: dv.getUint8(17),
          receivedAt: performance.now(),
          proto: 'micolink',
        });
        break;
      }
    }
  }
}