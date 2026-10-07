/**
 * BLE data source over Web Bluetooth (GATT notifications). Targets BLE-serial
 * bridges exposing a UART-like service:
 *
 *  - Nordic UART Service (NUS): 6e400001… (TX notify = …0003, RX write = …0002)
 *  - HM-10 / AT-09 / JDY class: service FFE0, characteristic FFE1 (notify+write)
 *  - JDY-31 and clones: service FFF0, characteristic FFF1 (notify+write)
 *
 * Only the notify characteristic is needed — MTF sensors stream one-way.
 * Baud rate does not exist on BLE GATT; the sensor's 50 Hz stream is bounded
 * by the connection interval instead. Parsing and metrics are identical to
 * the serial path since the same byte stream feeds the same protocol gate.
 */

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const FFE0_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
const FFE1_CHAR = '0000ffe1-0000-1000-8000-00805f9b34fb';
const FFF0_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const FFF1_CHAR = '0000fff1-0000-1000-8000-00805f9b34fb';

const UART_SERVICES: Array<{ service: string; tx: string; label: string }> = [
  { service: NUS_SERVICE, tx: NUS_TX, label: 'Nordic UART' },
  { service: FFE0_SERVICE, tx: FFE1_CHAR, label: 'FFE0 (HM-10/JDY class)' },
  { service: FFF0_SERVICE, tx: FFF1_CHAR, label: 'FFF0 (JDY-31 class)' },
];

export interface BleInfo {
  deviceName: string | null;
  serviceLabel: string;
}

export interface BleCallbacks {
  onData: (data: Uint8Array) => void;
  onOpen: (info: BleInfo) => void;
  onClose: (error?: string) => void;
}

export class BleSource {
  private cb: BleCallbacks;
  private device: BLEDevice | null = null;
  private notifyChar: BLERemoteGATTCharacteristic | null = null;
  private closing = false;

  constructor(cb: BleCallbacks) {
    this.cb = cb;
  }

  get open(): boolean {
    return this.device !== null;
  }

  async connect(): Promise<void> {
    if (!('bluetooth' in navigator) || !navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser');
    }
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: UART_SERVICES.map((s) => s.service),
    });
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      if (this.device === device && !this.closing) {
        this.device = null;
        this.notifyChar = null;
        this.cb.onClose('Bluetooth device disconnected');
      }
    });

    if (!device.gatt) {
      throw new Error('Device has no GATT server');
    }
    const gatt = await device.gatt.connect();

    for (const svc of UART_SERVICES) {
      try {
        const service = await gatt.getPrimaryService(svc.service);
        const tx = await service.getCharacteristic(svc.tx);
        if (!tx.properties.notify) continue;
        this.notifyChar = tx;
        await tx.startNotifications();
        tx.addEventListener('characteristicvaluechanged', (ev: Event) => {
          const view = (ev.target as BLERemoteGATTCharacteristic).value;
          if (view) {
            this.cb.onData(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
          }
        });
        this.cb.onOpen({
          deviceName: device.name ?? null,
          serviceLabel: svc.label,
        });
        return;
      } catch {
        /* service/characteristic missing — try the next known UART service */
      }
    }
    this.device = null;
    try {
      gatt.disconnect();
    } catch {
      /* already gone */
    }
    throw new Error(
      'No BLE UART service found (tried Nordic UART, FFE0 and FFF0) — this device may not be a serial bridge',
    );
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    try {
      await this.notifyChar?.stopNotifications();
    } catch {
      /* already gone */
    }
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* already gone */
    }
    this.device = null;
    this.notifyChar = null;
    this.closing = false;
    this.cb.onClose();
  }
}