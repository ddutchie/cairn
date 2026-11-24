/**
 * Task Force renderer: draws one frame of a TaskForceSim with the shared
 * pixel painter (raster surface, sprite stacks, glyph text) and returns a
 * snapshot for the host view to scale up.
 */

import { Skia, type SkCanvas, type SkImage } from "@shopify/react-native-skia";
import { ADVANCE, clip, textWidth } from "@/games/pixel/font";
import { makeCloud, type CloudSprite } from "@/games/pixel/models";
import { FIRE, INK, PixelPainter, makeImage, stackAtlas } from "@/games/pixel/painter";
import { BIOMES, CHUNK, chunkTop, MARGIN, mulberry32 } from "@/games/pixel/terrain";
import { BOSS, ENEMIES, ENEMY_PALETTE, NOTE, PLAYER } from "./models";
import { CLOUD_SPRITES, toScreen, type TaskForceSim } from "./sim";

export class TaskForceRenderer extends PixelPainter {
  private readonly sim: TaskForceSim;
  private readonly player = stackAtlas(PLAYER);
  private readonly boss = stackAtlas(BOSS);
  private readonly note = stackAtlas(NOTE);
  private readonly enemies = {
    low: stackAtlas(ENEMIES.low),
    medium: stackAtlas(ENEMIES.medium),
    high: stackAtlas(ENEMIES.high),
    urgent: stackAtlas(ENEMIES.urgent),
  };
  private readonly clouds: { sprite: CloudSprite; image: SkImage; shadow: SkImage }[];
  private sparkles: { c: number; x: number; y: number; l: number }[] = [];
  private sparkleGen = -1;
  private readonly fx = mulberry32(99);

  constructor(sim: TaskForceSim) {
    super(sim.W, sim.H);
    this.sim = sim;
    const rand = mulberry32(7);
    this.clouds = Array.from({ length: CLOUD_SPRITES }, () => {
      const sprite = makeCloud(rand);
      return { sprite, image: makeImage(sprite.w, sprite.h, sprite.pixels), shadow: makeImage(sprite.w, sprite.h, sprite.shadow) };
    });
  }

  /** Two flames from the outer nozzle voxels (model x = centre ± 1, rear edge at y = +10). */
  private afterburners(cv: SkCanvas, x: number, y: number, ang: number, k: number, minLen: number, size: number): void {
    const s = Math.sin(ang), c = Math.cos(ang);
    for (const side of [-1, 1]) {
      const [bx, by] = toScreen(x, y - 1, ang, (0.5 + side) * k, 10 * k);
      const len = (minLen + this.fx() * minLen) | 0;
      for (let i = 0; i < len; i++) this.px(cv, bx - i * s - size / 2, by + i * c, FIRE[Math.min(4, ((i * 4) / len) | 0)], size);
    }
  }

  // ── Terrain ────────────────────────────────────────────────────────────────
  private terrainWithGlints(cv: SkCanvas, ox: number): void {
    const sim = this.sim;
    if (this.sparkleGen !== sim.terrainGen) {
      this.sparkles = [];
      this.sparkleGen = sim.terrainGen;
    }
    const vis = this.drawTerrain(cv, sim.terrain, sim.terrainGen, sim.camR, ox, ((sim.t >> 5) & 1) as 0 | 1);

    // Sun glints: sample a few random pixels; open water sparkles for a moment.
    for (let n = 0; n < 4; n++) {
      const c = vis[(this.fx() * vis.length) | 0];
      if (c === undefined) break;
      const x = (this.fx() * sim.terrain.width) | 0, y = (this.fx() * CHUNK) | 0;
      const wc = sim.terrain.chunk(c).water[y * sim.terrain.width + x];
      if (wc >= 1 && wc <= 3) this.sparkles.push({ c, x, y, l: 6 + ((this.fx() * 6) | 0) });
    }
    for (const s of this.sparkles) {
      s.l--;
      this.px(cv, s.x - MARGIN - ox - this.SX, chunkTop(s.c, sim.camR, this.H) + s.y, "#e6f6ff");
    }
    this.sparkles = this.sparkles.filter((s) => s.l > 0);
  }

