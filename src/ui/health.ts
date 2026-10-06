import type { MicolinkFrame } from '../protocol/types.ts';
import type { SniffStats } from '../protocol/sniffer.ts';
import type { ChecksumVariant } from '../protocol/probe.ts';
import type { ProtocolName } from '../protocol/detector.ts';

export interface HealthInput {
  connected: boolean;
  /** Frames received in the last second. */
  hz: number;
  framesTotal: number;
  /** ms since the last frame, or null if none yet. */
  lastAgeMs: number | null;
  checksumErrors: number;
  garbageBytes: number;
  lastFrame: MicolinkFrame | null;
  sniff: SniffStats;
  /** Bytes per second over the last ~1 s window. */
  bytesPerSec: number;
  /** Checksum variant the probe locked onto, if any. */
  probeVariant: ChecksumVariant | null;
  /** Detected wire protocol, null while still detecting. */
  locked: ProtocolName | null;
}

export type HealthLevel = 'off' | 'wait' | 'ok' | 'warn' | 'bad';

export interface HealthVerdict {
  level: HealthLevel;
  label: string;
  hint: string;
}

export function evaluateHealth(input: HealthInput): HealthVerdict {
  if (!input.connected) {
    return {
      level: 'off',
      label: 'OFFLINE',
      hint: 'Connect the sensor over USB-TTL, or press Simulate to exercise the app without hardware.',
    };
  }

  if (input.framesTotal === 0) {
    return evaluateNoFrames(input);
  }

  if (input.lastAgeMs !== null && input.lastAgeMs > 2000) {
    return {
      level: 'bad',
      label: 'SIGNAL LOST',
      hint: `No frames for ${(input.lastAgeMs / 1000).toFixed(1)} s — the device stopped transmitting or was unplugged.`,
    };
  }

  const problems: string[] = [];
  if (input.hz < 25) {
    problems.push(`low frame rate (${input.hz.toFixed(0)} fps, expected ~50)`);
  }
  if (input.checksumErrors > 3) {
    problems.push(`${input.checksumErrors} checksum errors (noise or wrong baud)`);
  }
  const q = input.lastFrame?.flowQuality;
  if (q !== undefined && q < 50) {
    problems.push(`low flow quality (${q}%) — needs >60 lux, a textured surface and >8 cm distance`);
  }

  if (problems.length > 0) {
    return {
      level: 'warn',
      label: 'DEGRADED',
      hint: problems.join(' · '),
    };
  }

  if (input.locked === 'msp') {
    return {
      level: 'ok',
      label: input.hz >= 40 ? 'STREAMING · OK' : 'LIVE',
      hint: `Receiving ${input.hz.toFixed(1)} measurements/s over MSP v2 (INAV mode) with flow quality ${q ?? '—'}%. MSP motion values are raw sensor units — the velocity readout is an estimate (motion × height).`,
    };
  }
  const variantNote =
    input.probeVariant !== null
      ? ` Decoding with the "${input.probeVariant}" checksum variant — your unit's Micolink differs from the published checksum rule.`
      : '';
  return {
    level: 'ok',
    label: input.hz >= 40 ? 'STREAMING · OK' : 'LIVE',
    hint: `Receiving ${input.hz.toFixed(1)} fps over Micolink with flow quality ${q ?? '—'}% — sensor looks healthy.${variantNote}`,
  };
}

function evaluateNoFrames(input: HealthInput): HealthVerdict {
  const { sniff, bytesPerSec, checksumErrors, probeVariant, locked } = input;

  if (sniff.totalBytes === 0) {
    return {
      level: 'wait',
      label: 'NO DATA',
      hint: 'Port is open but no bytes are arriving. Check wiring: module TX → adapter RX, shared GND, module powered at 5 V.',
    };
  }

  if (locked === 'msp') {
    return {
      level: 'wait',
      label: 'MSP · NO FLOW',
      hint: 'MSP v2 detected and range frames are arriving, but no optical-flow frames yet — flow may be disabled (quality 0) or the message is missing.',
    };
  }
  if (locked === 'micolink') {
    return {
      level: 'wait',
      label: 'MICOLINK · NO FLOW',
      hint: 'Micolink frames decode but no usable measurements yet — unexpected for a healthy sensor, see the diagnostics card.',
    };
  }

  // Which protocol does the stream actually look like? Uniform random bytes
  // hit each signature ~0.39% of the time, so require both a ratio well above
  // that and a minimum absolute count before declaring a protocol.
  const sig = (count: number): boolean => count > 8 && count > input.sniff.totalBytes * 0.005;
  if (sig(sniff.fdHeads)) {
    return {
      level: 'warn',
      label: 'MAVLINK v2 DETECTED',
      hint: `The stream contains 0xFD MAVLink v2 frames (module is in ArduPilot/PX4 mode), which this app does not decode. Switch the module to Micolink or MSP v2 via its solder pads or MicoAssistant, then power-cycle.`,
    };
  }
  if (sig(sniff.feHeads)) {
    return {
      level: 'warn',
      label: 'MAVLINK v1 DETECTED',
      hint: `The stream contains 0xFE MAVLink v1 frames, which this app does not decode. Switch the module to Micolink or MSP v2 via its solder pads or MicoAssistant, then power-cycle.`,
    };
  }
  if (sig(sniff.tfHeads)) {
    return {
      level: 'warn',
      label: 'TFMINI-LIKE STREAM',
      hint: 'Bytes match a TFmini/TF-Luna-style frame — a different sensor may be wired to the adapter.',
    };
  }

  // 0xEF bytes present but nothing decodes: checksum or frame-format variant
  if (sniff.efHeads > 20 && checksumErrors > sniff.efHeads * 0.5) {
    return {
      level: 'warn',
      label: 'CHECKSUM MISMATCH',
      hint: `0xEF frames are arriving but ${checksumErrors} checksums failed under every known rule — probing checksum variants (see Raw stream diagnostics).`,
    };
  }

  if (sniff.efHeads > 20 && bytesPerSec > 200) {
    return {
      level: 'warn',
      label: 'FRAME FORMAT MISMATCH',
      hint: '0xEF frames are arriving with plausible checksums but the payload structure differs from the MTF-01 Micolink spec. Use Export diagnostics and compare with the vendor reference.',
    };
  }

  if (bytesPerSec < 50) {
    return {
      level: 'warn',
      label: 'NEAR-SILENT STREAM',
      hint: `Only ${bytesPerSec.toFixed(0)} bytes/s arriving — suspect a wrong baud rate or a marginal (floating) RX connection.`,
    };
  }

  return {
    level: 'wait',
    label: 'DETECTING',
    hint: `Watching the stream to identify the protocol (${
      probeVariant !== null ? 'checksum variant probing, ' : ''
    }${sniff.totalBytes.toLocaleString()} bytes seen)…`,
  };
}