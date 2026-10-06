import './style.css';
import type { MicolinkFrame } from './protocol/types.ts';
import { SerialSource } from './serial/connection.ts';
import { BRIDGE_FILTERS } from './serial/connection.ts';
import type { PortFilter, SerialPortInfoLite } from './serial/connection.ts';
import { DeviceSimSource } from './sim/deviceSim.ts';
import { StreamSniffer } from './protocol/sniffer.ts';
import { ProtocolGate } from './protocol/detector.ts';
import { ChartsManager } from './ui/charts.ts';
import { PositionPlot } from './ui/positionPlot.ts';
import { evaluateHealth } from './ui/health.ts';

/* ---------- DOM ---------- */

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const dom = {
  statusPill: el<HTMLDivElement>('statusPill'),
  statusText: el<HTMLSpanElement>('statusText'),
  btnConnect: el<HTMLButtonElement>('btnConnect'),
  btnConnectAll: el<HTMLButtonElement>('btnConnectAll'),
  btnSim: el<HTMLButtonElement>('btnSim'),
  btnPause: el<HTMLButtonElement>('btnPause'),
  btnExport: el<HTMLButtonElement>('btnExport'),
  btnResetTrail: el<HTMLButtonElement>('btnResetTrail'),
  compatBanner: el<HTMLDivElement>('compatBanner'),
  roSeqBadge: el<HTMLSpanElement>('roSeqBadge'),
  roAlt: el<HTMLElement>('roAlt'),
  roAltSub: el<HTMLElement>('roAltSub'),
  roVelX: el<HTMLElement>('roVelX'),
  roVelXSub: el<HTMLElement>('roVelXSub'),
  roVelY: el<HTMLElement>('roVelY'),
  roVelYSub: el<HTMLElement>('roVelYSub'),
  roPosX: el<HTMLElement>('roPosX'),
  roPosY: el<HTMLElement>('roPosY'),
  qualityText: el<HTMLElement>('qualityText'),
  qualityFill: el<HTMLDivElement>('qualityFill'),
  roFlowStatus: el<HTMLSpanElement>('roFlowStatus'),
  roDistStatus: el<HTMLSpanElement>('roDistStatus'),
  healthBadge: el<HTMLSpanElement>('healthBadge'),
  healthHint: el<HTMLParagraphElement>('healthHint'),
  hz: el<HTMLElement>('hz'),
  frames: el<HTMLElement>('frames'),
  seqGaps: el<HTMLElement>('seqGaps'),
  checksumErr: el<HTMLElement>('checksumErr'),
  garbage: el<HTMLElement>('garbage'),
  lastAge: el<HTMLElement>('lastAge'),
  uptime: el<HTMLElement>('uptime'),
  healthProto: el<HTMLElement>('healthProto'),
  posScale: el<HTMLSpanElement>('posScale'),
  diagBytes: el<HTMLElement>('diagBytes'),
  diagRate: el<HTMLElement>('diagRate'),
  diagEf: el<HTMLElement>('diagEf'),
  diagFd: el<HTMLElement>('diagFd'),
  diagFe: el<HTMLElement>('diagFe'),
  diagDollar: el<HTMLElement>('diagDollar'),
  diagTf: el<HTMLElement>('diagTf'),
  probeStatus: el<HTMLSpanElement>('probeStatus'),
  hexDump: el<HTMLElement>('hexDump'),
  btnDiag: el<HTMLButtonElement>('btnDiag'),
};

/* ---------- state ---------- */

interface LogRow {
  t: number;
  proto: string;
  sensorMs: number;
  seq: number;
  distanceMm: number;
  strength: number;
  precision: number;
  disStatus: number;
  flowVelX: number;
  flowVelY: number;
  flowQuality: number;
  flowStatus: number;
  velXCms: number;
  velYCms: number;
  posXm: number;
  posYm: number;
}

const LOG_CAP = 200_000;

