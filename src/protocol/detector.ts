import { MicolinkParser } from './parser.ts';
import { VariantProbe } from './probe.ts';
import { MspMeasurementSource } from './msp.ts';
import type { MicolinkFrame } from './types.ts';

export type ProtocolName = 'micolink' | 'msp';

/**
 * Auto-detects the wire protocol and then locks to it for the rest of the
 * session (the device never changes protocol mid-operation).
 *
 * Detection rules — a protocol is "detected" only on genuine evidence, never
 * on noise:
 *  - Micolink: 3 valid checksum-verified 0x51 frames, or the checksum-variant
 *    probe locking onto an alternative checksum rule.
 *  - MSP v2: 3 valid CRC-verified frames.
 *
 * After the lock, incoming bytes are fed to the locked parser only, so every
 * error metric (garbage bytes, checksum errors, unknown messages) is reported
 * relative to the detected protocol instead of accumulating noise from the
 * parsers that are no longer active.
 */
const LOCK_THRESHOLD = 3;

export class ProtocolGate {
  readonly micolink = new MicolinkParser();
  readonly probe = new VariantProbe();
  readonly msp = new MspMeasurementSource();

  /** null while still detecting. */
  locked: ProtocolName | null = null;
  onLock: ((p: ProtocolName) => void) | null = null;
  onEvent: ((f: MicolinkFrame) => void) | null = null;

  constructor() {
    this.micolink.onFrame = (f) => this.handleMicolinkFrame(f);
    this.probe.onLock = (variant) => {
      this.micolink.checksumMode = variant;
      this.lock('micolink');
    };
    this.msp.onValidFrame = () => {
      if (this.locked === null && this.msp.frames >= LOCK_THRESHOLD) {
        this.lock('msp');
      }
    };
    this.msp.onEvent = (f) => this.handleMspEvent(f);
  }

  feed(data: Uint8Array): void {
    if (this.locked === 'micolink') {
      this.micolink.feed(data);
    } else if (this.locked === 'msp') {
      this.msp.feed(data);
    } else {
      this.micolink.feed(data);
      this.probe.feed(data);
      this.msp.feed(data);
    }
  }

  /** Measurement events delivered since open (after lock). */
  get measurementCount(): number {
    return this.locked === 'micolink' ? this.micolink.frames : this.msp.flowFrames;
  }

  /** Checksum/CRC failures of the locked protocol. */
  get checksumErrors(): number {
    if (this.locked === 'micolink') return this.micolink.checksumErrors;
    if (this.locked === 'msp') return this.msp.checksumErrors;
    return 0;
  }

  /**
   * Bytes discarded by the locked protocol's parser because they do not belong
   * to a valid frame. Meaningless until locked.
   */
  get garbageBytes(): number {
    if (this.locked === 'micolink') return this.micolink.garbageBytes;
    if (this.locked === 'msp') return this.msp.garbageBytes;
    return 0;
  }

  get unknownMessages(): number {
    return this.locked === 'micolink' ? this.micolink.unknownMessages : 0;
  }

  reset(): void {
    this.locked = null;
    this.micolink.reset();
    this.micolink.checksumMode = 'sum';
    this.probe.reset();
    this.msp.reset();
  }

  private handleMicolinkFrame(f: MicolinkFrame): void {
    if (this.locked === 'msp') return; // impossible in practice; safety
    if (this.locked === null && this.micolink.frames >= LOCK_THRESHOLD) {
      this.lock('micolink');
    }
    if (this.locked === 'micolink') {
      this.onEvent?.(f);
    }
  }

  private handleMspEvent(f: MicolinkFrame): void {
    if (this.locked !== 'msp') return; // suppress pre-lock / foreign events
    this.onEvent?.(f);
  }

  private lock(p: ProtocolName): void {
    if (this.locked !== null) return;
    this.locked = p;
    this.onLock?.(p);
  }
}