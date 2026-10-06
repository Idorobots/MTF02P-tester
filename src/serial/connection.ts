/**
 * WebSerial data source for the MTF-02P: opens the port at 115200 8N1
 * and streams raw bytes to a callback. The module outputs 3.3 V LVTTL,
 * so a USB-TTL adapter is required (module TX -> adapter RX).
 */
export interface SerialPortInfoLite {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface PortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialCallbacks {
  onData: (data: Uint8Array) => void;
  onOpen: (info: SerialPortInfoLite | null) => void;
  onClose: (error?: string) => void;
}

export const MTF02P_BAUD = 115200;

/**
 * Common USB-UART bridge vendor IDs. Passing these as requestPort filters
 * hides the host's built-in serial ports (ttyS* on Linux, etc.) from the
 * browser picker — those have no USB vendor ID and never match.
 */
export const BRIDGE_FILTERS: PortFilter[] = [
  { usbVendorId: 0x0403 }, // FTDI FT232
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
  { usbVendorId: 0x1a86 }, // WCH CH340/CH910x
  { usbVendorId: 0x067b }, // Prolific PL2303
  { usbVendorId: 0x2e8a }, // Raspberry Pi (Pico bridge)
  { usbVendorId: 0x303a }, // Espressif native USB
  { usbVendorId: 0x2341 }, // Arduino
  { usbVendorId: 0x0483 }, // STMicroelectronics CDC
];

export class SerialSource {
  private cb: SerialCallbacks;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;

  constructor(cb: SerialCallbacks) {
    this.cb = cb;
  }

  get open(): boolean {
    return this.port !== null;
  }

  async connect(filters?: PortFilter[]): Promise<void> {
    const port = await navigator.serial.requestPort(filters ? { filters } : {});
    await port.open({
      baudRate: MTF02P_BAUD,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
    this.port = port;
    let info: SerialPortInfoLite | null = null;
    try {
      info = port.getInfo();
    } catch {
      info = null;
    }
    this.cb.onOpen(info);
    void this.readLoop(port);
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* reader already errored out */
    }
    try {
      await this.port?.close();
    } catch {
      /* port already gone (device unplugged) */
    }
    this.port = null;
    this.reader = null;
    this.closing = false;
    this.cb.onClose();
  }

  private async readLoop(port: SerialPort): Promise<void> {
    try {
      while (this.port === port && port.readable) {
        const reader = port.readable.getReader();
        this.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (value && value.length > 0) {
              this.cb.onData(value);
            }
            if (done) break;
          }
        } finally {
          if (this.reader === reader) this.reader = null;
          reader.releaseLock();
        }
        if (this.port === port) break; // stream ended (device gone)
      }
    } catch (err) {
      if (this.port === port && !this.closing) {
        this.port = null;
        this.reader = null;
        const msg = err instanceof Error ? err.message : String(err);
        this.cb.onClose(msg);
        return;
      }
    }
    if (this.port === port) {
      this.port = null;
      this.reader = null;
      this.cb.onClose(this.closing ? undefined : 'Port stream ended');
    }
  }
}