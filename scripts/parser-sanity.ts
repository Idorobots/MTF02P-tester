/**
 * Sanity check for the Micolink parser, checksum-variant probe and stream
 * sniffer. Runs bundled with esbuild: npm run sanity
 */
import { MicolinkParser } from '../src/protocol/parser.ts';
import { buildMicolinkFrame } from '../src/sim/deviceSim.ts';
import { VariantProbe, VARIANTS } from '../src/protocol/probe.ts';
import { StreamSniffer } from '../src/protocol/sniffer.ts';
import { MspMeasurementSource, MSP2_SENSOR_RANGEFINDER, MSP2_SENSOR_OPTIC_FLOW } from '../src/protocol/msp.ts';
import { ProtocolGate } from '../src/protocol/detector.ts';
import { evaluateHealth } from '../src/ui/health.ts';
import type { SniffStats } from '../src/protocol/sniffer.ts';
import type { MicolinkFrame } from '../src/protocol/types.ts';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`ok:   ${name}`);
  }
}

const frame = buildMicolinkFrame({
  seq: 7,
  timeMs: 1234,
  distanceMm: 850,
  strength: 200,
  precision: 2,
  disStatus: 1,
  flowVelX: 120,
  flowVelY: -34,
  flowQuality: 87,
  flowStatus: 1,
});

// 1. whole frame in one chunk, byte by byte
const parser = new MicolinkParser();
const received: MicolinkFrame[] = [];
parser.onFrame = (f) => received.push(f);
parser.feed(frame);
check('decodes a single valid frame', parser.frames === 1 && received.length === 1);
const f0 = received[0]!;
check('seq', f0.seq === 7);
check('time_ms', f0.timeMs === 1234);
check('distance_mm', f0.distanceMm === 850);
check('strength', f0.strength === 200);
check('precision', f0.precision === 2);
check('dis_status', f0.disStatus === 1);
check('flow_vel_x (i16)', f0.flowVelX === 120);
check('flow_vel_y (i16)', f0.flowVelY === -34);
check('flow_quality', f0.flowQuality === 87);
check('flow_status', f0.flowStatus === 1);
check('no garbage on clean stream', parser.garbageBytes === 0);

// 2. frame split across two chunks
parser.feed(frame.slice(0, 10));
check('no frame until complete', parser.frames === 1);
parser.feed(frame.subarray(10));
check('decodes frame split across chunks', parser.frames === 2);

// 3. junk before a frame is counted and skipped
const junk = new Uint8Array([0x00, 0x12, 0x9a, 0x33]);
parser.feed(junk);
parser.feed(frame);
check('garbage bytes counted', parser.garbageBytes === junk.length);
check('frame after junk decodes', parser.frames === 3);

// 4. corrupted payload -> checksum error, next frame still decodes
const corrupt = frame.slice();
corrupt[12] ^= 0xff;
parser.feed(corrupt);
parser.feed(frame);
check('corrupt frame rejected', parser.checksumErrors === 1);
check('stream resyncs after corruption', parser.frames === 4);

// 5. unknown message id is ignored without breaking sync
const otherMsg = frame.slice();
otherMsg[3] = 0x52;
let sum = 0;
for (let i = 0; i < otherMsg.length - 1; i++) sum = (sum + otherMsg[i]) & 0xff;
otherMsg[otherMsg.length - 1] = sum;
parser.feed(otherMsg);
check('unknown message ignored', parser.unknownMessages === 1);
parser.feed(frame);
check('sync kept after unknown message', parser.frames === 5);

// 6. reset clears stats
parser.reset();
check('reset clears counters', parser.frames === 0 && parser.checksumErrors === 0);

// 7. checksum-variant probe: XOR-checksummed stream locks and decodes
function xorSpan(bytes: Uint8Array): number {
  let x = 0;
  for (const b of bytes) x ^= b;
  return x;
}

for (const variant of VARIANTS) {
  const main = new MicolinkParser();
  const probe2 = new VariantProbe();
  const got: MicolinkFrame[] = [];
  let locked: string | null = null;
  probe2.onLock = (v) => {
    locked = v;
    main.checksumMode = v;
  };
  main.onFrame = (f) => got.push(f);

  for (let i = 0; i < 10; i++) {
    const f = buildMicolinkFrame({
      seq: i,
      timeMs: 20 * i,
      distanceMm: 800,
      strength: 180,
      precision: 2,
      disStatus: 1,
      flowVelX: 100,
      flowVelY: -100,
      flowQuality: 90,
      flowStatus: 1,
    });
    // re-stamp the checksum byte with the variant's rule
    const span = f.subarray(0, f.length - 1);
    let ck: number;
    if (variant === 'xor') {
      ck = xorSpan(span);
    } else if (variant === 'inv-sum') {
      ck = ~span.reduce((a, b) => (a + b) & 0xff, 0) & 0xff;
    } else {
      ck = ~xorSpan(span) & 0xff;
    }
    f[f.length - 1] = ck;
    probe2.feed(f);
    main.feed(f);
  }
  check(`probe locks variant ${variant}`, locked === variant);
  check(`main parser decodes after ${variant} lock`, main.frames >= 5 && got.length >= 5);
  check(`probe does not re-lock after ${variant}`, probe2.locked === variant);
}

