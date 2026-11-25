/**
 * Basecamp renderer — extends PixelPainter for Canvas2D and Skia parity.
 * Draws baked meadow/creek valley ground, Y-sorted stacked voxel props,
 * clockwork dawn-to-night lighting with warm campfire pools & fireflies,
 * Field Log overlay, and responsive Duo/desktop HUD.
 */

import { textWidth } from "../pixel/font";
import { hudFrame } from "../pixel/hud";
import { clamp, lerpHex } from "../pixel/kinds";
import { INK, PixelPainter, type AtlasHandle, type PixelBackend } from "../pixel/painter";
import { fbmSampler, hash2, rgb } from "../pixel/terrain";
import {
  BELL_MODEL,
  BRAMBLE_MODEL,
  BRAZIER_MODEL,
  CAIRN_MODEL,
  CHEST_MODEL,
  HEARTH_MODEL,
  PINE_MODEL,
  RADIO_MODEL,
  SLUICE_MODEL,
  SPARK_MODEL,
  TIMBER_MODEL,
  WARDEN_LIT_MODEL,
  WARDEN_MODEL,
  lodgeModel,
  settlerModel,
} from "./models";
import {
  BELL_POS,
  BRAZIER_REACH,
  CAIRN_POS,
  ENDURE_NIGHTS,
  HEARTH_MAX,
  NIGHT_F,
  WATCH_REACH,
  CHEST_POS,
  CYCLE_FRAMES,
  HEARTH_POS,
  POND_POS,
  RADIO_POS,
  SLUICE_POS,
  WORLD_H,
  WORLD_W,
  type BasecampSim,
  type ClockPhase,
} from "./sim";

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * vx + (py - ay) * vy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function setPx(buf: Uint8Array, i: number, c: [number, number, number]): void {
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = 255;
}

/** Warm wash over the valley at dawn and dusk. Night is drawn as darkness with light pools instead. */
function phaseTint(cycleTick: number): { color: string; alpha: number } {
  const f = (cycleTick % CYCLE_FRAMES) / CYCLE_FRAMES;
  if (f < 0.1) return { color: "#e88a68", alpha: 0.16 * (1 - f / 0.1) };
  if (f < 0.45) return { color: "#ffffff", alpha: 0 };
  if (f < NIGHT_F) return { color: "#d96b27", alpha: 0.22 * ((f - 0.45) / (NIGHT_F - 0.45)) };
  return { color: "#ffffff", alpha: 0 };
}

/** How dark the night is (0…1): falls in at nightfall, lifts before dawn. */
function nightDepth(cycleTick: number): number {
  const f = (cycleTick % CYCLE_FRAMES) / CYCLE_FRAMES;
  if (f < NIGHT_F - 0.04) return 0;
  if (f < NIGHT_F + 0.04) return (f - (NIGHT_F - 0.04)) / 0.08;
  if (f > 0.97) return (1 - f) / 0.03;
  return 1;
}

/** Darkness levels the night overlay is quantised to (fewer rects per frame). */
const DARK_STEPS = 6;
const DARK_CELL = 8;

const PHASE_LABEL: Record<ClockPhase, { label: string; col: string }> = {
  dawn: { label: "DAWN", col: "#ffd2a0" },
  noon: { label: "NOON", col: "#fff2a0" },
  dusk: { label: "DUSK", col: "#ff9e44" },
  night: { label: "NIGHT", col: "#8fb8ff" },
};

