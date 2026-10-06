/**
 * Raw-stream sniffer: counts protocol-signature bytes and keeps a hex ring
 * buffer, so the UI can show what is actually arriving on the wire.
 *
 * Signature bytes: 0xEF (Micolink), 0xFD/0xFE (MAVLink v2/v1 STX),
 * '$' (MSP v2), 0x59 (TFmini/TF-Luna). Raw noise never matches any of them,
 * which is diagnostic in itself (floating RX line / wrong baud).
 */
export interface SniffStats {
  totalBytes: number;
  efHeads: number;
  fdHeads: number;
  feHeads: number;
  dollarHeads: number;
  tfHeads: number;
}

const RING_LEN = 96;
const ROW_BYTES = 16;

export class StreamSniffer {
  readonly stats: SniffStats = {
    totalBytes: 0,
    efHeads: 0,
    fdHeads: 0,
    feHeads: 0,
    dollarHeads: 0,
    tfHeads: 0,
  };

  private ring = new Uint8Array(RING_LEN);
  private ringFilled = 0;
  private ringPos = 0;

  feed(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      this.stats.totalBytes++;
      switch (b) {
        case 0xef:
          this.stats.efHeads++;
          break;
        case 0xfd:
          this.stats.fdHeads++;
          break;
        case 0xfe:
          this.stats.feHeads++;
          break;
        case 0x24:
          this.stats.dollarHeads++;
          break;
        case 0x59:
          this.stats.tfHeads++;
          break;
      }
    }
    // newest bytes at the end of the ring
    let toCopy = data.length;
    let src = Math.max(0, data.length - RING_LEN);
    if (toCopy > RING_LEN) {
      toCopy = RING_LEN;
    }
    const gapToFill = RING_LEN - this.ringFilled;
    const advance = Math.min(toCopy, gapToFill);
    this.ringFilled = Math.min(RING_LEN, this.ringFilled + toCopy);
    this.ringPos = (this.ringPos + advance) % RING_LEN;
    for (let i = 0; i < toCopy; i++) {
      this.ring[this.ringPos] = data[src + i];
      this.ringPos = (this.ringPos + 1) % RING_LEN;
    }
  }

  reset(): void {
    this.stats.totalBytes = 0;
    this.stats.efHeads = 0;
    this.stats.fdHeads = 0;
    this.stats.feHeads = 0;
    this.stats.dollarHeads = 0;
    this.stats.tfHeads = 0;
    this.ringFilled = 0;
    this.ringPos = 0;
  }

  /** Hex+ASCII dump of the newest RING_LEN bytes, oldest first. */
  hexDump(): string {
    if (this.ringFilled === 0) return 'no bytes received';
    const start = (this.ringPos - this.ringFilled + RING_LEN) % RING_LEN;
    const rows: string[] = [];
    for (let row = 0; row < this.ringFilled; row += ROW_BYTES) {
      const n = Math.min(ROW_BYTES, this.ringFilled - row);
      let hex = '';
      let ascii = '';
      for (let i = 0; i < ROW_BYTES; i++) {
        if (i < n) {
          const b = this.ring[(start + row + i) % RING_LEN];
          hex += b.toString(16).padStart(2, '0') + ' ';
          ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·';
        } else {
          hex += '   ';
          ascii += ' ';
        }
      }
      rows.push(`${hex.trimEnd().padEnd(47)} ${ascii}`);
    }
    return rows.join('\n');
  }

  /** Raw bytes of the ring, for diagnostics export. */
  recentBytes(): number[] {
    const out: number[] = [];
    const start = (this.ringPos - this.ringFilled + RING_LEN) % RING_LEN;
    for (let i = 0; i < this.ringFilled; i++) {
      out.push(this.ring[(start + i) % RING_LEN]);
    }
    return out;
  }
}