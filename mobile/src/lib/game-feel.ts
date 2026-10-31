/**
 * Pure "game feel" helpers shared by the hidden Breakout and Stacker games. Kept free of
 * react-native so they can be unit-tested in plain Node; the components feed them to
 * Reanimated shared values.
 */

/** How hard a hit should feel, escalating with the streak. Mapped to a haptic by the caller. */
export type ComboTier = "tick" | "knock" | "thud" | "flourish";

/**
 * Haptic detent for the nth hit in a row (1-based). A first hit is a light tick; the feel steps
 * up at 3, 5 and 8 so a long streak is felt building without needing the screen.
 */
export function comboTier(streak: number): ComboTier {
  if (streak >= 8) return "flourish";
  if (streak >= 5) return "thud";
  if (streak >= 3) return "knock";
  return "tick";
}

/** Slots in a packed particle buffer: x, y, life (0-1), size, colour index. */
export const PARTICLE_STRIDE = 5;

export interface PackableParticle {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  size: number;
  /** Index into the palette the renderer was given. */
  color: number;
}

/**
 * Packs live particles into a fixed-size flat buffer the UI thread reads one slot per pooled
 * view. Unused slots get life 0 (invisible). Particles beyond `pool` are dropped, oldest kept.
 */
export function packParticles(particles: readonly PackableParticle[], pool: number): number[] {
  const out = new Array<number>(pool * PARTICLE_STRIDE).fill(0);
  const n = Math.min(pool, particles.length);
  for (let i = 0; i < n; i++) {
    const p = particles[i];
    const o = i * PARTICLE_STRIDE;
    out[o] = p.x;
    out[o + 1] = p.y;
    out[o + 2] = p.maxLife > 0 ? Math.max(0, Math.min(1, p.life / p.maxLife)) : 0;
    out[o + 3] = p.size;
    out[o + 4] = p.color;
  }
  return out;
}

/**
 * Pushes the newest point onto a flat [x0, y0, x1, y1, ...] trail (newest first) and keeps at
 * most `max` points. Returns a new array.
 */
export function pushTrail(trail: readonly number[], x: number, y: number, max: number): number[] {
  const next = [x, y, ...trail];
  next.length = Math.min(next.length, max * 2);
  return next;
}

/** A trail seeded with `max` copies of one point, so the first frames don't streak from (0, 0). */
export function seedTrail(x: number, y: number, max: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(x, y);
  return out;
}
