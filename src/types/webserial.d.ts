/**
 * Minimal Web Serial API type declarations (not yet in TypeScript's DOM lib).
 * Only what this app uses is declared.
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
      filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
    }): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
    addEventListener(
      type: 'connect' | 'disconnect',
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
  };
}