  // ── Frame ──────────────────────────────────────────────────────────────────
  draw(): SkImage {
    const sim = this.sim, W = this.W, H = this.H, t = sim.t, p = sim.player;
    const cv = this.canvas();
    const sh = sim.shake;
    this.SX = sh ? Math.round((this.fx() * 2 - 1) * sh) : 0;
    this.SY = sh ? Math.round((this.fx() * 2 - 1) * sh) : 0;
    const ox = Math.max(-MARGIN, Math.min(MARGIN, Math.round((p.x - W / 2) * 0.08) + this.SX));
    cv.clear(Skia.Color(BIOMES[sim.level.biome].water[0]));
    this.terrainWithGlints(cv, ox);

    // Cloud shadows, then low clouds below the action.
    for (const c of sim.clouds) {
      const cl = this.clouds[c.sprite];
      cv.drawImage(cl.shadow, Math.round(c.x + (c.hi ? 34 : 18)), Math.round(c.y + (c.hi ? 46 : 26)), this.paint("#000000", 0.16));
    }
    for (const c of sim.clouds) if (!c.hi) cv.drawImage(this.clouds[c.sprite].image, Math.round(c.x), Math.round(c.y));

    // Shadows: offset grows with altitude.
    for (const pk of sim.pickups) this.shadow(cv, this.note, pk.x, pk.y, pk.ang, 4, 6, 0.25);
    for (const e of sim.enemies) this.shadow(cv, this.enemies[e.pr], e.x, e.y, e.ang, 7, 10);
    if (sim.boss) this.shadow(cv, this.boss, sim.boss.x, sim.boss.y, sim.boss.ang, 10, 16);
    const showPlayer = sim.state !== "title" && !p.dead;
    if (showPlayer) this.shadow(cv, this.player, p.x, p.y, p.ang, 10, 15);

    for (const tr of sim.trail) if (tr.l > 3) this.px(cv, tr.x, tr.y, tr.l > 14 ? "#ffffff" : "#d4e2f5", 1, 0.75);

    for (const pk of sim.pickups) {
      this.stack(cv, this.note, pk.x, pk.y, pk.ang);
      if ((t >> 3) & 1) this.px(cv, pk.x - 1, pk.y - 9, "#ffffff");
    }
    for (const e of sim.enemies) {
      this.stack(cv, this.enemies[e.pr], e.x, e.y, e.ang, { flash: e.flash > 0 });
      if ((e.pr === "urgent" || e.pr === "high" || e.flash > 0) && e.y > sim.hudTop + 8) {
        const s = clip(e.task.title, 14), w = textWidth(s);
        this.textC(cv, s, Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, e.x)), e.y + e.r + 3, e.pr === "urgent" ? "#ffb4a8" : "#ffe7a8");
      }
    }
    if (sim.boss) this.stack(cv, this.boss, sim.boss.x, sim.boss.y, sim.boss.ang, { flash: sim.boss.flash > 0 });
    if (showPlayer && !(p.inv > 0 && (t >> 2) & 1)) {
      this.stack(cv, this.player, p.x, p.y, p.ang);
      this.afterburners(cv, p.x, p.y, p.ang, 1, 3, 1);
      if (sim.muzzle) {
        for (const s of [-3, 3]) {
          const [mx, my] = toScreen(p.x, p.y, p.ang, s, -10);
          this.px(cv, mx, my, "#ffffff");
          this.px(cv, mx - 1, my, "#fff2a0");
          this.px(cv, mx + 1, my, "#fff2a0");
        }
      }
    }

    // Bullets, particles, blast rings.
    for (const b of sim.pbul) {
      this.px(cv, b.x, b.y, "#fff6a0");
      this.px(cv, b.x, b.y + 1, "#fff6a0");
      this.px(cv, b.x, b.y + 2, "#ffb347");
    }
    for (const b of sim.ebul) {
      const x = Math.round(b.x) + this.SX, y = Math.round(b.y) + this.SY;
      this.rect(cv, x - 1, y, 3, 1, "#ff5e8a");
      this.rect(cv, x, y - 1, 1, 3, "#ff5e8a");
      this.rect(cv, x, y, 1, 1, (t >> 2) & 1 ? "#ffffff" : "#ffd2e0");
    }
    for (const q of sim.parts) {
      const f = q.l / q.m;
      const col =
        q.k === 1 ? (f > 0.5 ? "#59607a" : "#3c4258")
        : q.k === 2 ? "#2a2f3a"
        : q.k === 3 ? (f > 0.5 ? "#ffffff" : "#9fd2ff")
        : FIRE[f > 0.8 ? 0 : f > 0.6 ? 1 : f > 0.4 ? 2 : f > 0.2 ? 3 : 4];
      this.px(cv, q.x, q.y, col, q.s);
    }
    for (const r of sim.rings) {
      const n = Math.max(8, r.r * 5), col = r.r < r.max * 0.5 ? "#ffffff" : "#ffb347";
      for (let i = 0; i < n; i++) this.px(cv, r.x + Math.cos((i / n) * 6.283) * r.r, r.y + Math.sin((i / n) * 6.283) * r.r, col);
    }

    // High clouds pass over everything.
    for (const c of sim.clouds) if (c.hi) cv.drawImage(this.clouds[c.sprite].image, Math.round(c.x), Math.round(c.y));

    for (const x of sim.texts) {
      if (x.l < 16 && (x.l >> 1) & 1) continue;
      const s = clip(x.s, Math.floor((W - 4) / ADVANCE)), w = textWidth(s);
      this.textC(cv, s, Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, x.x)), Math.max(sim.hudTop + 30, Math.round(x.y)), x.c);
    }

    if (sim.hurt) {
      const a = sim.hurt / 14;
      this.rect(cv, 0, 0, W, 3, "#ff3d6e", a * 0.45);
      this.rect(cv, 0, H - 3, W, 3, "#ff3d6e", a * 0.45);
      this.rect(cv, 0, 0, 3, H, "#ff3d6e", a * 0.45);
      this.rect(cv, W - 3, 0, 3, H, "#ff3d6e", a * 0.45);
      this.rect(cv, 0, 0, W, H, "#ff3d6e", a * 0.12);
    }
    this.SX = this.SY = 0;
    if (sim.state === "title") this.drawTitle(cv);
    else this.drawHud(cv);
    return this.snapshot();
  }

  private heart(cv: SkCanvas, x: number, y: number, color: string): void {
    this.rect(cv, x, y, 2, 1, color);
    this.rect(cv, x + 3, y, 2, 1, color);
    this.rect(cv, x, y + 1, 5, 1, color);
    this.rect(cv, x + 1, y + 2, 3, 1, color);
    this.rect(cv, x + 2, y + 3, 1, 1, color);
  }

  private drawHud(cv: SkCanvas): void {
    const sim = this.sim, W = this.W, H = this.H, t = sim.t, top = sim.hudTop + 4, bottom = H - sim.hudBottom;
    const accent = sim.accent, lv = sim.level, hud = sim.hud;
    // Line 1 leaves the top-right corner free for the close button; both top
    // and bottom rows step in from the rounded corners.
    const l = 4 + hud.topLeft;
    const score = String(sim.score).padStart(6, "0");
    this.text(cv, score, l, top, "#ffffff");
    this.text(cv, `${sim.done}/${sim.total} TASKS`, l + textWidth(score) + 8, top, "#c9d3ea");
    this.text(cv, clip(lv.name, Math.floor((W - 30 - hud.topLeft) / ADVANCE)), l, top + 8, accent);
    const barW = W - 8 - hud.topLeft - hud.topRight;
    this.rect(cv, l, top + 16, barW, 3, INK);
    this.rect(cv, l + 1, top + 17, Math.round(((barW - 2) * sim.done) / Math.max(1, sim.total)), 1, accent);
    for (let i = 0; i < 5; i++) this.heart(cv, W - 8 - hud.bottomRight - i * 7, bottom - 9, i < sim.lives ? "#ff5e8a" : "#3a3f55");
    if (sim.player.spread > 0) {
      const sl = 4 + hud.bottomLeft;
      this.text(cv, "SPREAD", sl, bottom - 9, "#9fd2ff");
      this.rect(cv, sl + 26, bottom - 7, Math.round((sim.player.spread / 600) * 40), 1, "#9fd2ff");
    }
    if (sim.boss) {
      this.rect(cv, 20, top + 23, W - 40, 4, INK);
      this.rect(cv, 21, top + 24, Math.round(((W - 42) * Math.max(0, sim.boss.hp)) / sim.boss.max), 2, "#ff3d6e");
    }

    // Banners sit just above the middle of the playfield.
    const cy = Math.round((top + bottom) / 2) - 28;
    if (sim.state === "intro") {
      this.band(cv, cy - 8, 60);
      this.textC(cv, `PROJECT ${sim.levelIdx + 1}/${sim.levels.length}${sim.loop ? `  LOOP ${sim.loop + 1}` : ""}`, W / 2, cy, "#c9d3ea");
      const big = textWidth(lv.name, 2) <= W - 8;
      this.textC(cv, big ? lv.name : clip(lv.name, Math.floor((W - 8) / ADVANCE)), W / 2, cy + 12, accent, big ? 2 : 1);
      this.textC(cv, `${sim.total} TASKS  ${lv.notes.length} NOTES`, W / 2, cy + 30, "#ffffff");
      if ((t >> 4) & 1) this.textC(cv, "CLEAR THE BACKLOG", W / 2, cy + 42, "#8dff9a");
    }
    if (sim.state === "boss" && sim.stateT > 0) {
      this.band(cv, cy + 2, 36);
      if ((t >> 3) & 1) {
        this.textC(cv, "WARNING", W / 2, cy + 10, "#ff3d6e", 2);
        this.textC(cv, "PROJECT REVIEW INBOUND", W / 2, cy + 28, "#ffffff");
      }
    }
    if (sim.state === "clear") {
      this.band(cv, cy + 2, 50);
      this.textC(cv, "ALL TASKS CLEARED", W / 2, cy + 10, "#8dff9a");
      this.textC(cv, clip(lv.name, Math.floor((W - 8) / (ADVANCE * 2))), W / 2, cy + 22, accent, 2);
      this.textC(cv, "+1 HEART", W / 2, cy + 42, "#ff5e8a");
    }
    if (sim.state === "over" || sim.state === "win") {
      this.rect(cv, 0, cy - 14, W, 84, INK, 0.55);
      if (sim.state === "over") {
        this.textC(cv, "GAME OVER", W / 2, cy - 4, "#ff5e8a", 2);
        this.textC(cv, `${sim.done} OF ${sim.total} TASKS DONE`, W / 2, cy + 18, "#ffffff");
        this.textC(cv, clip(`IN ${lv.name}`, Math.floor((W - 8) / ADVANCE)), W / 2, cy + 28, accent);
      } else {
        this.textC(cv, "ALL CAUGHT UP!", W / 2, cy - 4, "#8dff9a", 2);
        this.textC(cv, "EVERY PROJECT SHIPPED", W / 2, cy + 18, "#ffffff");
        this.textC(cv, "NEXT LOOP IS HARDER", W / 2, cy + 28, "#ffb347");
      }
      this.textC(cv, `BEST ${String(sim.best).padStart(6, "0")}`, W / 2, cy + 40, "#c9d3ea");
      if (sim.stateT <= 0 && (t >> 4) & 1) this.textC(cv, sim.state === "over" ? "TAP TO RETRY" : "TAP TO CONTINUE", W / 2, cy + 56, "#ffffff");
    }
  }

  private drawTitle(cv: SkCanvas): void {
    const sim = this.sim, W = this.W, H = this.H, t = sim.t, cx = W / 2;
    const top = sim.hudTop + 10, bottom = H - sim.hudBottom;
    this.band(cv, top - 6, 54);
    this.textC(cv, "CAIRN PRESENTS", cx, top, "#c9d3ea");
    this.textC(cv, "TASK FORCE", cx, top + 12, "#ffffff", 3);
    this.textC(cv, "CLEAR YOUR BACKLOG", cx, top + 34, BIOMES.tropic.accent);

    // The jet weaves gently: its nose yaws into the drift, like the in-game bank.
    const jy0 = Math.round((top + 48 + bottom - 116) / 2);
    const ja = Math.sin(t * 0.025) * 0.28, jx = cx - Math.cos(t * 0.025) * 10, jy = jy0 + Math.sin(t * 0.05) * 2;
    this.shadow(cv, this.player, jx, jy, ja, 12, 22, 0.3, 3);
    this.stack(cv, this.player, jx, jy, ja, { k: 3, lift: 0.34 });
    this.afterburners(cv, jx, jy, ja, 3, 7, 2);

    const ly = bottom - 116;
    this.band(cv, ly, 76);
    const kinds = ["low", "medium", "high", "urgent"] as const;
    const labels = ["LOW", "MED", "HIGH", "URGENT"];
    const step = Math.min(43, (W - 20) / 4);
    kinds.forEach((k, i) => {
      const x = cx + (i - 1.5) * step;
      this.stack(cv, this.enemies[k], x, ly + 20, -t * 0.04 + i);
      this.textC(cv, labels[i], x, ly + 36, ENEMY_PALETTE[k].h);
    });
    this.textC(cv, "TASKS ARE ENEMIES", cx, ly + 48, "#ffffff");
    const nx = cx - textWidth("NOTES = SPREAD SHOT") / 2 - 6;
    this.stack(cv, this.note, nx, ly + 63, t * 0.06);
    this.text(cv, "NOTES = SPREAD SHOT", nx + 10, ly + 61, "#9fd2ff");
    if ((t >> 4) & 1) this.textC(cv, "TAP TO FLY", cx, bottom - 30, "#ffffff", 2);
    this.textC(cv, `DRAG TO STEER - AUTO FIRE${sim.best ? `   BEST ${sim.best}` : ""}`, cx, bottom - 12, "#c9d3ea");
  }
}