// 8. probe does NOT lock on noise; sniffer counts MAVLink signature bytes
const noiseParser = new MicolinkParser();
const noiseProbe = new VariantProbe();
const sniffer = new StreamSniffer();
const junkFrame = buildMicolinkFrame({
  seq: 0,
  timeMs: 5,
  distanceMm: 10,
  strength: 1,
  precision: 1,
  disStatus: 1,
  flowVelX: 0,
  flowVelY: 0,
  flowQuality: 0,
  flowStatus: 0,
});
junkFrame[junkFrame.length - 1] ^= 0x55; // corrupt checksum
const noise = new Uint8Array(2000);
for (let i = 0; i < noise.length; i++) {
  noise[i] = i % 2 === 0 ? junkFrame[i % junkFrame.length] : (i * 137) % 256;
}
sniffer.feed(noise);
noiseProbe.feed(noise);
noiseParser.feed(noise);
check('probe does not lock on noise', noiseProbe.locked === null);
check('sniffer counts ef heads in noise-like stream', sniffer.stats.efHeads > 10);
check('sniffer counts total bytes', sniffer.stats.totalBytes === noise.length);

// 9. sniffer recognises MSP ('$X') and MAVLink v2 (0xFD) signatures
const sniffer2 = new StreamSniffer();
const mspLike = new Uint8Array(1000);
for (let i = 0; i < mspLike.length; i += 40) {
  mspLike[i] = 0x24; // '$'
  mspLike[i + 1] = 0x58; // 'X'
}
for (let i = 5; i < mspLike.length; i += 100) {
  mspLike[i] = 0xfd;
}
sniffer2.feed(mspLike);
check('sniffer counts $ heads', sniffer2.stats.dollarHeads === 25);
check('sniffer counts 0xFD heads', sniffer2.stats.fdHeads === 10);

// 10. hex dump has 96-byte cap and renders rows
const sniffer3 = new StreamSniffer();
const big = new Uint8Array(500).fill(0xef);
sniffer3.feed(big);
const dump = sniffer3.hexDump();
check('hex dump capped at 96 bytes', sniffer3.recentBytes().length === 96);
check('hex dump has 6 rows', dump.split('\n').length === 6);

// ---------- MSP v2 ----------

// test helper: build an "$X>" MSP v2 frame with correct CRC-8/DVB-S2 (poly 0xD5)
function buildMspV2Frame(command: number, payload: Uint8Array, dir = 0x3e): Uint8Array {
  const total = 9 + payload.length;
  const buf = new Uint8Array(total);
  buf[0] = 0x24; // '$'
  buf[1] = 0x58; // 'X'
  buf[2] = dir;
  buf[3] = 0; // flags
  buf[4] = command & 0xff;
  buf[5] = (command >>> 8) & 0xff;
  buf[6] = payload.length & 0xff;
  buf[7] = (payload.length >>> 8) & 0xff;
  buf.set(payload, 8);
  let crc = 0;
  for (let i = 3; i < 8 + payload.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
    }
  }
  buf[total - 1] = crc;
  return buf;
}

function mspRangePayload(distanceMm: number, strength: number): Uint8Array {
  const p = new Uint8Array(5);
  p[0] = strength;
  p[1] = distanceMm & 0xff;
  p[2] = (distanceMm >>> 8) & 0xff;
  p[3] = (distanceMm >>> 16) & 0xff;
  p[4] = (distanceMm >>> 24) & 0xff;
  return p;
}

function mspFlowPayload(quality: number, motionX: number, motionY: number): Uint8Array {
  const p = new Uint8Array(9);
  p[0] = quality;
  const dv = new DataView(p.buffer);
  dv.setInt32(1, motionX, true);
  dv.setInt32(5, motionY, true);
  return p;
}

