/** A decoded Micolink RANGE_SENSOR (0x51) frame from the MTF-02P. */
export interface MicolinkFrame {
  devId: number;
  sysId: number;
  msgId: number;
  /** Rolling sequence counter, increments per frame. */
  seq: number;
  /** Sensor-reported system time in ms. */
  timeMs: number;
  /** ToF distance in mm; 0 means "reading unavailable". */
  distanceMm: number;
  /** ToF signal strength (raw, 0-255). */
  strength: number;
  /** ToF distance precision (raw). */
  precision: number;
  /** ToF distance status code (raw). */
  disStatus: number;
  /** Optical flow velocity X in cm/s @ 1 m altitude. */
  flowVelX: number;
  /** Optical flow velocity Y in cm/s @ 1 m altitude. */
  flowVelY: number;
  /** Optical flow quality, 0-100. */
  flowQuality: number;
  /** Optical flow status code (raw). */
  flowStatus: number;
  /** Host-side reception time (performance.now(), ms). */
  receivedAt: number;
  /** Which wire protocol this frame came from. */
  proto: 'micolink' | 'msp';
}

export interface ParserStats {
  frames: number;
  checksumErrors: number;
  garbageBytes: number;
  unknownMessages: number;
}