let source: 'serial' | 'sim' | null = null;
let paused = false;
const gate = new ProtocolGate();
let sessionStart = performance.now();
let frameTimes: number[] = [];
let lastFrameAt: number | null = null;
let lastSeq: number | null = null;
let seqGaps = 0;
let lastFrame: MicolinkFrame | null = null;
let lastHeightM: number | null = null;
let velXCms = NaN;
let velYCms = NaN;
let posX = 0;
let posY = 0;
const log: LogRow[] = [];
let logTruncated = false;

const charts = new ChartsManager(
  el<HTMLCanvasElement>('chartAlt'),
  el<HTMLCanvasElement>('chartFlow'),
  el<HTMLCanvasElement>('chartQuality'),
);
const plot = new PositionPlot(el<HTMLCanvasElement>('posCanvas'));

/* ---------- sources ---------- */

const sniffer = new StreamSniffer();
let byteTimes: number[] = [];

gate.onEvent = onFrame;

const serial = new SerialSource({
  onData: (data) => {
    sniffer.feed(data);
    byteTimes.push(performance.now());
    gate.feed(data);
  },
  onOpen: (info) => onSourceOpen('serial', info),
  onClose: (err) => onSourceClose(err),
});

const sim = new DeviceSimSource({
  onChunk: (data) => {
    sniffer.feed(data);
    byteTimes.push(performance.now());
    gate.feed(data);
  },
  onOpen: () => onSourceOpen('sim', null),
  onClose: (err) => onSourceClose(err),
});

/* ---------- frame handling ---------- */

function onFrame(f: MicolinkFrame): void {
  const now = performance.now();
  const dt = lastFrameAt === null ? 0 : (now - lastFrameAt) / 1000;
  lastFrameAt = now;

  if (lastSeq !== null) {
    const gap = (f.seq - lastSeq + 256) % 256;
    if (gap > 1 && gap < 128) seqGaps += gap - 1;
  }
  lastSeq = f.seq;
  frameTimes.push(now);

  const heightM = f.distanceMm > 0 ? f.distanceMm / 1000 : null;
  if (heightM !== null) lastHeightM = heightM;
  const h = heightM ?? lastHeightM;

  if (h !== null && f.flowQuality >= 50 && dt > 0 && dt < 0.25) {
    velXCms = f.flowVelX * h;
    velYCms = f.flowVelY * h;
    if (!paused) {
      posX += velXCms * dt;
      posY += velYCms * dt;
      plot.add(posX, posY);
    }
  } else {
    velXCms = NaN;
    velYCms = NaN;
  }

  const sessionT = (now - sessionStart) / 1000;
  if (!paused) charts.push(f, sessionT);

  log.push({
    t: sessionT,
    proto: f.proto,
    sensorMs: f.timeMs,
    seq: f.seq,
    distanceMm: f.distanceMm,
    strength: f.strength,
    precision: f.precision,
    disStatus: f.disStatus,
    flowVelX: f.flowVelX,
    flowVelY: f.flowVelY,
    flowQuality: f.flowQuality,
    flowStatus: f.flowStatus,
    velXCms,
    velYCms,
    posXm: posX / 100,
    posYm: posY / 100,
  });
  if (log.length >= LOG_CAP) {
    log.shift();
    logTruncated = true;
  }

  lastFrame = f;
}

/* ---------- session ---------- */

function resetSession(): void {
  gate.reset();
  sniffer.reset();
  byteTimes = [];
  frameTimes = [];
  lastFrameAt = null;
  lastSeq = null;
  seqGaps = 0;
  lastFrame = null;
  lastHeightM = null;
  velXCms = NaN;
  velYCms = NaN;
  posX = 0;
  posY = 0;
  log.length = 0;
  logTruncated = false;
  sessionStart = performance.now();
  charts.reset();
  plot.reset();
  dom.posScale.textContent = '';
  dom.roSeqBadge.textContent = 'seq —';
}

/* ---------- status / health UI ---------- */

function setPill(cls: string, text: string): void {
  dom.statusPill.className = `pill ${cls}`;
  dom.statusText.textContent = text;
}