// 11. MSP v2: range + flow combine into one measurement event
const mspSrc = new MspMeasurementSource();
const mspEvents: MicolinkFrame[] = [];
mspSrc.onEvent = (f) => mspEvents.push(f);
mspSrc.feed(buildMspV2Frame(MSP2_SENSOR_RANGEFINDER, mspRangePayload(920, 210)));
mspSrc.feed(buildMspV2Frame(MSP2_SENSOR_OPTIC_FLOW, mspFlowPayload(80, 250, -80)));
check('msp: range frame not emitted, flow emits one event', mspEvents.length === 1);
check('msp: valid frame count', mspSrc.frames === 2 && mspSrc.rangeFrames === 1 && mspSrc.flowFrames === 1);
const mspEv = mspEvents[0]!;
check('msp: proto tag', mspEv.proto === 'msp');
check('msp: distance from paired range frame', mspEv.distanceMm === 920);
check('msp: strength', mspEv.strength === 210);
check('msp: motion x/y (i32)', mspEv.flowVelX === 250 && mspEv.flowVelY === -80);
check('msp: quality + status', mspEv.flowQuality === 80 && mspEv.flowStatus === 1);

// 12. MSP: negative distance -> invalid, quality 0 -> flow_status 0
mspSrc.feed(buildMspV2Frame(MSP2_SENSOR_RANGEFINDER, mspRangePayload(-1, 5)));
mspSrc.feed(buildMspV2Frame(MSP2_SENSOR_OPTIC_FLOW, mspFlowPayload(0, 0, 0)));
const mspEv2 = mspEvents[1]!;
check('msp: negative distance mapped to 0/invalid', mspEv2.distanceMm === 0 && mspEv2.disStatus === 1);
check('msp: quality 0 -> flow_status 0', mspEv2.flowStatus === 0);

// 13. MSP: corrupted CRC rejected, stream resyncs
const good = buildMspV2Frame(MSP2_SENSOR_OPTIC_FLOW, mspFlowPayload(70, 10, 20));
const corruptMsp = good.slice();
corruptMsp[corruptMsp.length - 1] ^= 0xff;
mspSrc.feed(corruptMsp);
check('msp: corrupt CRC rejected', mspSrc.checksumErrors === 1);
mspSrc.feed(good);
check('msp: resync after corrupt CRC', mspEvents.length === 3);

// 14. MSP: frame split across chunks decodes
mspSrc.feed(buildMspV2Frame(MSP2_SENSOR_OPTIC_FLOW, mspFlowPayload(70, 10, 20)).slice(0, 6));
mspSrc.feed(buildMspV2Frame(MSP2_SENSOR_OPTIC_FLOW, mspFlowPayload(70, 10, 20)).slice(6));
check('msp: split frame decodes', mspEvents.length === 4);

// 15. MSP: unknown command ignored but counted as valid frame
const before = mspSrc.frames;
mspSrc.feed(buildMspV2Frame(0x1010, new Uint8Array(4)));
check('msp: unknown command counted but not emitted', mspSrc.frames === before + 1 && mspEvents.length === 4);

// 16. interleaved Micolink + MSP streams decode independently
const bothParser = new MicolinkParser();
const bothMsp = new MspMeasurementSource();
const bothEvents: MicolinkFrame[] = [];
bothParser.onFrame = (f) => bothEvents.push(f);
bothMsp.onEvent = (f) => bothEvents.push(f);
bothParser.feed(frame);
bothMsp.feed(buildMspV2Frame(MSP2_SENSOR_OPTIC_FLOW, mspFlowPayload(60, 1, 2)));
check('interleaved streams decode', bothEvents.length === 2 && bothEvents[0]!.proto === 'micolink' && bothEvents[1]!.proto === 'msp');

// ---------- ProtocolGate: auto-detect + protocol-relative metrics ----------

// 17. gate locks micolink on vendor frames and reports garbage relative to it
const gateM = new ProtocolGate();
const gateEvents: MicolinkFrame[] = [];
let gateLocked: string | null = null;
gateM.onLock = (p) => (gateLocked = p);
gateM.onEvent = (f) => gateEvents.push(f);
for (let i = 0; i < 3; i++) {
  gateM.feed(buildMicolinkFrame({
    seq: i,
    timeMs: 20 * i,
    distanceMm: 900,
    strength: 200,
    precision: 2,
    disStatus: 1,
    flowVelX: 10,
    flowVelY: -10,
    flowQuality: 90,
    flowStatus: 1,
  }));
}
check('gate: locks micolink after 3 frames', gateLocked === 'micolink');
check('gate: micolink events emitted after lock', gateEvents.length >= 1 && gateEvents.every((e) => e.proto === 'micolink'));
check('gate: garbage 0 on clean micolink stream', gateM.garbageBytes === 0);
gateM.feed(new Uint8Array([0x11, 0x22, 0x33])); // junk after lock
check('gate: post-lock junk counted vs micolink', gateM.garbageBytes === 3);
gateM.feed(buildMicolinkFrame({
  seq: 3,
  timeMs: 80,
  distanceMm: 900,
  strength: 200,
  precision: 2,
  disStatus: 1,
  flowVelX: 10,
  flowVelY: -10,
  flowQuality: 90,
  flowStatus: 1,
}));
check('gate: frame after junk decodes, junk stays counted', gateM.measurementCount === 4 && gateM.garbageBytes === 3);

