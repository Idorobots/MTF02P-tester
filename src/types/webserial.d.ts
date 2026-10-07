/**
 * Minimal browser-API type declarations not yet in TypeScript's DOM lib:
 * Web Serial API and Web Bluetooth (BLE GATT), only what this app uses.
 */
interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: string;
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfo;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  forget(): Promise<void>;
}

interface Navigator {
  readonly serial: {
    requestPort(options?: {
      filters?: Array<{
        usbVendorId?: number;
        usbProductId?: number;
        bluetoothServiceClassId?: string;
      }>;
      /** Bluetooth Classic service classes the site may access (Chrome 117+). */
      allowedBluetoothServiceClassIds?: string[];
    }): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
    addEventListener(
      type: 'connect' | 'disconnect',
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
  };
}

/* ---------- Web Bluetooth (BLE) ---------- */

interface BLERequestDeviceOptions {
  filters?: Array<{
    services?: Array<string | number>;
    name?: string;
    namePrefix?: string;
  }>;
  /** Services the site needs access to when using acceptAllDevices. */
  optionalServices?: Array<string | number>;
  acceptAllDevices?: boolean;
}

interface BLECharacteristicProperties {
  read?: boolean;
  write?: boolean;
  writeWithoutResponse?: boolean;
  notify?: boolean;
  indicate?: boolean;
}

interface BLERemoteGATTCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly properties: BLECharacteristicProperties;
  readonly value: DataView | null;
  startNotifications(): Promise<BLERemoteGATTCharacteristic>;
  stopNotifications(): Promise<BLERemoteGATTCharacteristic>;
}

interface BLERemoteGATTService {
  readonly uuid: string;
  getCharacteristic(characteristic: string | number): Promise<BLERemoteGATTCharacteristic>;
}

interface BLERemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BLERemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string | number): Promise<BLERemoteGATTService>;
}

interface BLEDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BLERemoteGATTServer;
}

interface Navigator {
  readonly bluetooth?: {
    requestDevice(options?: BLERequestDeviceOptions): Promise<BLEDevice>;
  };
}