function hex4(v: number | undefined): string {
  return v === undefined ? '—' : v.toString(16).toUpperCase().padStart(4, '0');
}

function onSourceOpen(kind: 'serial' | 'sim', info: SerialPortInfoLite | null): void {
  source = kind;
  resetSession();
  hideBanner();
  if (kind === 'serial') {
    setPill('pill-live', info?.usbVendorId !== undefined ? `Connected · VID ${hex4(info.usbVendorId)} PID ${hex4(info.usbProductId)}` : 'Connected');
    dom.btnConnect.textContent = 'Disconnect';
    dom.btnSim.disabled = true;
  } else {
    setPill('pill-sim', 'Simulated device running');
    dom.btnConnect.disabled = true;
  }
  dom.btnConnectAll.disabled = true;
  dom.btnSim.textContent = kind === 'sim' ? 'Stop simulator' : 'Simulate';
  dom.btnPause.disabled = false;
  dom.btnResetTrail.disabled = false;
  paused = false;
  dom.btnPause.textContent = 'Pause';
}

function onSourceClose(err?: string): void {
  source = null;
  setPill('pill-off', 'Disconnected');
  dom.btnConnect.textContent = 'Connect device';
  dom.btnConnect.disabled = !('serial' in navigator);
  dom.btnConnectAll.disabled = !('serial' in navigator);
  dom.btnSim.disabled = false;
  dom.btnSim.textContent = 'Simulate';
  dom.btnPause.disabled = true;
  dom.btnPause.textContent = 'Pause';
  dom.btnExport.disabled = true;
  dom.btnResetTrail.disabled = true;
  paused = false;
  dom.healthBadge.className = 'badge badge-off';
  dom.healthBadge.textContent = 'OFFLINE';
  dom.healthHint.textContent = err
    ? `Connection lost: ${err}`
    : 'Connect the sensor over USB-TTL, or press Simulate to exercise the app without hardware.';
}

function showBanner(text: string): void {
  dom.compatBanner.textContent = text;
  dom.compatBanner.classList.remove('hidden');
}

function hideBanner(): void {
  dom.compatBanner.classList.add('hidden');
}

function applyHealth(hz: number, lastAgeMs: number | null): void {
  const now = performance.now();
  byteTimes = byteTimes.filter((ts) => now - ts <= 1000);
  const verdict = evaluateHealth({
    connected: source !== null,
    hz,
    framesTotal: gate.measurementCount,
    lastAgeMs,
    checksumErrors: gate.checksumErrors,
    garbageBytes: gate.garbageBytes,
    lastFrame,
    sniff: sniffer.stats,
    bytesPerSec: byteTimes.length,
    probeVariant: gate.locked === 'micolink' ? gate.probe.locked : null,
    locked: gate.locked,
  });
  dom.healthBadge.className = `badge badge-${verdict.level}`;
  dom.healthBadge.textContent = verdict.label;
  dom.healthHint.textContent = verdict.hint;
}

/* ---------- readouts ---------- */

function updateReadouts(): void {
  const f = lastFrame;
  if (!f) return;

  const heightM = f.distanceMm > 0 ? f.distanceMm / 1000 : null;
  dom.roAlt.textContent = heightM === null ? '—' : heightM.toFixed(2);
  dom.roAltSub.textContent = heightM === null
    ? 'no reading (0 mm = unavailable)'
    : `strength ${f.strength} · precision ${f.precision}`;

  dom.roVelX.textContent = Number.isFinite(velXCms) ? velXCms.toFixed(1) : '—';
  dom.roVelXSub.textContent =
    f.proto === 'msp'
      ? `motion ${f.flowVelX} (raw) — vel. est.`
      : `raw ${f.flowVelX} cm/s @ 1 m`;
  dom.roVelY.textContent = Number.isFinite(velYCms) ? velYCms.toFixed(1) : '—';
  dom.roVelYSub.textContent =
    f.proto === 'msp'
      ? `motion ${f.flowVelY} (raw) — vel. est.`
      : `raw ${f.flowVelY} cm/s @ 1 m`;

  dom.roPosX.textContent = (posX / 100).toFixed(2);
  dom.roPosY.textContent = (posY / 100).toFixed(2);

  dom.qualityText.textContent = `${f.flowQuality}%`;
  dom.qualityFill.style.width = `${f.flowQuality}%`;
  dom.qualityFill.className =
    f.flowQuality >= 70 ? 'fill' : f.flowQuality >= 40 ? 'fill warn' : 'fill bad';

  dom.roFlowStatus.textContent = `flow_status ${f.flowStatus}`;
  dom.roDistStatus.textContent = `dis_status ${f.disStatus}`;
  dom.roSeqBadge.textContent = `seq ${f.seq}`;
}