export class BasecampRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: BasecampSim;
  private readonly warden: AtlasHandle<Img>;
  private readonly wardenLit: AtlasHandle<Img>;
  private readonly hearth: AtlasHandle<Img>;
  private readonly brazier: AtlasHandle<Img>;
  private readonly sluice: AtlasHandle<Img>;
  private readonly bell: AtlasHandle<Img>;
  private readonly radio: AtlasHandle<Img>;
  private readonly cairn: AtlasHandle<Img>;
  private readonly chest: AtlasHandle<Img>;
  private readonly bramble: AtlasHandle<Img>;
  private readonly pine: AtlasHandle<Img>;
  private readonly timber: AtlasHandle<Img>;
  private readonly spark: AtlasHandle<Img>;
  private readonly lodges = new Map<string, [AtlasHandle<Img>, AtlasHandle<Img>]>();
  private readonly settlers = new Map<string, AtlasHandle<Img>>();
  private readonly groundImg: Img;

  constructor(backend: PixelBackend<Img, Frame>, sim: BasecampSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.warden = this.makeAtlas(WARDEN_MODEL);
    this.wardenLit = this.makeAtlas(WARDEN_LIT_MODEL);
    this.hearth = this.makeAtlas(HEARTH_MODEL);
    this.brazier = this.makeAtlas(BRAZIER_MODEL);
    this.sluice = this.makeAtlas(SLUICE_MODEL);
    this.bell = this.makeAtlas(BELL_MODEL);
    this.radio = this.makeAtlas(RADIO_MODEL);
    this.cairn = this.makeAtlas(CAIRN_MODEL);
    this.chest = this.makeAtlas(CHEST_MODEL);
    this.bramble = this.makeAtlas(BRAMBLE_MODEL);
    this.pine = this.makeAtlas(PINE_MODEL);
    this.timber = this.makeAtlas(TIMBER_MODEL);
    this.spark = this.makeAtlas(SPARK_MODEL);

    for (const l of sim.lodges) {
      this.lodges.set(l.id, [
        this.makeAtlas(lodgeModel(l.project.accent, 1)),
        this.makeAtlas(lodgeModel(l.project.accent, 2)),
      ]);
      this.settlers.set(l.id, this.makeAtlas(settlerModel(l.project.accent)));
    }

    this.groundImg = this.bakeGround();
  }

  override resize(width: number, height: number): void {
    this.sim.resize(width, height);
    super.resize(width, height);
  }

  private bakeGround(): Img {
    const buf = new Uint8Array(WORLD_W * WORLD_H * 4);
    const grassA = rgb("#3a7a33");
    const grassB = rgb("#488d3a");
    const grassC = rgb("#2e612a");
    const pathA = rgb("#b88e58");
    const pathB = rgb("#9e7544");
    const stoneA = rgb("#5d667a");
    const creekA = rgb("#2a74d2");
    const creekB = rgb("#47a3e6");
    const creekBank = rgb("#1b3a58");
    const cobbleA = rgb("#8d98ad");
    const flagDark = rgb("#485061");
    const stair = rgb("#6c768a");
    const riser = rgb("#3a4256");
    const plateauShadow = rgb("#232a3c");
    const autumn = rgb("#c98a3b");
    const flowerA = rgb("#fff2a0");
    const flowerB = rgb("#ff9e44");
    const noise = fbmSampler(31);
    const earthTop = rgb("#6b4a2c");
    const earthWall = rgb("#4a3220");
    const lipLight = rgb("#5fa34a");
    const creekAt = (x: number, y: number): number => Math.min(
      distToSegment(x, y, 26, 74, SLUICE_POS.x, SLUICE_POS.y),
      distToSegment(x, y, SLUICE_POS.x, SLUICE_POS.y, 146, 152),
      distToSegment(x, y, 270, 274, POND_POS.x - 16, POND_POS.y - 12),
    );

    const paths: [number, number, number, number][] = [
      [HEARTH_POS.x, HEARTH_POS.y, CAIRN_POS.x, CAIRN_POS.y + 10],
      [HEARTH_POS.x, HEARTH_POS.y, SLUICE_POS.x + 8, SLUICE_POS.y + 8],
      [HEARTH_POS.x, HEARTH_POS.y, BELL_POS.x - 10, BELL_POS.y + 4],
      [HEARTH_POS.x, HEARTH_POS.y, RADIO_POS.x + 12, RADIO_POS.y - 8],
      [HEARTH_POS.x, HEARTH_POS.y, POND_POS.x - 24, POND_POS.y - 18],
    ];

    for (let y = 0; y < WORLD_H; y++) {
      for (let x = 0; x < WORLD_W; x++) {
        const i = (y * WORLD_W + x) * 4;
        const n = noise.at(x * 0.045, y * 0.045);
        const grain = hash2(x, y, 17);
        // Sunken creek channel with 3D north earthen bank, extending toward SE pond
        // The creek only runs through two boxes of the map; skip the distance maths elsewhere.
        const nearCreek = (x < 160 && y > 60 && y < 166) || (x > 256 && x < 324 && y > 260 && y < 320);
        const creekD = nearCreek ? creekAt(x, y) : 99;
        if (creekD < 8.5) {
          // Sunk below the meadow: how far down from the creek's north edge is this pixel?
          let down = 0;
          while (down < 7 && creekAt(x, y - down - 1) < 8.5) down++;
          if (down < 3) setPx(buf, i, down === 0 ? earthTop : earthWall); // the far bank's earth face
          else if (down < 6) setPx(buf, i, creekBank); // water in the bank's shadow
          else setPx(buf, i, grain < 0.35 ? creekB : creekA);
          continue;
        }
        if (creekD < 10.5) {
          // Near (south) lip catches the light; far rim is worn dark.
          const southLip = creekAt(x, y - 3) < 8.5;
          setPx(buf, i, southLip ? (grain < 0.5 ? lipLight : grassB) : grain < 0.45 ? stoneA : grassC);
          continue;
        }

        // Cobbled Hearthfire Plaza
        const hd = Math.hypot(x - HEARTH_POS.x, y - HEARTH_POS.y);
        if (hd < 28) {
          const ring = hd > 19 && hd < 25;
          setPx(buf, i, ring ? ((x + y) % 3 === 0 ? cobbleA : stoneA) : grain < 0.28 ? pathB : pathA);
          continue;
        }

        // Radio Outpost flagstones (SW)
        if (Math.hypot(x - RADIO_POS.x, y - RADIO_POS.y) < 18) {
          setPx(buf, i, (x + y) % 5 === 0 ? flagDark : stoneA);
          continue;
        }

        // Raised 3D stone plateau under the Fifth Cairn with southern cliff riser & steps
        const cd = Math.hypot(x - CAIRN_POS.x, y - CAIRN_POS.y);
        const plateauR = 26 + (n - 0.5) * 8;
        if (cd < plateauR) {
          const onStairs = Math.abs(x - CAIRN_POS.x) <= 5 && y > CAIRN_POS.y + 14;
          const onRiser = y > CAIRN_POS.y + 16 && !onStairs;
          setPx(buf, i, onStairs ? (y % 3 === 0 ? cobbleA : stair) : onRiser ? riser : stoneA);
          continue;
        }
        if (Math.hypot(x - CAIRN_POS.x, y - (CAIRN_POS.y + 4)) < plateauR && y > CAIRN_POS.y + 18) {
          setPx(buf, i, plateauShadow); // ground shadow under plateau cliff
          continue;
        }

        // Dirt footpaths from Hearthfire
        const pathR = 7 + (n - 0.5) * 4;
        const onPath = paths.some(([ax, ay, bx, by]) =>
          x >= Math.min(ax, bx) - 10 && x <= Math.max(ax, bx) + 10 && y >= Math.min(ay, by) - 10 && y <= Math.max(ay, by) + 10 &&
          distToSegment(x, y, ax, ay, bx, by) < pathR);
        if (onPath || Math.hypot(x - HEARTH_POS.x, y - HEARTH_POS.y) < 24) {
          setPx(buf, i, grain < 0.28 ? pathB : pathA);
          continue;
        }

        // Meadow grass bands + autumn Bell Bluff clearing + sparse wildflowers
        const forestEdge = x < 48 || x > WORLD_W - 48 || y < 44 || y > WORLD_H - 44;
        const nearBell = Math.hypot(x - BELL_POS.x, y - BELL_POS.y) < 34;
        if (forestEdge || n < 0.38) {
          setPx(buf, i, grain < 0.14 ? grassA : grassC);
        } else if (nearBell && grain > 0.88) {
          setPx(buf, i, autumn); // autumn leaf scatter around Bell Bluff
        } else if (grain > 0.994 && n > 0.45) {
          setPx(buf, i, grain > 0.997 ? flowerA : flowerB);
        } else if (n > 0.62 || grain < 0.16) {
          setPx(buf, i, grassB);
        } else {
          setPx(buf, i, grassA);
        }
      }
    }
    return this.makeImage(WORLD_W, WORLD_H, buf);
  }

  private drawFlame(cx: number, cy: number, phase: number, scale = 1): void {
    const flick = Math.sin(phase) * 1.4;
    this.circle(cx, cy - 2 * scale, 4.5 * scale, "#ef5a24", 0.9);
    this.circle(cx + flick * 0.4, cy - 4 * scale, 3 * scale, "#ffb347", 0.95);
    this.circle(cx - flick * 0.3, cy - 5 * scale, 1.6 * scale, "#fff2a0", 1);
  }

  draw(): Frame {
    const s = this.sim;
    const W = this.W, H = this.H;
    const jx = s.shake > 0 ? Math.round((hash2(s.t, 1, 3) - 0.5) * s.shake * 2) : 0;
    const jy = s.shake > 0 ? Math.round((hash2(s.t, 2, 3) - 0.5) * s.shake * 2) : 0;
    const cx0 = Math.round(s.camX) + jx;
    const cy0 = Math.round(s.camY) + jy;

    this.clear("#1c331e");
    // Blit visible chunk of baked valley floor
    const srcW = Math.min(W, WORLD_W - cx0);
    const srcH = Math.min(H, WORLD_H - cy0);
    this.imageRect(this.groundImg, cx0, cy0, srcW, srcH, 0, 0, srcW, srcH);

    // Animated creek current glints (faster when sluice is open)
    const flowSpd = s.sluiceOpen ? 0.55 : 0.2;
    for (let i = 0; i < 6; i++) {
      const u = ((s.t * flowSpd + i * 18) % 96) / 96;
      const fx = 30 + u * 90 - cx0;
      const fy = 78 + u * 52 - cy0;
      this.px(fx, fy, "#cfeeff", 1, 0.75);
    }

    // Dynamic South-East Pond & Moonlit Causeway stepping stones
    const px = Math.round(POND_POS.x - cx0);
    const py = Math.round(POND_POS.y - cy0);
    // A hollow in the meadow: the far (north) earth wall shows as a crescent above
    // the water, the water's top edge sits in that wall's shadow, and the near
    // rim catches the light. Drained, the water drops and more wall and mud show.
    const drop = s.sluiceOpen ? 10 : 5;
    this.circle(px, py + 1, 37, "#2e612a", 1); // worn grass rim
    this.circle(px, py, 35, "#4a3220", 1); // earth wall
    this.circle(px, py - 1, 35, "#6b4a2c", 0.5, true); // lit top of the far bank
    if (s.sluiceOpen) this.circle(px, py + drop - 2, 34 - drop + 3, "#3a2a1c", 1); // wet mud
    this.circle(px, py + drop, 35 - drop, s.sluiceOpen ? "#1b3a58" : "#1d5a9e", 1); // water in shadow
    this.circle(px, py + drop + 4, 31 - drop, s.sluiceOpen ? "#2a567a" : "#2a74d2", 1); // open water
    this.circle(px, py + 2, 36, "#5fa34a", 0.35, true); // sunlit near lip
    // Ripple glints
    const rip = (Math.sin(s.t * 0.08) * 3) | 0;
    this.rect(px - 14 + rip, py - 8, 8, 1, "#cfeeff", 0.45);
    this.rect(px - 4 - rip, py + 10, 10, 1, "#cfeeff", 0.45);
    if (s.causewayOpen) {
      // Stepping stones across pond to Chest
      for (let i = 0; i < 4; i++) {
        const sx = px - 22 + i * 11;
        const sy = py - 14 + i * 8;
        this.circle(sx, sy, 6, "#8d98ad", 1);
        this.circle(sx, sy - 1, 4.5, "#b8c4d8", 1);
      }
      this.circle(Math.round(CHEST_POS.x - cx0), Math.round(CHEST_POS.y - cy0), 12, "#8d98ad", 1);
    }

    // Hearthfire cobble ring glow floor
    this.circle(HEARTH_POS.x - cx0, HEARTH_POS.y - cy0, 16, "#8a6842", 0.45);

    // Subtle ground highlight ring under nearby interactive target
    if (s.nearby && s.state === "play") {
      const pulse = 13 + Math.sin(s.t * 0.14) * 2;
      this.circle(s.nearby.x - cx0, s.nearby.y - cy0, pulse, s.nearby.urgent ? "#fff2a0" : "#a8f4e8", 0.55, true);
    }

    // Collect Y-sorted renderables so tall stacked voxel props overlap naturally
    const items: { y: number; draw: () => void }[] = [];
    const addProp = (y: number, draw: () => void) => items.push({ y, draw });

    for (const tr of s.trees) {
      const sx = tr.x - cx0, sy = tr.y - cy0;
      if (sx < -24 || sx > W + 24 || sy < -24 || sy > H + 30) continue;
      const sway = Math.sin(s.t * 0.03 + tr.x * 0.05) * 0.03;
      addProp(tr.y, () => {
        this.shadow(this.pine, sx, sy, sway, 2, 2, 0.3);
        this.stack(this.pine, sx, sy, sway, { outline: true });
      });
    }

    for (const b of s.brambles) {
      if (b.cleared) continue;
      const sx = b.x - cx0, sy = b.y - cy0;
      addProp(b.y, () => {
        this.shadow(this.bramble, sx, sy, 0, 2, 2, 0.35);
        this.stack(this.bramble, sx, sy, Math.sin(s.t * 0.04 + b.x) * 0.05);
      });
    }

    for (const l of s.lodges) {
      const pair = this.lodges.get(l.id);
      if (!pair) continue;
      const atlas = pair[l.level - 1];
      const sx = l.x - cx0, sy = l.y - cy0;
      addProp(l.y, () => {
        this.shadow(atlas, sx, sy, 0, 2, 3, 0.36);
        this.stack(atlas, sx, sy, 0, { outline: true });
        if (l.level === 2) {
          // Cozy smoke puffs above chimney
          const puff = (s.t * 0.25 + l.x) % 16;
          this.circle(sx + 4, sy - 16 - puff * 0.6, 2, "#dce5f7", clamp(1 - puff / 16, 0, 0.55));
        }
      });
    }

    for (const st of s.settlers) {
      const atlas = this.settlers.get(st.lodgeId);
      if (!atlas) continue;
      const sx = st.x - cx0, sy = st.y - cy0;
      addProp(st.y, () => {
        this.shadow(atlas, sx, sy, st.a, 1, 2, 0.3);
        this.stack(atlas, sx, sy + Math.sin(s.t * 0.16 + st.homeX) * 0.7, st.a);
      });
    }

    for (const br of s.braziers) {
      const sx = br.x - cx0, sy = br.y - cy0;
      addProp(br.y, () => {
        this.shadow(this.brazier, sx, sy, 0, 2, 2, 0.35);
        this.stack(this.brazier, sx, sy, 0);
        if (br.lit) this.drawFlame(sx, sy - 7, s.t * 0.24 + br.x, 0.85);
      });
    }

    addProp(SLUICE_POS.y, () => {
      const sx = SLUICE_POS.x - cx0, sy = SLUICE_POS.y - cy0;
      this.shadow(this.sluice, sx, sy, 0, 2, 2, 0.35);
      this.stack(this.sluice, sx, sy, s.sluiceOpen ? 0.12 : 0);
      if (s.sluiceOpen) {
        this.circle(sx, sy - 12, 2.5, "#47a3e6", 0.9);
      }
    });

    addProp(BELL_POS.y, () => {
      const sx = BELL_POS.x - cx0, sy = BELL_POS.y - cy0;
      const swing = s.bellCooldown > 0 ? Math.sin(s.bellCooldown * 0.7) * 0.22 : 0;
      this.shadow(this.bell, sx, sy, swing, 2, 3, 0.35);
      this.stack(this.bell, sx, sy, swing);
    });

    addProp(RADIO_POS.y, () => {
      const sx = RADIO_POS.x - cx0, sy = RADIO_POS.y - cy0;
      this.shadow(this.radio, sx, sy, 0, 2, 3, 0.35);
      this.stack(this.radio, sx, sy, 0);
      if (s.duskBellRung || s.secrets.has("dusk-bell") || (s.t >> 4) % 2 === 0) {
        this.circle(sx, sy - 18, s.secrets.has("dusk-bell") ? 3.5 : 2, s.secrets.has("dusk-bell") ? "#2ec4b6" : "#ff5c44", 0.9);
      }
    });

    addProp(CAIRN_POS.y, () => {
      const sx = CAIRN_POS.x - cx0, sy = CAIRN_POS.y - cy0;
      this.shadow(this.cairn, sx, sy, 0, 2, 3, 0.38);
      this.stack(this.cairn, sx, sy, 0);
      if (s.cairnAwakened) {
        this.circle(sx, sy - 16, 4 + Math.sin(s.t * 0.14), "#a8f4e8", 0.85);
      }
    });

    if (s.causewayOpen && !s.chestOpened) {
      addProp(CHEST_POS.y, () => {
        const sx = CHEST_POS.x - cx0, sy = CHEST_POS.y - cy0;
        this.shadow(this.chest, sx, sy, 0, 2, 2, 0.35);
        this.stack(this.chest, sx, sy, 0);
      });
    }

    for (const p of s.pickups) {
      const sx = p.x - cx0, sy = p.y - cy0 + Math.sin(p.bob) * 1.6;
      const atlas = p.kind === "spark" ? this.spark : this.timber;
      addProp(p.y, () => {
        this.shadow(atlas, sx, p.y - cy0 + 2, s.t * 0.03, 1, 2, 0.3);
        this.stack(atlas, sx, sy, p.kind === "spark" ? s.t * 0.05 : 0.2);
      });
    }

    addProp(HEARTH_POS.y, () => {
      const sx = HEARTH_POS.x - cx0, sy = HEARTH_POS.y - cy0;
      this.shadow(this.hearth, sx, sy, 0, 2, 2, 0.35);
      this.stack(this.hearth, sx, sy, 0);
      this.drawFlame(sx, sy - 5, s.t * 0.22, 1.15);
    });

    addProp(s.warden.y, () => {
      const sx = s.warden.x - cx0;
      const strideBob = Math.abs(Math.sin(s.warden.walkPhase)) * 1.4;
      const sy = s.warden.y - cy0 - strideBob;
      const atlas = s.warden.hasEmber ? this.wardenLit : this.warden;
      this.shadow(atlas, sx, s.warden.y - cy0 + 2, s.warden.a, 2, 2, 0.36);
      this.stack(atlas, sx, sy, s.warden.a);
      if (s.warden.hasEmber) {
        const flick = Math.sin(s.t * 0.3) * 0.25 + 0.75;
        this.circle(sx + Math.cos(s.warden.a) * 4, sy - 9, 2, "#fff2a0", flick);
      }
    });

    items.sort((a, b) => a.y - b.y);
    for (const item of items) item.draw();

    // Dawn and dusk wash
    const tint = phaseTint(s.cycleTick);
    if (tint.alpha > 0.01) {
      this.rect(0, 0, W, H, tint.color, tint.alpha);
    }

    // Night: darkness everywhere the camp's light doesn't reach.
    const depth = nightDepth(s.cycleTick);
    const fire = s.fuel / HEARTH_MAX;
    const lights: [number, number, number][] = [[HEARTH_POS.x, HEARTH_POS.y, 40 + fire * 50]];
    for (const br of s.braziers) if (br.lit) lights.push([br.x, br.y, BRAZIER_REACH + 6]);
    for (const l of s.lodges) if (l.level === 2) lights.push([l.x, l.y, WATCH_REACH + 6]);
    if (s.warden.hasEmber) lights.push([s.warden.x, s.warden.y, 30]);
    else lights.push([s.warden.x, s.warden.y, 16]);
    if (s.cairnAwakened) lights.push([CAIRN_POS.x, CAIRN_POS.y, 60]);
    if (depth > 0.01) this.drawDarkness(cx0, cy0, lights, depth * 0.72);

    // Warm glow at each light's heart
    const warm = 0.08 + depth * 0.3;
    const drawGlow = (wx: number, wy: number, r: number, col = "#ffb347") => {
      const gx = wx - cx0, gy = wy - cy0;
      this.circle(gx, gy, r, col, warm * 0.45);
      this.circle(gx, gy, r * 0.55, "#fff2a0", warm * 0.35);
    };
    drawGlow(HEARTH_POS.x, HEARTH_POS.y, 18 + fire * 26);
    if (s.warden.hasEmber) drawGlow(s.warden.x, s.warden.y - 4, 16);
    for (const br of s.braziers) if (br.lit) drawGlow(br.x, br.y, 22);
    for (const l of s.lodges) if (l.level === 2) drawGlow(l.x, l.y, 16, l.project.accent);
    if (s.cairnAwakened) drawGlow(CAIRN_POS.x, CAIRN_POS.y, 30, "#a8f4e8");

    // The Twilight: violet wisps with a dark core, eyes on their mark.
    for (const w of s.wisps) {
      const wx = Math.round(w.x - cx0), wy = Math.round(w.y - cy0);
      if (wx < -10 || wx > W + 10 || wy < -10 || wy > H + 10) continue;
      const k = 0.45 + w.hp * 0.55;
      this.circle(wx, wy, 7 * k, "#c45aa8", 0.22);
      this.circle(wx, wy, 4.5 * k, "#2a1240", 0.9);
      this.circle(wx, wy - 1, 2.5 * k, "#7a3a9a", 0.9);
      if (((s.t + w.id * 7) >> 3) % 6) {
        this.px(wx - 2, wy - 1, "#ffd2ff");
        this.px(wx + 1, wy - 1, "#ffd2ff");
      }
      const trail = Math.sin(w.wob) * 2;
      this.px(wx + trail, wy + 5, "#c45aa8", 1, 0.6);
    }

    // Rising Hearthfire ember sparks & daytime butterflies
    for (let i = 0; i < 4; i++) {
      const age = (s.t + i * 11) % 36;
      const ex = HEARTH_POS.x - cx0 + Math.sin(s.t * 0.1 + i * 2) * 4;
      const ey = HEARTH_POS.y - cy0 - 7 - age * 0.45;
      this.px(ex, ey, age < 14 ? "#fff2a0" : "#ff9e44", 1, clamp(1 - age / 36, 0, 0.85));
    }
    if (s.phase === "dawn" || s.phase === "noon") {
      for (let i = 0; i < 5; i++) {
        const bx = 130 + i * 45 + Math.sin(s.t * 0.04 + i * 2.1) * 14 - cx0;
        const by = 140 + ((i * 57) % 160) + Math.cos(s.t * 0.06 + i) * 8 - cy0;
        if ((s.t + i) % 6 < 3) this.px(bx, by, i % 2 ? "#fff2a0" : "#a8f4e8", 2, 0.85);
      }
    }

    // Drifting fireflies during dusk & night
    if (s.phase === "dusk" || s.phase === "night" || s.auroraTimer > 0) {
      for (let i = 0; i < 14; i++) {
        const fx = ((hash2(i, 1, 9) * WORLD_W + Math.sin(s.t * 0.02 + i * 1.7) * 18) - cx0);
        const fy = ((hash2(i, 2, 9) * WORLD_H + Math.cos(s.t * 0.024 + i * 2.1) * 14) - cy0);
        const pulse = 0.35 + 0.55 * Math.sin(s.t * 0.1 + i * 2.3);
        if (pulse > 0.25) {
          this.px(fx, fy, s.auroraTimer > 0 ? "#a8f4e8" : "#fff2a0", 2, pulse);
        }
      }
    }

    // Sound rings & particles
    for (const r of s.rings) {
      this.circle(r.x - cx0, r.y - cy0, r.r, r.color, clamp(r.life / 45, 0, 0.85), true);
    }
    for (const p of s.particles) {
      this.px(p.x - cx0, p.y - cy0, p.color, 2, clamp(p.life / p.maxLife, 0, 1));
    }

    // Walk waypoint / touch thumbstick indicator
    if (s.dragOrigin && s.dragCurrent && s.state === "play") {
      this.circle(s.dragOrigin.x, s.dragOrigin.y, 12, "#ffffff", 0.22, true);
      this.circle(s.dragCurrent.x, s.dragCurrent.y, 5, "#fff2a0", 0.55);
    } else if (s.walkTarget && s.state === "play") {
      this.circle(s.walkTarget.x - cx0, s.walkTarget.y - cy0, 5 + Math.sin(s.t * 0.2), "#a8f4e8", 0.6, true);
    }

    // Project Lodge names + Settler speech bubbles + Nearby prompt label
    if (s.state === "play") {
      for (const l of s.lodges) {
        const lx = l.x - cx0, ly = l.y - cy0;
        const name = PixelPainter.clip(l.project.name, 11);
        const tagColor = l.level === 2 ? "#fff2a0" : lerpHex(l.project.accent, "#ffffff", 0.35);
        this.textC(name, lx, ly - (l.level === 2 ? 22 : 18), tagColor);
      }

      for (const st of s.settlers) {
        if (st.sayTimer <= 0 || !st.say) continue;
        const sx = Math.round(st.x - cx0), sy = Math.round(st.y - cy0 - 20);
        const msg = PixelPainter.clip(st.say, 26);
        const bw = textWidth(msg) + 6;
        const bx = clamp(sx - Math.round(bw / 2), 4, W - bw - 4);
        this.rect(bx, sy - 2, bw, 9, INK, 0.85);
        this.strokeRect(bx, sy - 2, bw, 9, st.accent);
        this.text(msg, bx + 3, sy, "#ffffff", 1, null);
      }

      // Show bramble task title when close
      if (s.nearby?.kind === "bramble") {
        const b = s.brambles.find((item) => item.id === s.nearby?.id);
        if (b) {
          const msg = PixelPainter.clip(b.title, 20);
          const bx = Math.round(b.x - cx0);
          const by = Math.round(b.y - cy0 - 24);
          this.textC(msg, clamp(bx, 48, W - 48), clamp(by, 24, H - 30), "#ffd2c2");
        }
      }
    }

    // Floating pops
    for (const pop of s.pops) {
      this.textC(pop.text, Math.round(pop.x - cx0), Math.round(pop.y - cy0), pop.color);
    }

    // Drifting clouds + ground shadows in world space
    for (let i = 0; i < 5; i++) {
      const cx = ((i * 110 + s.t * (0.12 + (i % 2) * 0.05)) % (WORLD_W + 120)) - 60 - cx0;
      const cy = 46 + ((i * 73) % (WORLD_H - 92)) - cy0;
      const cw = 24 + (i % 3) * 8;
      if (cx + cw < -20 || cx > W + 20 || cy + 20 < -20 || cy > H + 20) continue;
      this.rect(cx + 7, cy + 14, cw, 5, INK, 0.14);
      this.rect(cx, cy, cw, 5, "#ffffff", 0.2);
      this.rect(cx + 4, cy - 2, cw - 8, 7, "#e6f6ff", 0.22);
    }

    this.drawHud();
    if (s.showLog) this.drawFieldLog();
    if (s.state === "title") this.drawTitle();
    if (s.state === "over") this.drawOver();

    return this.snapshot();
  }

  private drawHud(): void {
    const s = this.sim;
    if (s.state !== "play") return;
    const f = hudFrame(s.hud, this.W, this.H);
    const pInfo = PHASE_LABEL[s.phase];
    const lx = f.top.lx, rx = f.top.rx, ty = f.top.y;

    // Wayfinder-style sleek top HUD band
    this.band(0, ty + 22, 0.62);
    this.text(`DAY ${s.day}`, lx, ty, "#ffffff");
    this.text(pInfo.label, lx + 26, ty, pInfo.col);
    // Countdown to dark at dusk, wisps on the field at night.
    const dayF = (s.cycleTick % CYCLE_FRAMES) / CYCLE_FRAMES;
    if (s.phase === "dusk") {
      const secs = Math.ceil(((NIGHT_F - dayF) * CYCLE_FRAMES) / 60);
      this.text(`DARK IN ${secs}S`, lx + 26 + textWidth(pInfo.label) + 6, ty, "#ff9e44");
    } else if (s.phase === "night" && s.wisps.length) {
      this.text(`${s.wisps.length} WISPS`, lx + 26 + textWidth(pInfo.label) + 6, ty, "#c45aa8");
    }

    const lb = s.logButtonRect();
    this.rect(lb.x, lb.y, lb.w, lb.h, s.showLog ? "#fff2a0" : INK, s.showLog ? 1 : 0.85);
    this.strokeRect(lb.x, lb.y, lb.w, lb.h, s.showLog ? "#fff2a0" : "#5b8dd6");
    this.textC(`LOG ${s.secrets.size}/5`, lb.x + lb.w / 2, lb.y + 3, s.showLog ? INK : "#fff2a0", 1, null);

    // Row 2: resources, the hearth's fuel, score
    const res = `WOOD ${s.timber} SP ${s.sparks}`;
    this.text(res, lx, ty + 9, s.warden.hasEmber ? "#ffb347" : "#c7e4ff");
    const sc = String(s.score).padStart(5, "0");
    this.text(sc, rx - textWidth(sc), ty + 9, "#fff2a0");
    const gx0 = lx + textWidth(res) + 8, gx1 = rx - textWidth(sc) - 8;
    if (gx1 - gx0 > 30) {
      this.text("FIRE", gx0, ty + 9, "#ffb347");
      const bx = gx0 + 18, bw = gx1 - bx;
      const k = s.fuel / HEARTH_MAX;
      const low = k < 0.3;
      this.rect(bx, ty + 10, bw, 3, INK);
      this.rect(bx, ty + 10, Math.round(bw * k), 3, low ? ((s.t >> 3) & 1 ? "#ff5c44" : "#ffb347") : "#ffb347");
    }

    // Row 3: full-width sundial day progress bar
    const cycleFrac = (s.cycleTick % CYCLE_FRAMES) / CYCLE_FRAMES;
    this.rect(lx, ty + 17, rx - lx, 2, INK);
    this.rect(lx, ty + 17, Math.round((rx - lx) * cycleFrac), 2, pInfo.col);

    // Phase/Secret announcement banner
    if (s.bannerTimer > 0 && s.bannerText) {
      const alpha = clamp(s.bannerTimer / 25, 0, 1);
      const by = ty + 26;
      this.band(by - 2, 13, 0.55 * alpha);
      this.textC(s.bannerText, f.content.cx, by + 2, s.bannerColor);
    }

    // Bottom centered Wayfinder-style action pill
    if (s.nearby && !s.showLog) {
      const r = s.actButtonRect();
      this.rect(r.x, r.y, r.w, r.h, INK, 0.88);
      this.strokeRect(r.x, r.y, r.w, r.h, s.nearby.urgent ? "#fff2a0" : "#2ec4b6");
      const label = PixelPainter.clip(s.nearby.prompt, Math.floor((r.w - 10) / 4));
      const msg = s.inputMode === "pointer" ? `${label} (E)` : label;
      this.textC(PixelPainter.clip(msg, Math.floor((r.w - 6) / 4)), r.x + r.w / 2, r.y + 4, "#ffffff");
      this.textC("PRESS SPACE OR E", r.x + r.w / 2, r.y + 12, s.nearby.urgent ? "#fff2a0" : "#a8f4e8", 1, null);
    } else if (s.t < 300 && ((s.t >> 5) & 1)) {
      const hint = s.inputMode === "pointer" ? "WASD WALK · SPACE ACT · L LOG" : "DRAG OR TAP TO WALK";
      this.textC(hint, f.content.cx, f.bottom.y - 10, "#c7e4ff");
    }
  }

  /**
   * Night darkness on an 8px grid: each cell's darkness falls off inside the
   * nearest light, quantised to a few levels and merged into horizontal runs
   * so a frame is a few hundred rects, not thousands.
   */
  private drawDarkness(cx0: number, cy0: number, lights: [number, number, number][], max: number): void {
    const W = this.W, H = this.H;
    const cols = Math.ceil(W / DARK_CELL), rows = Math.ceil(H / DARK_CELL);
    for (let r = 0; r < rows; r++) {
      const wy = cy0 + r * DARK_CELL + DARK_CELL / 2;
      let runStart = 0, runLevel = -1;
      for (let c = 0; c <= cols; c++) {
        let level = runLevel;
        if (c < cols) {
          const wx = cx0 + c * DARK_CELL + DARK_CELL / 2;
          let lit = 0;
          for (const [lx, ly, lr] of lights) {
            const d = Math.hypot(wx - lx, wy - ly);
            if (d < lr) lit = Math.max(lit, 1 - (d / lr) * (d / lr));
          }
          level = Math.round((1 - lit) * DARK_STEPS);
        }
        if (c === cols || level !== runLevel) {
          if (runLevel > 0 && c > runStart) {
            this.rect(runStart * DARK_CELL, r * DARK_CELL, (c - runStart) * DARK_CELL, DARK_CELL, "#070b1c", (runLevel / DARK_STEPS) * max);
          }
          runStart = c;
          runLevel = level;
        }
      }
    }
  }

  private drawOver(): void {
    const s = this.sim;
    const f = hudFrame(s.hud, this.W, this.H);
    const cx = f.content.cx;
    const by = Math.round(this.H * 0.34);
    this.band(by - 8, 74, 0.78);
    this.textC("THE HEARTH WENT OUT", cx, by, "#c45aa8", 2);
    this.textC(`DAY ${s.day} · ${s.nightsSurvived} ${s.nightsSurvived === 1 ? "NIGHT" : "NIGHTS"} SURVIVED`, cx, by + 18, "#ffffff");
    this.textC(`${s.dispelled} WISPS DISPELLED · ${s.upgradedLodgesCount} WORKSHOPS`, cx, by + 28, "#c7e4ff");
    this.textC(`SCORE ${s.score} · BEST ${s.best}`, cx, by + 40, "#fff2a0");
    if (s.overT <= 0 && ((s.t >> 5) & 1)) {
      this.textC(s.inputMode === "pointer" ? "CLICK OR SPACE TO LIGHT A NEW FIRE" : "TAP TO LIGHT A NEW FIRE", cx, by + 54, "#ffffff");
    }
  }

  private drawFieldLog(): void {
    const s = this.sim;
    const f = hudFrame(s.hud, this.W, this.H);
    const mw = Math.min(220, Math.max(150, f.content.rx - f.content.lx - 6));
    const mh = Math.min(230, this.H - s.hud.top - s.hud.bottom - 28);
    const mx = Math.round(f.content.cx - mw / 2);
    const my = Math.round((this.H - mh) / 2);

    this.rect(0, 0, this.W, this.H, INK, 0.65);
    this.rect(mx, my, mw, mh, "#12182b");
    this.strokeRect(mx, my, mw, mh, "#5b8dd6");

    this.textC("WARDEN FIELD LOG", f.content.cx, my + 7, "#fff2a0");
    this.textC(`DAY ${s.day} · ${s.nightsSurvived} NIGHTS · ${s.secrets.size}/5 SECRETS`, f.content.cx, my + 16, "#a8f4e8");
    this.line(mx + 6, my + 24, mx + mw - 6, my + 24, "#2c3658");

    const list = s.getSecretList();
    const maxChars = Math.floor((mw - 18) / 4);
    let y = my + 30;
    for (const sec of list) {
      const mark = sec.unlocked ? "[X]" : "[ ]";
      this.text(`${mark} ${PixelPainter.clip(sec.title, maxChars - 4)}`, mx + 8, y, sec.unlocked ? "#7cc46a" : "#ffffff");
      this.text(PixelPainter.clip(sec.clue, maxChars), mx + 8, y + 8, sec.unlocked ? "#5e8f58" : "#8b98bc");
      y += 22;
    }

    const doneBram = s.brambles.filter((b) => b.cleared).length;
    this.line(mx + 6, my + mh - 36, mx + mw - 6, my + mh - 36, "#2c3658");
    this.text(`LODGES UPGRADED: ${s.upgradedLodgesCount}/${s.lodges.length}`, mx + 8, my + mh - 30, "#c7e4ff");
    this.text(`BRAMBLES CLEARED: ${doneBram}/${s.brambles.length}`, mx + 8, my + mh - 21, "#c45aa8");
    this.textC("TAP OR PRESS L TO CLOSE", f.content.cx, my + mh - 10, "#fff2a0");
  }

  private drawTitle(): void {
    const s = this.sim;
    const f = hudFrame(s.hud, this.W, this.H);
    const cx = f.content.cx;
    const top = Math.max(44, s.hud.top + 28);
    this.band(top, 70, 0.58);
    this.textC("YOUR WORKSPACE IN THE VALLEY", cx, top + 6, "#c7e4ff");
    this.textC("BASECAMP", cx, top + 18, "#ff9e44", 3);
    this.textC("KEEP THE LIGHT", cx, top + 44, "#ffb347");
    this.textC("BY DAY: CLEAR BRAMBLES, BUILD, FEED THE FIRE", cx, top + 54, "#e6eefc");

    const bot = this.H - s.hud.bottom - 70;
    this.band(bot, 46, 0.58);
    this.textC("BY NIGHT: THE TWILIGHT CREEPS IN", cx, bot + 6, "#c45aa8");
    this.textC(`LIGHT THE WATCHFIRES · SEE ${ENDURE_NIGHTS} NIGHTS THROUGH`, cx, bot + 16, "#fff2a0");
    if ((s.t >> 5) & 1) {
      const prompt = s.inputMode === "pointer" ? "CLICK OR SPACE TO TEND CAMP" : "TAP TO TEND CAMP";
      this.textC(prompt, cx, bot + 30, "#ffffff");
    }
    this.textC(`BEST ${s.best}`, cx, this.H - s.hud.bottom - 16, "#c7d0e6");
  }
}
