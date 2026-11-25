/**
 * Angler renderer.
 *
 * The tank is seen side-on, with depth faked the pixel way: fish further back
 * are smaller and hazier, every fish throws a shadow on the sand, weed and
 * bubbles pass in front of the glass, and light ripples over the floor.
 *
 * The pond is seen from above, like Wayfinder's sea and Task Force's skies:
 * each project's pond in its own biome, fish as voxel sprite stacks (shadows
 * under the water, the real fish when it surfaces), the angler as a voxel model
 * on the dock. Static scenery is baked into one image per scene and size.
 */

import { hudFrame, type PixelHud } from "../pixel/hud";
import { clamp, lerpHex } from "../pixel/kinds";
import { INK, PixelPainter, type AtlasHandle, type PixelBackend } from "../pixel/painter";
import { BAYER, BIOMES, hash2 } from "../pixel/terrain";
import { ANGLER_MODEL, TACKLE_MODEL, fishModel } from "./models";
import { MATCH, SPECIES, TANK_MAX, lakeInside, type AnglerSim, type FishSpec, type Rect, type Swimmer } from "./sim";
import { fishPixels } from "./sprites";

interface Sprite<Img> {
  img: [Img, Img];
  w: number;
  h: number;
}

interface Weed {
  x: number;
  segs: number;
  phase: number;
  c: string;
  leaf: string;
  /** Front-of-glass weed: thicker, darker, drawn over the fish. */
  front: boolean;
}

const TANK_WATER = "#1d5f8e";

function hexBytes(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A little RGBA canvas for baking scenery. */
class Bake {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number) {
    this.px = new Uint8Array(w * h * 4);
  }
  put(x: number, y: number, c: string, a = 255): void {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b] = hexBytes(c);
    const o = (y * this.w + x) * 4;
    const k = a / 255, inv = 1 - k;
    this.px[o] = Math.round(r * k + this.px[o] * inv);
    this.px[o + 1] = Math.round(g * k + this.px[o + 1] * inv);
    this.px[o + 2] = Math.round(b * k + this.px[o + 2] * inv);
    this.px[o + 3] = Math.max(this.px[o + 3], a);
  }
  rect(x: number, y: number, w: number, h: number, c: string, a = 255): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.put(xx, yy, c, a);
  }
  /** Vertical gradient through `stops`, dithered. */
  grad(y0: number, y1: number, stops: string[]): void {
    const n = Math.max(1, y1 - y0);
    for (let y = y0; y < y1; y++) {
      const f = ((y - y0) / n) * (stops.length - 1);
      for (let x = 0; x < this.w; x++) {
        const i = Math.min(stops.length - 2, Math.floor(f));
        const k = f - i;
        const d = BAYER[(y & 3) * 4 + (x & 3)];
        this.put(x, y, lerpHex(stops[i], stops[i + 1], Math.round(k * 4 + d - 0.5) / 4));
      }
    }
  }
  /** A lit blob: light on the top-left, shade on the bottom-right. */
  blob(cx: number, cy: number, rx: number, ry: number, c: string, shade: string, a = 255, lit?: string): void {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy > 1) continue;
        const k = dx + dy;
        this.put(x, y, k > 0.5 ? shade : lit && k < -0.7 ? lit : c, a);
      }
    }
  }
}