/* ---------- main update loop ---------- */

function formatUptime(totalS: number): string {
  const s = Math.floor(totalS);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}:${sec.toString().padStart(2, '0')}`;
  return `${Math.floor(m / 60)}:${(m % 60).toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

window.setInterval(() => {
  const now = performance.now();
  frameTimes = frameTimes.filter((ts) => now - ts <= 1000);
  const hz = frameTimes.length;
  const lastAgeMs = lastFrameAt === null ? null : now - lastFrameAt;

  dom.hz.textContent = hz.toFixed(0);
  dom.frames.textContent = gate.measurementCount.toLocaleString();
  dom.seqGaps.textContent = seqGaps.toLocaleString();
  dom.checksumErr.textContent = gate.checksumErrors.toLocaleString();
  dom.garbage.textContent = gate.garbageBytes.toLocaleString();
  dom.lastAge.textContent = lastAgeMs === null ? '—' : `${lastAgeMs.toFixed(0)} ms`;
  dom.uptime.textContent = source === null ? '—' : formatUptime((now - sessionStart) / 1000);

  // diagnostics card
  dom.diagBytes.textContent = sniffer.stats.totalBytes.toLocaleString();
  dom.diagRate.textContent = `${byteTimes.length} B/s`;
  dom.diagEf.textContent = sniffer.stats.efHeads.toLocaleString();
  dom.diagFd.textContent = sniffer.stats.fdHeads.toLocaleString();
  dom.diagFe.textContent = sniffer.stats.feHeads.toLocaleString();
  dom.diagDollar.textContent = sniffer.stats.dollarHeads.toLocaleString();
  dom.diagTf.textContent = sniffer.stats.tfHeads.toLocaleString();
  dom.probeStatus.textContent =
    gate.locked === null
      ? 'protocol: detecting…'
      : gate.locked === 'msp'
        ? 'protocol: MSP v2 (checksum probe n/a)'
        : gate.probe.locked === null
          ? 'protocol: Micolink · standard sum'
          : `protocol: Micolink · checksum "${gate.probe.locked}"`;
  if (sniffer.stats.totalBytes > 0) {
    dom.hexDump.textContent = sniffer.hexDump();
    dom.btnDiag.disabled = false;
  }

  dom.healthProto.textContent =
    gate.locked === 'micolink'
      ? 'Micolink · 0x51'
      : gate.locked === 'msp'
        ? 'MSP v2 · $X'
        : '—';

  if (source !== null && !paused) {
    updateReadouts();
    charts.update();
    plot.render();
    dom.posScale.textContent = plot.scaleLabel();
  }

  applyHealth(hz, lastAgeMs);
  if (source !== null) dom.btnExport.disabled = log.length === 0;
}, 150);

/* ---------- buttons ---------- */

async function tryConnect(filters?: PortFilter[]): Promise<void> {
  if (source !== null || !('serial' in navigator)) return;
  setPill('pill-connecting', 'Connecting…');
  try {
    await serial.connect(filters);
  } catch (err) {
    setPill('pill-off', 'Disconnected');
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotFoundError') {
      showBanner(
        filters
          ? 'No port selected. If your USB-TTL adapter was not in the filtered list, use the "All ports…" button.'
          : 'No port selected.',
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      showBanner(`Could not open port: ${msg}`);
    }
  }
}

dom.btnConnect.addEventListener('click', async () => {
  if (source === 'serial') {
    await serial.disconnect();
    return;
  }
  if (!('serial' in navigator)) {
    showBanner('Web Serial API is not available in this browser. Use Chrome, Edge or Opera on desktop. The simulator still works.');
    return;
  }
  // filtered: hides built-in ports (ttyS*) from the picker
  await tryConnect(BRIDGE_FILTERS);
});

dom.btnConnectAll.addEventListener('click', () => {
  void tryConnect();
});

dom.btnSim.addEventListener('click', () => {
  if (source === 'sim') {
    sim.stop();
  } else if (source === null) {
    sim.start();
  }
});

dom.btnPause.addEventListener('click', () => {
  paused = !paused;
  dom.btnPause.textContent = paused ? 'Resume' : 'Pause';
  if (!paused) {
    // resume integration from the next frame to avoid a position jump
    lastFrameAt = null;
  }
});

dom.btnResetTrail.addEventListener('click', () => {
  posX = 0;
  posY = 0;
  lastFrameAt = null;
  plot.reset();
});

dom.btnExport.addEventListener('click', exportCsv);

dom.btnDiag.addEventListener('click', exportDiagnostics);

function exportDiagnostics(): void {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const payload = {
    capturedAt: d.toISOString(),
    userAgent: navigator.userAgent,
    source,
    verdict: {
      label: dom.healthBadge.textContent,
      hint: dom.healthHint.textContent,
    },
    parser: {
      protocol: gate.locked,
      checksumMode: gate.micolink.checksumMode,
      checksumVariant: gate.locked === 'micolink' ? gate.probe.locked : null,
      measurementCount: gate.measurementCount,
      micolinkFrames: gate.micolink.frames,
      mspFrames: gate.msp.frames,
      checksumErrors: gate.checksumErrors,
      garbageBytes: gate.garbageBytes,
      unknownMessages: gate.unknownMessages,
      seqGaps,
    },
    sniff: sniffer.stats,
    bytesPerSec: byteTimes.length,
    recentBytesHex: sniffer.recentBytes().map((b) => b.toString(16).padStart(2, '0')),
    baud: 115200,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mtf02p_diagnostics_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- CSV export ---------- */

function exportCsv(): void {
  if (log.length === 0) return;
  const header =
    't_s,proto,sensor_ms,seq,distance_mm,height_m,strength,precision,dis_status,' +
    'flow_vel_x_raw_cm_s_at_1m,flow_vel_y_raw_cm_s_at_1m,flow_quality,flow_status,' +
    'vel_x_cm_s,vel_y_cm_s,pos_x_m,pos_y_m';
  const lines = log.map((r) =>
    [
      r.t.toFixed(3),
      r.proto,
      r.sensorMs,
      r.seq,
      r.distanceMm,
      (r.distanceMm / 1000).toFixed(3),
      r.strength,
      r.precision,
      r.disStatus,
      r.flowVelX,
      r.flowVelY,
      r.flowQuality,
      r.flowStatus,
      Number.isFinite(r.velXCms) ? r.velXCms.toFixed(2) : '',
      Number.isFinite(r.velYCms) ? r.velYCms.toFixed(2) : '',
      r.posXm.toFixed(4),
      r.posYm.toFixed(4),
    ].join(','),
  );
  if (logTruncated) {
    lines.unshift('# note: oldest rows were trimmed at the 200k row cap');
  }
  const blob = new Blob([`${header}\n${lines.join('\n')}\n`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  a.href = url;
  a.download = `mtf02p_log_${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- boot ---------- */

if (!('serial' in navigator)) {
  showBanner('Web Serial API is not available in this browser. Use Chrome, Edge or Opera on desktop to connect real hardware — the simulator works everywhere.');
  dom.btnConnect.disabled = true;
  dom.btnConnectAll.disabled = true;
}