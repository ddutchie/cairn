/**
 * Cairn Sync — Hybrid Logical Clock (HLC)
 *
 * An HLC produces monotonically-increasing, causally-ordered timestamps that
 * tolerate wall-clock skew between devices. This replaces the fragile
 * wall-clock ISO-string comparison used by the current note reconciler
 * (electron/notes-files.ts), which corrupts under clock skew.
 *
 * Encoding: `<physical_ms_hex_12>:<counter_hex_4>:<deviceId>`
 *   - physical: max(local wall clock, last physical seen) in ms, 12 hex digits
 *   - counter:  logical tiebreaker when physical is unchanged, 4 hex digits
 *   - deviceId: final tiebreaker so two devices never produce equal stamps
 *
 * Lexicographic string comparison of the encoded form yields the correct
 * causal/total order because each field is zero-padded fixed-width.
 *
 * References the plan: docs/plans/mobile-app-viability.md §4 (HLC).
 */

export interface HlcParts {
  physical: number; // ms since epoch
  counter: number; // logical counter
  deviceId: string;
}

const PHYSICAL_HEX_WIDTH = 12; // ms fits in 12 hex digits until year ~10889
const COUNTER_HEX_WIDTH = 4; // up to 65535 events per physical ms
const MAX_COUNTER = 0xffff;

export function encodeHlc(parts: HlcParts): string {
  const p = parts.physical.toString(16).padStart(PHYSICAL_HEX_WIDTH, "0");
  const c = parts.counter.toString(16).padStart(COUNTER_HEX_WIDTH, "0");
  return `${p}:${c}:${parts.deviceId}`;
}

export function decodeHlc(stamp: string): HlcParts {
  const [p, c, ...rest] = stamp.split(":");
  return {
    physical: parseInt(p, 16),
    counter: parseInt(c, 16),
    deviceId: rest.join(":"),
  };
}

/**
 * Compare two encoded HLC stamps. Returns <0, 0, >0 like a sort comparator.
 * Compares physical, then counter, then deviceId — matching the encoding.
 */
export function compareHlc(a: string, b: string): number {
  const pa = decodeHlc(a);
  const pb = decodeHlc(b);
  if (pa.physical !== pb.physical) return pa.physical - pb.physical;
  if (pa.counter !== pb.counter) return pa.counter - pb.counter;
  return pa.deviceId < pb.deviceId ? -1 : pa.deviceId > pb.deviceId ? 1 : 0;
}

/**
 * A per-device HLC generator. Persist `lastStamp` (getState) across restarts
 * and restore it (constructor arg) so the clock never regresses.
 */
export class Hlc {
  private physical: number;
  private counter: number;
  readonly deviceId: string;
  private now: () => number;

  constructor(deviceId: string, opts?: { last?: string; now?: () => number }) {
    this.deviceId = deviceId;
    this.now = opts?.now ?? (() => Date.now());
    if (opts?.last) {
      const parts = decodeHlc(opts.last);
      this.physical = parts.physical;
      this.counter = parts.counter;
    } else {
      this.physical = 0;
      this.counter = 0;
    }
  }

  /** Advance the clock for a locally-originated event and return the stamp. */
  send(): string {
    const wall = this.now();
    const prevPhysical = this.physical;
    this.physical = Math.max(prevPhysical, wall);
    if (this.physical === prevPhysical) {
      this.counter += 1;
      if (this.counter > MAX_COUNTER) {
        // Overflow: bump physical by 1ms and reset counter.
        this.physical += 1;
        this.counter = 0;
      }
    } else {
      this.counter = 0;
    }
    return encodeHlc({ physical: this.physical, counter: this.counter, deviceId: this.deviceId });
  }

  /**
   * Merge a remote stamp into the local clock (call when receiving a peer op).
   * Keeps the local clock ahead of anything it has observed, so subsequently
   * generated local stamps causally follow received ones.
   */
  receive(remote: string): void {
    const r = decodeHlc(remote);
    const wall = this.now();
    const maxPhysical = Math.max(this.physical, r.physical, wall);
    if (maxPhysical === this.physical && maxPhysical === r.physical) {
      this.counter = Math.max(this.counter, r.counter) + 1;
    } else if (maxPhysical === this.physical) {
      this.counter += 1;
    } else if (maxPhysical === r.physical) {
      this.counter = r.counter + 1;
    } else {
      this.counter = 0;
    }
    if (this.counter > MAX_COUNTER) {
      this.physical = maxPhysical + 1;
      this.counter = 0;
    } else {
      this.physical = maxPhysical;
    }
  }

  /** Current persisted state — store this and pass back as `last` on restart. */
  getState(): string {
    return encodeHlc({ physical: this.physical, counter: this.counter, deviceId: this.deviceId });
  }
}