// 18. gate locks msp and metrics become MSP-relative
const gateS = new ProtocolGate();
const gateSEvents: MicolinkFrame[] = [];
let gateSLocked: string | null = null;
gateS.onLock = (p) => (gateSLocked = p);
gateS.onEvent = (f) => gateSEvents.push(f);
gateS.feed(buildMspV2Frame(MSP2_SENSOR_RANGEFINDER, mspRangePayload(1000, 200)));
gateS.feed(buildMspV2Frame(MSP2_SENSOR_OPTIC_FLOW, mspFlowPayload(75, 5, 6)));
check('gate: not locked before 3 valid msp frames', gateSLocked === null);
gateS.feed(buildMspV2Frame(MSP2_SENSOR_RANGEFINDER, mspRangePayload(1000, 200)));
check('gate: locks msp after 3 valid frames', gateSLocked === 'msp');
gateS.feed(buildMspV2Frame(MSP2_SENSOR_OPTIC_FLOW, mspFlowPayload(75, 5, 6)));
check('gate: msp event emitted after lock', gateSEvents.length === 1 && gateSEvents[0]!.proto === 'msp');
check('gate: garbage 0 on clean msp stream', gateS.garbageBytes === 0);
gateS.feed(new Uint8Array([0xef, 0x0f, 0x00])); // junk (from msp's perspective)
check('gate: post-lock junk counted vs msp', gateS.garbageBytes === 3);

// 19. gate does not lock on noise
const gateN = new ProtocolGate();
gateN.feed(noise);
check('gate: does not lock on noise', gateN.locked === null);
check('gate: garbage not reported pre-lock', gateN.garbageBytes === 0 && gateN.checksumErrors === 0);

// 20. gate locks micolink through the checksum-variant probe
const gateV = new ProtocolGate();
const gateVEvents: MicolinkFrame[] = [];
let gateVLocked: string | null = null;
gateV.onLock = (p) => (gateVLocked = p);
gateV.onEvent = (f) => gateVEvents.push(f);
for (let i = 0; i < 8; i++) {
  const f = buildMicolinkFrame({
    seq: i,
    timeMs: 20 * i,
    distanceMm: 800,
    strength: 180,
    precision: 2,
    disStatus: 1,
    flowVelX: 100,
    flowVelY: -100,
    flowQuality: 90,
    flowStatus: 1,
  });
  const span = f.subarray(0, f.length - 1);
  f[f.length - 1] = ~span.reduce((a, b) => (a + b) & 0xff, 0) & 0xff; // inv-sum checksum
  gateV.feed(f);
}
check('gate: locks micolink via probe', gateVLocked === 'micolink' && gateV.probe.locked === 'inv-sum');
check('gate: decodes after variant lock', gateV.measurementCount >= 3 && gateVEvents.every((e) => e.proto === 'micolink'));

// ---------- Health verdicts (device-works-as-expected logic) ----------

function mkFrame(quality: number): MicolinkFrame {
  return {
    devId: 1, sysId: 1, msgId: 0x51, seq: 1, timeMs: 0,
    distanceMm: 900, strength: 200, precision: 2, disStatus: 1,
    flowVelX: 10, flowVelY: 10, flowQuality: quality, flowStatus: 1,
    receivedAt: 0, proto: 'micolink',
  };
}

const emptySniff: SniffStats = {
  totalBytes: 0, efHeads: 0, fdHeads: 0, feHeads: 0, dollarHeads: 0, tfHeads: 0,
};

function healthInput(overrides: Partial<Parameters<typeof evaluateHealth>[0]>): Parameters<typeof evaluateHealth>[0] {
  return {
    connected: true,
    hz: 50,
    framesTotal: 100,
    lastAgeMs: 20,
    checksumErrors: 0,
    garbageBytes: 0,
    lastFrame: mkFrame(90),
    sniff: { totalBytes: 5000, efHeads: 200, fdHeads: 0, feHeads: 0, dollarHeads: 0, tfHeads: 0 },
    bytesPerSec: 2700,
    probeVariant: null,
    locked: 'micolink',
    ...overrides,
  };
}