export class AnglerRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: AnglerSim;
  private readonly sprites = new Map<string, Sprite<Img>>();
  private readonly atlases = new Map<string, AtlasHandle<Img>>();
  private readonly anglerAtlas: AtlasHandle<Img>;
  private readonly tackleAtlas: AtlasHandle<Img>;
  private tankBg: Img | null = null;
  private rays: Img | null = null;
  private pondBg: Img | null = null;
  private weeds: Weed[] = [];
  private bakedFor = "";
  private pondFor = "";

  constructor(backend: PixelBackend<Img, Frame>, sim: AnglerSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.anglerAtlas = this.makeAtlas(ANGLER_MODEL);
    this.tackleAtlas = this.makeAtlas(TACKLE_MODEL);
  }

  override resize(width: number, height: number, hud?: PixelHud): void {
    this.sim.resize(width, height, hud);
    super.resize(width, height);
  }

  /** The side-on sprite for the tank; `far` is a smaller one for the back of the tank. */
  private fishSprite(f: FishSpec, far = false): Sprite<Img> {
    const key = far ? `${f.id}|far` : f.id;
    let s = this.sprites.get(key);
    if (!s) {
      const g = far ? { ...f, size: Math.max(6, Math.round(f.size * 0.72)) } : f;
      const r = fishPixels(g), l = fishPixels(g, true);
      s = { img: [this.makeImage(r.w, r.h, r.pixels), this.makeImage(l.w, l.h, l.pixels)], w: r.w, h: r.h };
      this.sprites.set(key, s);
    }
    return s;
  }

  /** The voxel fish for the pond and the catch card. */
  private fishAtlas(f: FishSpec): AtlasHandle<Img> {
    let a = this.atlases.get(f.id);
    if (!a) {
      a = this.makeAtlas(fishModel(f));
      this.atlases.set(f.id, a);
      if (this.atlases.size > 40) this.atlases.delete(this.atlases.keys().next().value!);
    }
    return a;
  }

  // ── Baking ──────────────────────────────────────────────────────────────

  private bakeTank(): void {
    const s = this.sim;
    const key = `${s.W}x${s.H}:${s.sandY}:${s.tankBox.y}`;
    if (key === this.bakedFor) return;
    this.bakedFor = key;
    const W = s.W, H = s.H;

    const t = new Bake(W, H);
    const top = s.tankBox.y - 6;
    t.grad(0, top, ["#0c1a2a", "#16324a"]);
    t.grad(top, H, ["#3b9cc8", "#2479a8", "#164f7e", "#0e3156"]);
    for (let x = 0; x < W; x++) t.put(x, top, "#bfe9f7", 200);
    for (let x = 0; x < W; x++) t.put(x, top + 1, "#7fcde8", 120);
    // The back wall: dark, hazy plants far away.
    for (let i = 0; i < 9; i++) {
      const bx = Math.round(hash2(i, 1, 41) * W), bh = 14 + Math.round(hash2(i, 2, 41) * 30);
      t.blob(bx, s.sandY - 10, 5 + hash2(i, 3, 41) * 6, bh, "#1a5068", "#164558", 150);
    }
    // The floor slopes away: the far sand is higher, bluer and darker.
    const sand = s.sandY - 3;
    for (let y = sand - 10; y < H; y++) {
      const wav = Math.round(Math.sin(y * 0.7) * 1.5);
      for (let x = 0; x < W; x++) {
        const edge = sand + Math.round(Math.sin(x * 0.09) * 2 + Math.sin(x * 0.23) * 1);
        const back = edge - 10 + Math.round(Math.sin(x * 0.05 + 2) * 2);
        if (y < back) continue;
        if (y < edge) {
          t.put(x, y, BAYER[(y & 3) * 4 + (x & 3)] > (y - back) / 10 ? "#5f7f8a" : "#8a9c94");
          continue;
        }
        const n = hash2(x, y, 7);
        const ripple = (x + wav * 3 + y * 2) % 11 === 0;
        t.put(x, y, n > 0.92 ? "#b39a68" : ripple ? "#c9ae78" : y - edge < 2 ? "#e8d4a0" : "#d8c08a");
      }
    }
    const PEB = ["#8a8f9c", "#a8786a", "#6f8a6a", "#c4b8a0", "#5f6a80"];
    for (let i = 0; i < Math.round(W / 6); i++) {
      const x = Math.round(hash2(i, 9, 3) * W), y = sand + 4 + Math.round(hash2(i, 8, 3) * (H - sand - 6));
      t.rect(x, y, 2, 2, PEB[i % PEB.length]);
      t.put(x + 1, y + 1, "#2a2a34", 120);
    }
    // Rocks and a stone cairn, with contact shadows on the sand.
    t.blob(W * 0.2 + 3, s.sandY + 5, 14, 3, "#0a2a3a", "#0a2a3a", 70);
    t.blob(W * 0.2, s.sandY + 1, 13, 8, "#6f7a8c", "#4f586a", 255, "#9aa4b4");
    t.blob(W * 0.27, s.sandY + 3, 7, 5, "#7f8a9a", "#5a6476", 255, "#a8b2c0");
    const cx = Math.round(W * 0.74);
    t.blob(cx + 3, s.sandY + 5, 13, 3, "#0a2a3a", "#0a2a3a", 70);
    [[11, 4], [9, 3.5], [7, 3], [5, 2.5]].forEach(([rx, ry], i) => {
      t.blob(cx + (i % 2 ? 1 : -1), s.sandY + 1 - i * 6.5, rx, ry, ["#9aa2b0", "#a89a88", "#8a96a8", "#b0a898"][i], "#5f6878", 255, "#d0d6de");
    });
    // The glass: a bright edge down each side and a frame along the top.
    for (let y = top; y < H; y++) {
      t.put(0, y, "#d8f4ff", 90);
      t.put(1, y, "#d8f4ff", 40);
      t.put(W - 1, y, "#0a1a2a", 120);
    }
    t.rect(0, top - 3, W, 2, "#2a3a4a");
    t.rect(0, top - 3, W, 1, "#5a6a7a");
    this.tankBg = this.makeImage(W, H, t.px);

    // Light from above: soft diagonal bands, faded in and out per frame.
    const r = new Bake(W, H);
    for (let i = 0; i < 4; i++) {
      const x0 = hash2(i, 4, 77) * W, wid = 6 + hash2(i, 5, 77) * 10;
      for (let y = top; y < s.sandY; y++) {
        const k = 1 - (y - top) / (s.sandY - top);
        for (let x = 0; x < wid; x++) r.put(x0 + x + (y - top) * 0.35, y, "#d8f4ff", Math.round(34 * k));
      }
    }
    this.rays = this.makeImage(W, H, r.px);

    const n = Math.max(5, Math.round(W / 34));
    this.weeds = Array.from({ length: n }, (_, i) => {
      const k = hash2(i, 11, 5);
      return {
        x: Math.round(((i + 0.5) / n) * W + (hash2(i, 12, 5) - 0.5) * 18),
        segs: 7 + Math.round(k * 12),
        phase: k * 6,
        c: k > 0.66 ? "#3f9a4a" : k > 0.33 ? "#2f7f52" : "#5aa83a",
        leaf: k > 0.5 ? "#7fd05a" : "#4fb86a",
        front: false,
      };
    });
    // Two tall blades right against the glass, at the edges where they don't hide much.
    for (const [x, segs] of [[6, 22], [W - 9, 18]] as const) {
      this.weeds.push({ x, segs, phase: x * 0.1, c: "#1f5a3a", leaf: "#2f7a4a", front: true });
    }
  }

  /** The pond from above: banks in the project's biome, the water darkening with depth, the dock. */
  private bakePond(): void {
    const s = this.sim;
    const l = s.lake;
    const biome = s.biome;
    const key = `${s.W}x${s.H}:${l.cx},${l.cy},${l.rx},${l.ry},${l.seed}:${biome}`;
    if (key === this.pondFor) return;
    this.pondFor = key;
    const W = s.W, H = s.H;
    const B = BIOMES[biome];
    const p = new Bake(W, H);
    const seed = l.seed % 997;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = lakeInside(l, x, y);
        const d = BAYER[(y & 3) * 4 + (x & 3)];
        const n = hash2(x >> 1, y >> 1, seed);
        if (v < 0) {
          // Land: a beach ring, then the biome's ground, speckled.
          const band = v > -0.07 ? B.bands[0] : B.bands[1];
          const i = n > 0.8 ? 2 : n < 0.25 ? 0 : 1;
          p.put(x, y, band[(i + (d > 0.85 ? 1 : 0)) % 3]);
          continue;
        }
        // Water: foam at the edge, then shallow to deep.
        const depth = clamp(v * 2.2 + (d - 0.5) * 0.12, 0, 0.999);
        p.put(x, y, v < 0.015 ? B.water[4] : B.water[3 - Math.floor(depth * 4)] ?? B.water[0]);
      }
    }
    // Lily pads (or ice floes, or rocks) floating near the banks.
    const floaty = biome === "tundra" ? ["#e6f2ff", "#b8c8dc"] : biome === "volcano" ? ["#3a3436", "#231e20"] : ["#5cb83a", "#3f8f2e"];
    for (let i = 0; i < 9; i++) {
      const a = hash2(i, 1, seed) * Math.PI * 2;
      const r = 0.68 + hash2(i, 2, seed) * 0.18;
      const x = l.cx + Math.cos(a) * l.rx * r * 0.9, y = l.cy + Math.sin(a) * l.ry * r * 0.9;
      if (Math.abs(x - s.angler.x) < 16 && y > l.cy) continue;
      const rad = 2.5 + hash2(i, 3, seed) * 2;
      p.blob(x + 1, y + 1, rad, rad * 0.8, "#06122a", "#06122a", 70);
      p.blob(x, y, rad, rad * 0.8, floaty[0], floaty[1]);
      if (biome !== "volcano" && biome !== "tundra") p.put(x + 1, y, B.water[2]);
      if (i % 3 === 0 && biome === "tropic") p.put(x - 1, y - 1, "#f4a8c8");
    }
    // Trees (and rocks) on the banks, lit from the top-left with shadows down-right.
    // Denser further from the water, so the pond sits in a clearing.
    for (let i = 0; i < Math.round((W * H) / 700); i++) {
      const x = hash2(i, 5, seed) * W, y = hash2(i, 6, seed) * H;
      const v = lakeInside(l, x, y);
      if (v > -0.1 || (Math.abs(x - s.angler.x) < 14 && y > s.angler.y) || hash2(i, 8, seed) < 0.35 + v * 1.5) continue;
      const big = 4 + hash2(i, 7, seed) * 5 + Math.min(4, -v * 8);
      p.blob(x + 3, y + 3, big, big * 0.8, "#06122a", "#06122a", 90);
      if (i % 4 === 0) p.blob(x, y, big * 0.7, big * 0.55, B.bands[3][1], B.bands[3][0], 255, B.bands[3][2]);
      else p.blob(x, y, big, big * 0.85, B.tree[1], B.tree[0], 255, lerpHex(B.tree[1], "#ffffff", 0.2));
    }
    // The dock: planks from the bank to the angler, posts, and its shadow on the water.
    const dx0 = s.angler.x - 6, dx1 = s.angler.x + 6, dy0 = s.angler.y - 6, dy1 = Math.min(H, s.dockFoot + 6);
    p.rect(dx1, dy0 + 3, 3, dy1 - dy0, "#06122a", 70);
    for (let y = dy0; y < dy1; y++) {
      const plank = ((y - dy0) >> 2) % 2;
      for (let x = dx0; x < dx1; x++) p.put(x, y, (y - dy0) % 4 === 3 ? "#5a3a22" : plank ? "#9a6a3a" : "#a8763f");
      p.put(dx0, y, "#6a4424");
      p.put(dx1 - 1, y, "#4a2e1a");
    }
    for (const [x, y] of [[dx0 - 1, dy0], [dx1, dy0], [dx0 - 1, dy0 + 16], [dx1, dy0 + 16]]) p.rect(x, y, 2, 2, "#3a2414");
    this.pondBg = this.makeImage(W, H, p.px);
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  draw(): Frame {
    const s = this.sim;
    if (s.state === "tank") {
      this.bakeTank();
      this.drawTank();
    } else {
      this.bakePond();
      this.drawPond();
    }
    for (const p of s.parts) this.px(p.x, p.y, p.c, 1, clamp(p.life / 20, 0, 1));
    return this.snapshot();
  }

  private button(r: Rect, label: string, fg: string, bg: string, on = true): void {
    this.rect(r.x, r.y + 1, r.w, r.h, INK, 0.6);
    this.rect(r.x, r.y, r.w, r.h, on ? bg : "#2a3048");
    this.rect(r.x + 1, r.y + 1, r.w - 2, 1, "#ffffff", 0.25);
    this.strokeRect(r.x, r.y, r.w, r.h, on ? fg : "#4a5068");
    this.textC(label, r.x + r.w / 2, r.y + Math.round((r.h - 5) / 2), on ? fg : "#7a8098");
  }

  // ── The tank ────────────────────────────────────────────────────────────

  /** A tank fish: smaller and hazier the further back, narrowing as it turns round. */
  private drawSwimmer(sw: Swimmer, bob: number, alpha: number): void {
    const far = sw.z > 0.55;
    const sp = this.fishSprite(sw.spec, far);
    const p = sw.turn / 12;
    const face = p > 0.5 ? -sw.face : sw.face;
    const img = sp.img[face > 0 ? 0 : 1];
    const x = Math.round(sw.x - sp.w / 2), y = Math.round(sw.y - sp.h / 2) + bob;
    if (sw.turn > 0) {
      const dw = Math.max(2, Math.round(sp.w * Math.abs(2 * p - 1)));
      this.imageRect(img, 0, 0, sp.w, sp.h, Math.round(sw.x - dw / 2), y, dw, sp.h, alpha);
    } else this.image(img, x, y, alpha);
    // Water between the fish and the glass.
    const haze = sw.z * 0.5;
    if (haze > 0.05 && sw.turn === 0) this.tintedImage(img, x, y, TANK_WATER, haze * alpha);
  }

  private drawTank(): void {
    const s = this.sim, t = s.t, W = s.W;
    const f = hudFrame(s.hud, W, s.H);
    if (this.tankBg) this.image(this.tankBg, 0, 0);
    if (this.rays) this.image(this.rays, 0, 0, s.calm ? 0.7 : 0.6 + 0.4 * Math.sin(t * 0.013));

    const top = s.tankBox.y - 6;
    for (let i = 0; i < 6; i++) this.rect(Math.round((i * 53 + t * 0.3) % (W + 20)) - 10, top + (i & 1), 5, 1, "#ffffff", 0.5);

    // Light rippling over the sand.
    for (let i = 0; i < 14; i++) {
      const x = Math.round((hash2(i, 3, 19) * W + (s.calm ? 0 : Math.sin(t * 0.02 + i) * 6) + W) % W);
      const y = s.sandY + 1 + Math.round(hash2(i, 4, 19) * 12);
      const a = s.calm ? 0.25 : 0.15 + 0.2 * Math.max(0, Math.sin(t * 0.04 + i * 1.7));
      this.rect(x, y, 3 + (i % 3), 1, "#fff8d8", a);
    }

    this.drawWeeds(false);

    // Back to front, each with its shadow on the sand below it.
    const order = [...s.swimmers].sort((a, b) => b.z - a.z);
    for (const sw of order) {
      if (sw.enter > 0 || sw.leaving) continue;
      const floor = s.sandY - 1 - Math.round(sw.z * 8);
      const hgt = clamp((floor - sw.y) / Math.max(1, s.tankBox.h), 0, 1);
      const w = Math.max(2, Math.round(sw.spec.size * (0.9 - sw.z * 0.3) * (1 - hgt * 0.4)));
      this.rect(Math.round(sw.x - w / 2), floor, w, 2, "#0a2a3a", 0.35 * (1 - hgt) + 0.05);
    }

    // Bubbles from the cairn and the rocks.
    const range = s.sandY - top - 4;
    for (let k = 0; k < 10; k++) {
      const src = k < 6 ? W * 0.74 : W * 0.2;
      const yy = s.sandY - 20 - ((t * (0.35 + (k % 3) * 0.1) + k * 37) % range);
      const xx = src + Math.sin((t + k * 40) * 0.06) * 2 + (k % 3) - 1;
      this.circle(Math.round(xx), Math.round(yy), k % 4 === 0 ? 2 : 1, "#d8f4ff", 0.7, true);
    }

    for (const sw of order) {
      const bob = s.calm ? 0 : Math.round(Math.sin(t * 0.07 + sw.spec.seed) * 0.6);
      const alpha = sw.leaving ? clamp(1 - sw.leaving / 140, 0, 1) : 1;
      this.drawSwimmer(sw, bob, alpha);
      if (sw.leaving && sw.why && sw.leaving < 100) this.textC(sw.why, Math.round(sw.x), Math.round(sw.y - sw.spec.size / 2 - 9), "#fff2a0");
      if (sw === s.selected) {
        const sp = this.fishSprite(sw.spec, sw.z > 0.55);
        this.strokeRect(Math.round(sw.x - sp.w / 2) - 2, Math.round(sw.y - sp.h / 2) - 2 + bob, sp.w + 4, sp.h + 4, "#fff2a0", 0.6 + 0.4 * Math.sin(t * 0.2));
      }
    }

    // In front of the glass: tall weed and a few big bubbles drifting up.
    this.drawWeeds(true);
    if (!s.calm) {
      for (let k = 0; k < 2; k++) {
        const yy = s.sandY - ((t * 0.6 + k * 170) % (s.sandY - top));
        this.circle(Math.round(W * (0.12 + k * 0.7) + Math.sin(t * 0.05 + k) * 3), Math.round(yy), 3, "#ffffff", 0.45, true);
      }
    }

    // HUD.
    this.rect(0, 0, W, f.top.y + 12, INK, 0.35);
    this.text(`TANK ${s.tank.length}/${TANK_MAX}`, f.top.lx, f.top.y, "#c7e4ff");
    const pts = `${s.tankValue} PTS`;
    this.text(pts, f.top.rx - pts.length * 4 + 1, f.top.y, "#fff2a0");
    if (s.best > 0) this.textC(`BEST ${s.best}`, f.top.cx, f.top.y, "#8b98bc", 1, null);

    if (!s.tank.length && !s.swimmers.length) {
      const cy = Math.round(s.tankBox.y + s.tankBox.h * 0.35);
      this.textC("AN EMPTY TANK", f.content.cx, cy, "#ffffff", 2);
      this.textC("CATCH YOUR TASKS AND NOTES", f.content.cx, cy + 16, "#c7e4ff");
      this.textC("AND KEEP THE ONES YOU LIKE", f.content.cx, cy + 24, "#c7e4ff");
    }

    if (s.banner) {
      const a = clamp(Math.min(s.banner.t / 12, (260 - s.banner.t) / 30), 0, 1);
      const by = s.tankBox.y + 6;
      this.rect(f.content.lx + 4, by - 3, f.content.rx - f.content.lx - 8, 20, INK, 0.7 * a);
      this.textC(s.banner.text, f.content.cx, by, "#fff2a0", 1, null);
      this.textC(s.banner.sub, f.content.cx, by + 8, "#a8f4e8", 1, null);
    }

    if (s.selected && !s.selected.leaving) this.drawInfo(s.selected.spec);

    const pulse = s.calm ? 0 : Math.round(Math.sin(t * 0.1));
    this.button({ ...s.goBtn, y: s.goBtn.y + pulse }, "GO FISH", "#fff2a0", "#2a6fa8");
    if (s.inputMode === "pointer") this.textC("SPACE TO FISH  ARROWS PICK A FISH", f.bottom.cx, s.goBtn.y - 9, "#8b98bc", 1, null);
  }

  private drawWeeds(front: boolean): void {
    const s = this.sim, t = s.t;
    for (const w of this.weeds) {
      if (w.front !== front) continue;
      const thick = front ? 3 : 2;
      for (let i = 0; i < w.segs; i++) {
        const sway = s.calm ? 0 : Math.sin(t * (front ? 0.025 : 0.03) + w.phase + i * 0.4) * i * (front ? 0.45 : 0.32);
        const x = Math.round(w.x + sway), y = (front ? s.H : s.sandY + 2) - i * (front ? 4 : 3);
        this.rect(x, y - (front ? 4 : 3), thick, front ? 5 : 4, w.c);
        if (i % 3 === 2) this.rect(x + (i % 2 ? thick : -2), y - 2, 2, 2, w.leaf);
      }
    }
  }

  /** The panel for a picked fish: what it is, and a button to let it go. */
  private drawInfo(f: FishSpec): void {
    const s = this.sim;
    const fr = hudFrame(s.hud, s.W, s.H);
    const w = Math.min(200, fr.content.rx - fr.content.lx - 8);
    const x = Math.round(fr.content.cx - w / 2), y = s.letGoBtn.y - 28;
    this.rect(x, y, w, 44, INK, 0.82);
    this.strokeRect(x, y, w, 44, f.accent);
    const chars = Math.floor((w - 8) / 4);
    this.text(PixelPainter.clip(f.title, chars), x + 4, y + 4, "#ffffff");
    const what = `${SPECIES[f.species].name} · ${f.kg} KG · ${f.pts} PTS`;
    this.text(PixelPainter.clip(what, chars), x + 4, y + 12, "#c7e4ff");
    this.text(PixelPainter.clip(`${f.kind === "task" ? "TASK" : "NOTE"} IN ${f.project}`, chars), x + 4, y + 20, f.accent);
    this.button(s.letGoBtn, s.inputMode === "pointer" ? "LET GO (R)" : "LET GO", "#ffd0c0", "#7a3a3a");
  }

  // ── The pond ────────────────────────────────────────────────────────────

  /** A fish under the water: its shadow, darker the nearer the surface. */
  private underwater(f: FishSpec, x: number, y: number, a: number, depth: number, fade = 1): void {
    const alpha = clamp(0.62 - depth * 0.3, 0.12, 0.62) * fade;
    this.shadow(this.fishAtlas(f), x, y, a, 0, 0, alpha, 1);
  }

  /** A line with a little sag toward the viewer (down the screen), slack lines sagging more. */
  private sagLine(x0: number, y0: number, x1: number, y1: number, sag: number, c: string, alpha = 0.85): void {
    let px = x0, py = y0;
    for (let i = 1; i <= 6; i++) {
      const k = i / 6;
      const nx = Math.round(x0 + (x1 - x0) * k), ny = Math.round(y0 + (y1 - y0) * k + Math.sin(Math.PI * k) * sag);
      this.line(px, py, nx, ny, c, alpha);
      px = nx;
      py = ny;
    }
  }

  private drawPond(): void {
    const s = this.sim, t = s.t, W = s.W;
    const f = hudFrame(s.hud, W, s.H);
    const l = s.lake;
    const B = BIOMES[s.biome];
    const sh = s.shake && !s.calm ? Math.round(Math.sin(t * 1.7) * Math.min(3, s.shake / 3)) : 0;
    if (this.pondBg) this.image(this.pondBg, sh, 0);

    // Glints drifting across the water.
    if (!s.calm) {
      for (let i = 0; i < 10; i++) {
        const x = Math.round(l.cx - l.rx + ((hash2(i, 1, 5) * l.rx * 2 + t * 0.15) % (l.rx * 2)));
        const y = Math.round(l.cy - l.ry + hash2(i, 2, 5) * l.ry * 1.6);
        if (lakeInside(l, x, y) > 0.05) this.rect(x, y, 3, 1, B.water[4], 0.25 + 0.25 * Math.sin(t * 0.05 + i));
      }
    }
    for (const r of s.ripples) {
      const k = r.t / r.max;
      this.circle(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(2 + k * r.max * 0.35)), B.water[4], 0.7 * (1 - k), true);
    }

    for (const sd of s.shadows) this.underwater(sd.spec, sd.x, sd.y, sd.a, sd.depth, sd.flee ? clamp(1 - sd.flee / 80, 0, 1) : 1);

    const tip = s.rodTip();
    const h = s.hooked;
    if (h) {
      // Tired, it surfaces: the real fish, wallowing.
      if (h.depth < 0.15) {
        this.shadow(this.fishAtlas(h.spec), h.x, h.y, h.a, 1, 2, 0.4);
        this.stack(this.fishAtlas(h.spec), h.x, h.y, h.a + Math.sin(t * 0.3) * 0.15);
      } else this.underwater(h.spec, h.x, h.y, h.a + Math.sin(t * 0.4) * 0.1, h.depth);
    }

    // The angler and the tackle box.
    const a = s.angler;
    this.shadow(this.tackleAtlas, a.x - 9, a.y + 4, 0, 1, 2, 0.35);
    this.stack(this.tackleAtlas, a.x - 9, a.y + 4, 0.2);
    this.shadow(this.anglerAtlas, a.x, a.y, s.rodAng, 2, 3, 0.35);
    this.stack(this.anglerAtlas, a.x, a.y, s.rodAng);

    // The rod, raised off the angler's hands.
    const hx = Math.round(a.x + Math.cos(s.rodAng) * 3), hy = Math.round(a.y - 5 + Math.sin(s.rodAng) * 3);
    this.line(hx, hy, tip.x, tip.y, "#5a3418");
    this.line(hx + 1, hy, Math.round((hx + tip.x) / 2) + 1, Math.round((hy + tip.y) / 2), "#7a4a24");
    this.px(tip.x, tip.y, "#f4e8c0");

    if (s.bobber) {
      const b = s.bobber;
      let bx = b.x, by = b.y, lift = 0;
      if (b.fly < 26) {
        const p = b.fly / 26;
        bx = b.fx + (b.x - b.fx) * p;
        by = b.fy + (b.y - b.fy) * p;
        lift = Math.sin(Math.PI * p) * 22;
        this.rect(Math.round(bx) - 1, Math.round(by), 3, 1, "#06122a", 0.4);
      }
      const dip = Math.round(b.dip);
      this.sagLine(tip.x, tip.y, Math.round(bx), Math.round(by - lift), 3, "#f4f4f4", 0.6);
      const bob = s.calm || lift ? 0 : Math.round(Math.sin(t * 0.1) * 0.6);
      if (dip < 4) {
        this.rect(Math.round(bx) - 1, Math.round(by - lift) - 2 + bob + dip, 3, 2, "#e83a3a");
        this.rect(Math.round(bx) - 1, Math.round(by - lift) + bob + dip, 3, 1, "#ffffff");
      } else this.circle(Math.round(bx), Math.round(by), 2, "#ffffff", 0.8, true);
      if (s.biteWindow > 0 && (t >> 2) & 1) {
        this.textC("!", Math.round(bx), Math.round(by) - 16, "#fff2a0", 2);
        this.textC(s.inputMode === "pointer" ? "SPACE OR CLICK!" : "TAP!", Math.round(bx), Math.round(by) - 24, "#ffffff");
      }
    }

    if (s.state === "fight" && h) this.drawFight(tip);
    if (s.state === "catch" && s.caught) this.drawCatch(s.caught);

    // HUD.
    if (s.state !== "catch") {
      this.rect(0, 0, W, f.top.y + 13, INK, 0.45);
      this.button(s.tankBtn, "TANK", "#c7e4ff", "#1d3a5a");
      if (s.state !== "fight") {
        this.button(s.spotBtn, "SPOT >", "#c7e4ff", "#1d3a5a");
        const name = PixelPainter.clip(s.spotProject.name, Math.max(4, Math.floor((s.spotBtn.x - s.tankBtn.x - s.tankBtn.w - 8) / 4)));
        this.textC(name, Math.round((s.tankBtn.x + s.tankBtn.w + s.spotBtn.x) / 2), f.top.y + 3, s.spotProject.accent);
      }
      let hint = "";
      if (s.state === "aim") hint = s.inputMode === "pointer" ? "CLICK THE WATER (OR SPACE) TO CAST" : "TAP THE WATER TO CAST";
      else if (s.state === "wait" && s.biteWindow <= 0) hint = s.biter ? "WAIT FOR THE PLUNGE..." : "WAITING FOR A BITE";
      const hy = Math.min(f.bottom.y - 8, s.dockFoot + 2);
      if (hint) {
        this.rect(f.content.lx, hy - 2, f.content.rx - f.content.lx, 9, INK, 0.45);
        this.textC(hint, f.content.cx, hy, "#ffffff", 1, null);
      }
      if (s.spotPool.length === 0 && s.state !== "fight") this.textC("FISHED OUT HERE. TRY ANOTHER SPOT", f.content.cx, l.cy, "#fff2a0");
    }
    if (s.msg) {
      const al = clamp((90 - s.msg.t) / 20, 0, 1);
      this.textC(s.msg.text, f.content.cx, Math.round(f.top.y + 18 - Math.min(4, s.msg.t / 6)), "#fff2a0", 1, al > 0.5 ? INK : null);
    }
  }

  private drawFight(tip: { x: number; y: number }): void {
    const s = this.sim, h = s.hooked!, t = s.t;
    const f = hudFrame(s.hud, s.W, s.H);
    const lineC = h.tension > 0.75 ? ((t >> 2) & 1 ? "#ff5a4a" : "#ffb347") : h.tension > 0.45 ? "#ffe08a" : "#f4f4f4";
    const mx = h.x + Math.cos(h.a) * (h.spec.size / 2), my = h.y + Math.sin(h.a) * (h.spec.size / 2);
    this.sagLine(tip.x, tip.y, Math.round(mx), Math.round(my), (1 - clamp(h.tension, 0, 1)) * 8, lineC);

    // A ring marks the one on the line among the shadows.
    this.circle(Math.round(h.x), Math.round(h.y), Math.round(h.spec.size / 2 + 4), h.spec.accent, 0.45 + 0.2 * Math.sin(t * 0.2), true);
    // Its heading: an arrow ahead of it, and a warning before it turns.
    if (!h.tired) {
      const ax = h.x + Math.cos(h.a) * (h.spec.size / 2 + 7), ay = h.y + Math.sin(h.a) * (h.spec.size / 2 + 7);
      const hx = Math.round(ax + Math.cos(h.a) * 4), hy = Math.round(ay + Math.sin(h.a) * 4);
      this.line(Math.round(ax - Math.cos(h.a) * 3), Math.round(ay - Math.sin(h.a) * 3), hx, hy, "#ffffff", 0.8);
      this.line(hx, hy, Math.round(ax + Math.cos(h.a + 2.4) * 2), Math.round(ay + Math.sin(h.a + 2.4) * 2), "#ffffff");
      this.line(hx, hy, Math.round(ax + Math.cos(h.a - 2.4) * 2), Math.round(ay + Math.sin(h.a - 2.4) * 2), "#ffffff");
      if (h.turnT < 16 && (t >> 1) & 1) this.textC("!", Math.round(h.x), Math.round(h.y - h.spec.size / 2 - 10), "#ffb347");
    } else this.textC("Z", Math.round(h.x + 8), Math.round(h.y - 10 - ((t >> 4) & 1)), "#a8f4e8", 1, null);

    // Around the angler: the way it swims, and whether the rod agrees.
    const a = s.angler;
    const ok = s.match > MATCH;
    if (!h.tired) {
      const gx = Math.round(a.x + Math.cos(h.a) * 22), gy = Math.round(a.y - 5 + Math.sin(h.a) * 22);
      this.circle(Math.round(a.x), Math.round(a.y - 5), 22, ok ? "#7cc46a" : "#ffffff", ok ? 0.3 : 0.12, true);
      this.circle(gx, gy, 3, ok ? "#7cc46a" : "#ffb347", 0.6 + 0.3 * Math.sin(t * 0.3));
    }
    this.circle(tip.x, tip.y, 2, ok || h.tired ? "#7cc46a" : "#ff5a4a", 0.8);

    // Meters across the top: the fish's stamina and the line's strain.
    const bw = Math.min(80, Math.round((f.top.rx - f.top.lx - 50) / 2));
    const bx1 = s.tankBtn.x + s.tankBtn.w + 8, by = f.top.y + 2;
    this.text("FISH", bx1, by - 1, "#c7e4ff");
    this.rect(bx1 + 18, by, bw, 4, INK, 0.7);
    this.rect(bx1 + 18, by, Math.round(bw * clamp(h.stamina, 0, 1)), 4, h.tired ? "#7cc46a" : "#47a3e6");
    const bx2 = bx1 + 18 + bw + 8;
    this.text("LINE", bx2, by - 1, "#c7e4ff");
    const lw = Math.max(10, f.top.rx - bx2 - 18);
    this.rect(bx2 + 18, by, lw, 4, INK, 0.7);
    this.rect(bx2 + 18, by, Math.round(lw * clamp(h.tension, 0, 1)), 4, h.tension > 0.75 ? "#ff5a4a" : h.tension > 0.45 ? "#ffb347" : "#f4f4f4");

    const hint = h.tired
      ? s.inputMode === "pointer" ? "TIRED! HOLD SPACE TO REEL" : "TIRED! HOLD OR CRANK THE REEL"
      : s.inputMode === "pointer" ? "ARROWS: POINT THE WAY IT SWIMS" : "SWIPE THE WAY IT SWIMS";
    if (s.stateT < 240 || h.tired) {
      const hy = f.top.y + 14;
      this.rect(f.content.lx, hy - 2, f.content.rx - f.content.lx, 9, INK, 0.45);
      this.textC(hint, f.content.cx, hy, h.tired && (t >> 3) & 1 ? "#a8f4e8" : "#ffffff", 1, null);
    }

    // The reel pops up in the corner.
    const r = s.reel;
    const k = clamp(s.stateT / 10, 0, 1);
    const rr = Math.max(2, Math.round(r.r * k));
    if (h.tired && !s.calm) this.circle(r.x, r.y, rr + 3 + ((t >> 3) & 1), "#7cc46a", 0.35);
    this.circle(r.x, r.y + 1, rr, INK, 0.5);
    this.circle(r.x, r.y, rr, "#3a4260");
    this.circle(r.x, r.y, rr, s.reeling ? "#fff2a0" : "#c8d0e0", 1, true);
    this.circle(r.x, r.y, Math.max(1, rr - 5), "#5a6488");
    for (let i = 0; i < 3; i++) {
      const ang = s.reelAng + (i * Math.PI * 2) / 3;
      this.line(r.x, r.y, Math.round(r.x + Math.cos(ang) * (rr - 2)), Math.round(r.y + Math.sin(ang) * (rr - 2)), "#9aa6c8");
    }
    this.circle(Math.round(r.x + Math.cos(s.reelAng) * (rr - 3)), Math.round(r.y + Math.sin(s.reelAng) * (rr - 3)), 2, "#e3a23b");
    this.textC("REEL", r.x, r.y - rr - 8, h.tired ? "#7cc46a" : "#8b98bc");
  }

  private drawCatch(fish: FishSpec): void {
    const s = this.sim, t = s.t;
    const c = s.card;
    const p = s.leap;
    const ex = c.x + c.w / 2, ey = c.y + 36;
    const atlas = this.fishAtlas(fish);
    const big = fish.size < 13 ? 3 : 2;
    if (p < 1) {
      // Out of the water and up, spinning, its shadow left on the water.
      const x = s.leapFrom.x + (ex - s.leapFrom.x) * p;
      const gy = s.leapFrom.y + (ey - s.leapFrom.y) * p;
      const lift = Math.sin(Math.PI * Math.min(1, p * 1.2)) * 30;
      this.shadow(atlas, x, gy, t * 0.2, 0, 4, 0.3 * (1 - p));
      this.stack(atlas, x, gy - lift, t * 0.25, { k: Math.max(1, Math.round(1 + (big - 1) * p)) });
      return;
    }
    this.rect(0, 0, s.W, s.H, INK, 0.45);
    this.rect(c.x, c.y + 2, c.w, c.h, INK, 0.6);
    this.rect(c.x, c.y, c.w, c.h, "#10182c");
    this.strokeRect(c.x, c.y, c.w, c.h, fish.accent);
    this.textC("NEW CATCH!", ex, c.y + 5, "#fff2a0");
    // The fish turns slowly on a pool of light.
    this.circle(Math.round(ex), ey + 8, 16, fish.accent, 0.18);
    this.circle(Math.round(ex), ey + 8, 10, "#ffffff", 0.12);
    const spin = s.calm ? 0.6 : t * 0.04;
    this.shadow(atlas, ex, ey + 8, spin, 0, 0, 0.45, big);
    this.stack(atlas, ex, ey + 4, spin, { k: big });
    for (let i = 0; i < 6; i++) {
      const a = t * 0.05 + i;
      if (!s.calm) this.px(ex + Math.cos(a) * (30 + (i % 2) * 6), ey + Math.sin(a) * 14, i % 2 ? "#fff2a0" : "#a8f4e8");
    }
    const chars = Math.floor((c.w - 8) / 4);
    const sp = SPECIES[fish.species];
    let y = c.y + 60;
    this.textC(`${sp.name}  ${fish.kg} KG`, ex, y, fish.accent);
    y += 9;
    const what = fish.kind === "task" ? `TASK · ${(fish.priority ?? "medium").toUpperCase()}${fish.overdue ? " · OVERDUE" : ""}` : "NOTE";
    this.textC(what, ex, y, fish.overdue ? "#ff8a7a" : "#8b98bc", 1, null);
    y += 9;
    for (const ln of PixelPainter.wrap(fish.title, chars).slice(0, 2)) {
      this.textC(ln, ex, y, "#ffffff");
      y += 8;
    }
    this.textC(PixelPainter.clip(fish.project, chars), ex, c.y + 96, "#8b98bc", 1, null);
    this.textC(`+${fish.pts} PTS IN THE TANK`, ex, c.y + 104, "#fff2a0", 1, null);
    const full = s.tankFull;
    this.button(s.keepBtn, full ? "TANK FULL" : "KEEP", "#d8ffd0", "#2f6a3a", !full);
    this.button(s.releaseBtn, "LET GO", "#ffd0c0", "#7a3a3a");
    if (s.inputMode === "pointer") {
      const r = s.catchChoice === 0 ? s.keepBtn : s.releaseBtn;
      this.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4, "#fff2a0", 0.5 + 0.5 * Math.sin(t * 0.2));
    }
  }
}
