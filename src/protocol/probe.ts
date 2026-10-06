import { MicolinkParser } from './parser.ts';
import type { MicolinkFrame } from './types.ts';

/**
 * Probes alternative Micolink checksum rules. The published spec (vendor
 * sample, Robofusion reference) is an 8-bit sum; if MTF-02P firmware deviates,
 * this probe finds the variant that actually decodes and promotes it to the
 * main parser, so the tester stays usable instead of dead-ending.
 *
 * Lock gating is strict to make false positives on noise practically
 * impossible: >= MIN_LOCK_FRAMES consecutive frames that all have msg 0x51,
 * len 20, sequence numbers incrementing by exactly 1 (mod 256) and sensor
 * timestamps that are monotonic with 20 Hz..100 Hz spacing.
 */
export type ChecksumVariant = 'xor' | 'inv-sum' | 'inv-xor';

export const VARIANTS: readonly ChecksumVariant[] = ['xor', 'inv-sum', 'inv-xor'];

const MIN_LOCK_FRAMES = 6;
const MAX_FRAME_GAP_MS = 50;
const MAX_PLAUSIBLE_GAP_MS = 100;

interface Streak {
  lastSeq: number | null;
  lastTimeMs: number | null;
  count: number;
}

export class VariantProbe {
  /** null until a variant locks in. */
  locked: ChecksumVariant | null = null;
  onLock: ((variant: ChecksumVariant) => void) | null = null;

  private parsers = new Map<ChecksumVariant, MicolinkParser>();
  private streaks = new Map<ChecksumVariant, Streak>();

  constructor() {
    for (const v of VARIANTS) {
      const p = new MicolinkParser();
      p.checksumMode = v;
      p.onFrame = (f) => this.evaluate(v, f);
      this.parsers.set(v, p);
      this.streaks.set(v, { lastSeq: null, lastTimeMs: null, count: 0 });
    }
  }

  feed(data: Uint8Array): void {
    if (this.locked !== null) return;
    for (const p of this.parsers.values()) {
      p.feed(data);
    }
  }

  reset(): void {
    this.locked = null;
    for (const [v, p] of this.parsers) {
      p.reset();
      p.checksumMode = v;
      this.streaks.set(v, { lastSeq: null, lastTimeMs: null, count: 0 });
    }
  }

  private evaluate(variant: ChecksumVariant, f: MicolinkFrame): void {
    if (this.locked !== null) return;
    if (f.msgId !== 0x51) return;

    const s = this.streaks.get(variant)!;

    const seqOk = s.lastSeq === null || (f.seq - s.lastSeq + 256) % 256 === 1;
    const gap = s.lastTimeMs === null ? null : f.timeMs - s.lastTimeMs;
    const timeOk =
      gap === null ||
      (gap >= 0 && gap <= MAX_PLAUSIBLE_GAP_MS && (s.count === 0 || gap <= MAX_FRAME_GAP_MS));

    if (!seqOk || !timeOk) {
      s.count = 0;
    } else {
      s.count++;
    }
    s.lastSeq = f.seq;
    s.lastTimeMs = f.timeMs;

    if (s.count >= MIN_LOCK_FRAMES - 1) {
      this.locked = variant;
      this.onLock?.(variant);
    }
  }
}