const v = (input: Parameters<typeof evaluateHealth>[0]) => evaluateHealth(input);

check('health: offline', v(healthInput({ connected: false })).level === 'off' && v(healthInput({ connected: false })).label === 'OFFLINE');
check('health: no bytes -> NO DATA', v(healthInput({ framesTotal: 0, sniff: emptySniff, bytesPerSec: 0 })).label === 'NO DATA');
check('health: detecting before lock', v(healthInput({
  framesTotal: 0,
  locked: null,
  sniff: { totalBytes: 3000, efHeads: 5, fdHeads: 2, feHeads: 1, dollarHeads: 1, tfHeads: 1 },
  bytesPerSec: 500,
})).label === 'DETECTING');
check('health: msp locked but no flow frames', v(healthInput({ framesTotal: 0, locked: 'msp' })).label === 'MSP · NO FLOW');
check('health: micolink locked but no measurements', v(healthInput({ framesTotal: 0, locked: 'micolink' })).label === 'MICOLINK · NO FLOW');
check('health: mavlink v2 stream flagged', v(healthInput({
  framesTotal: 0,
  locked: null,
  sniff: { totalBytes: 5000, efHeads: 1, fdHeads: 30, feHeads: 0, dollarHeads: 0, tfHeads: 0 },
  bytesPerSec: 1350,
})).label === 'MAVLINK v2 DETECTED');
check('health: mavlink v1 stream flagged', v(healthInput({
  framesTotal: 0,
  locked: null,
  sniff: { totalBytes: 5000, efHeads: 1, fdHeads: 0, feHeads: 30, dollarHeads: 0, tfHeads: 0 },
  bytesPerSec: 1350,
})).label === 'MAVLINK v1 DETECTED');
check('health: tfmini-like stream flagged', v(healthInput({
  framesTotal: 0,
  locked: null,
  sniff: { totalBytes: 5000, efHeads: 1, fdHeads: 0, feHeads: 0, dollarHeads: 0, tfHeads: 30 },
  bytesPerSec: 1350,
})).label === 'TFMINI-LIKE STREAM');
check('health: checksum mismatch detected', v(healthInput({
  framesTotal: 0,
  locked: null,
  checksumErrors: 80,
  sniff: { totalBytes: 5000, efHeads: 100, fdHeads: 0, feHeads: 0, dollarHeads: 0, tfHeads: 0 },
  bytesPerSec: 1350,
})).label === 'CHECKSUM MISMATCH');
check('health: frame format mismatch detected', v(healthInput({
  framesTotal: 0,
  locked: null,
  checksumErrors: 5,
  sniff: { totalBytes: 5000, efHeads: 100, fdHeads: 0, feHeads: 0, dollarHeads: 0, tfHeads: 0 },
  bytesPerSec: 1350,
})).label === 'FRAME FORMAT MISMATCH');
check('health: near-silent stream detected', v(healthInput({
  framesTotal: 0,
  locked: null,
  sniff: { totalBytes: 200, efHeads: 1, fdHeads: 0, feHeads: 0, dollarHeads: 0, tfHeads: 0 },
  bytesPerSec: 10,
})).label === 'NEAR-SILENT STREAM');
check('health: streaming ok at 50 fps', v(healthInput({})).level === 'ok' && v(healthInput({})).label === 'STREAMING · OK');
check('health: streaming ok over msp mentions estimate', v(healthInput({ locked: 'msp' })).hint.includes('estimate'));
check('health: live below 40 fps still ok', v(healthInput({ hz: 45 })).label === 'STREAMING · OK' && v(healthInput({ hz: 30 })).label === 'LIVE');
check('health: low frame rate degraded', v(healthInput({ hz: 10 })).level === 'warn' && v(healthInput({ hz: 10 })).label === 'DEGRADED');
check('health: checksum errors degraded', v(healthInput({ checksumErrors: 5 })).level === 'warn');
check('health: low flow quality degraded', v(healthInput({ lastFrame: mkFrame(30) })).level === 'warn');
check('health: stalled stream -> SIGNAL LOST', v(healthInput({ lastAgeMs: 3000 })).level === 'bad' && v(healthInput({ lastAgeMs: 3000 })).label === 'SIGNAL LOST');
check('health: checksum variant mentioned in hint', v(healthInput({ probeVariant: 'xor' })).hint.includes('"xor"'));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  (globalThis as { process?: { exit(code?: number): void } }).process?.exit(1);
}
console.log('\nparser sanity: all checks passed');