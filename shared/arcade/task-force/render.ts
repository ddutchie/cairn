/**
 * Task Force renderer — extends PixelPainter for Canvas2D & Skia parity.
 */

import type { Priority } from "../../types/domain";
import { fontSafe } from "../pixel/font";
import { PRIORITY_PAL } from "../pixel/kinds";
import { FIRE, INK, PixelPainter, type AtlasHandle, type PixelBackend } from "../pixel/painter";
import { BIOMES } from "../pixel/terrain";
import { BOSS_MODEL, ENEMY_MODELS, PICKUP_MODEL, PLAYER_MODEL } from "./models";
import { toScreen, type TaskForceSim } from "./sim";

export class TaskForceRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly sim: TaskForceSim;
  private readonly playerAtlas: AtlasHandle<Img>;
  private readonly enemyAtlases: Record<Priority, AtlasHandle<Img>>;
  private readonly bossAtlas: AtlasHandle<Img>;
  private readonly pickupAtlas: AtlasHandle<Img>;
  private readonly clouds: { img: Img; shadow: Img }[];

  constructor(backend: PixelBackend<Img, Frame>, sim: TaskForceSim) {
    super(backend, sim.W, sim.H);
    this.sim = sim;
    this.playerAtlas = this.makeAtlas(PLAYER_MODEL);
    this.enemyAtlases = {
      low: this.makeAtlas(ENEMY_MODELS.low),
      medium: this.makeAtlas(ENEMY_MODELS.medium),
      high: this.makeAtlas(ENEMY_MODELS.high),
      urgent: this.makeAtlas(ENEMY_MODELS.urgent),
    };
    this.bossAtlas = this.makeAtlas(BOSS_MODEL);
    this.pickupAtlas = this.makeAtlas(PICKUP_MODEL);
    this.clouds = sim.cloudSprites.map((c) => ({
      img: this.makeImage(c.w, c.h, c.pixels),
      shadow: this.makeImage(c.w, c.h, c.shadow),
    }));
  }

  override resize(width: number, height: number): void {
    this.sim.resize(width, height);
    super.resize(width, height);
  }

  private drawClouds(hi: boolean): void {
    for (const c of this.sim.clouds) {
      if (c.hi !== hi) continue;
      const cs = this.clouds[c.sprite];
      this.image(cs.shadow, Math.round(c.x + 7), Math.round(c.y + 10), 0.16);
      this.image(cs.img, Math.round(c.x), Math.round(c.y), hi ? 0.92 : 0.72);
    }
  }

  draw(): Frame {
    const s = this.sim;
    const ox = s.state === "title" ? 0 : Math.round(((s.player.x - s.W / 2) / Math.max(1, s.W)) * 10);
    this.SX = s.shake > 0 ? Math.round((s.rand() * 2 - 1) * s.shake) : 0;
    this.SY = s.shake > 0 ? Math.round((s.rand() * 2 - 1) * s.shake * 0.5) : 0;

    this.clear(BIOMES[s.terrain.biome].water[0]);
    this.drawTerrain(s.terrain, s.terrainGen, s.camR, ox, ((s.t >> 3) & 1) as 0 | 1);
    this.drawClouds(false);

    if (s.state === "title") {
      this.SX = this.SY = 0;
      const y = Math.round(s.H * 0.24);
      this.band(y - 8, 52, 0.55);
      this.textC("TASK", s.W / 2, y, "#fff2a0", 3);
      this.textC("FORCE", s.W / 2, y + 20, "#ff7242", 3);
      const midY = Math.round(s.H * 0.52);
      this.shadow(this.playerAtlas, s.W / 2, midY, Math.sin(s.t * 0.03) * 0.18, 8, 12, 0.35);
      this.stack(this.playerAtlas, s.W / 2, midY, Math.sin(s.t * 0.03) * 0.18);
      if ((s.t >> 5) & 1) {
        const prompt = s.inputMode === "pointer" ? "CLICK OR SPACE TO FLY" : "TAP TO FLY";
        this.textC(prompt, s.W / 2, s.H - 64 - s.hudBottom, "#ffffff");
      }
      this.textC(`BEST ${s.best}`, s.W / 2, s.H - 48 - s.hudBottom, "#c7d0e6");
      return this.snapshot();
    }

    for (const tr of s.trail) this.px(tr.x, tr.y, "#dce9ff", 1, (tr.l / 26) * 0.45);
    for (const pk of s.pickups) {
      this.shadow(this.pickupAtlas, pk.x, pk.y, pk.ang, 7, 10);
      this.stack(this.pickupAtlas, pk.x, pk.y, pk.ang);
    }
    for (const e of s.enemies) {
      this.shadow(this.enemyAtlases[e.pr], e.x, e.y, e.ang, 7, 11);
      this.stack(this.enemyAtlases[e.pr], e.x, e.y, e.ang, { flash: e.flash > 0 });
    }
    if (s.boss) {
      const b = s.boss;
      this.shadow(this.bossAtlas, b.x, b.y, b.ang, 9, 13, 0.35);
      this.stack(this.bossAtlas, b.x, b.y, b.ang, { flash: b.flash > 0 });
    }

    const p = s.player;
    if (!p.dead && (p.inv === 0 || (p.inv & 3) < 2)) {
      this.shadow(this.playerAtlas, p.x, p.y, p.ang, 8, 12, 0.35);
      this.stack(this.playerAtlas, p.x, p.y, p.ang);
      const [fx, fy] = toScreen(p.x, p.y, p.ang, 0.5, 5);
      this.px(fx - 0.5, fy, s.t & 2 ? "#ffffff" : "#ffb347", 2);
      if (s.muzzle > 0) for (const sx of [-3, 3]) this.px(p.x + sx - 1, p.y - 8, "#fff2a0", 2);
    }

    for (const b of s.pbul) {
      this.px(b.x, b.y - 1, "#fff2a0");
      this.px(b.x, b.y, "#ffffff");
      this.px(b.x, b.y + 1, "#ffae42");
    }
    for (const b of s.ebul) {
      this.px(b.x - 1, b.y - 1, "#ff2a6d", 3);
      this.px(b.x, b.y, "#fff0a8");
    }
    for (const pt of s.parts) {
      const f = pt.l / pt.m;
      const col =
        pt.k === 1
          ? f > 0.5
            ? "#8c93a8"
            : "#43495c"
          : pt.k === 2
            ? "#ffffff"
            : pt.k === 3
              ? "#9fd2ff"
              : FIRE[Math.min(4, ((1 - f) * 5) | 0)];
      this.px(pt.x, pt.y, col, pt.s, pt.k === 1 ? f * 0.7 : 1);
    }
    for (const rg of s.rings) {
      const n = Math.max(8, rg.r * 5);
      const a = 1 - rg.r / rg.max;
      for (let i = 0; i < n; i++) {
        this.px(rg.x + Math.cos((i / n) * 6.283) * rg.r, rg.y + Math.sin((i / n) * 6.283) * rg.r, "#fff2a0", 1, a);
      }
    }
    this.drawClouds(true);

    for (const e of s.enemies) {
      if (e.hp > 0 && (e.pr === "urgent" || e.pr === "high")) {
        const label = PixelPainter.clip(fontSafe(e.task.title), 14);
        this.textIn(label, e.x, e.y - 16, PRIORITY_PAL[e.pr].a);
      }
    }
    for (const tx of s.texts) {
      if (tx.l < 20 && tx.l & 2) continue;
      this.textIn(PixelPainter.clip(fontSafe(tx.s), 28), tx.x, tx.y, tx.c);
    }
    if (s.hurt > 0) this.rect(0, 0, s.W, s.H, "#ff2040", (s.hurt / 14) * 0.28);

    this.SX = this.SY = 0;
    const hudY = Math.max(4, s.hud.top + 2);
    this.band(0, hudY + 12, 0.72);
    this.text(String(s.score).padStart(6, "0"), Math.max(4, s.hud.left), hudY, "#fff2a0");
    for (let i = 0; i < s.lives; i++) {
      this.rect(s.W - Math.max(6, s.hud.right) - 4 - i * 8, hudY, 5, 5, "#7be3ff");
    }
    if (s.boss) {
      const bw = Math.min(100, s.W - 36);
      const bx = Math.round((s.W - bw) / 2);
      this.rect(bx - 1, hudY + 9, bw + 2, 4, INK);
      this.rect(bx, hudY + 10, Math.round((bw * s.boss.hp) / s.boss.max), 2, "#ff3d6e");
    }

    const bannerY = Math.round(s.H * 0.42);
    if (s.state === "intro") {
      this.band(bannerY - 8, 46, 0.65);
      this.textC(`PROJECT ${s.levelIdx + 1} OF ${s.levels.length}`, s.W / 2, bannerY, "#c7d0e6");
      this.textC(PixelPainter.clip(fontSafe(s.level.name), 22), s.W / 2, bannerY + 11, "#fff2a0", 2);
      this.textC(`${s.total} TASKS TO CLEAR`, s.W / 2, bannerY + 30, "#ffffff");
    } else if (s.state === "boss" && s.stateT > 0) {
      this.band(bannerY, 26, 0.65);
      this.textC("DEADLINE APPROACHING", s.W / 2, bannerY + 6, "#ff3d6e", 2);
    } else if (s.state === "clear") {
      this.band(bannerY, 34, 0.65);
      this.textC("PROJECT SHIPPED!", s.W / 2, bannerY + 6, "#8dff9a", 2);
      this.textC(`+1 LIFE`, s.W / 2, bannerY + 24, "#7be3ff");
    } else if (s.state === "over") {
      this.band(bannerY - 8, 60, 0.72);
      this.textC("MISSION OVER", s.W / 2, bannerY, "#ff5e8a", 2);
      this.textC(`SCORE ${s.score}`, s.W / 2, bannerY + 20, "#fff2a0");
      this.textC(`BEST ${s.best}`, s.W / 2, bannerY + 32, "#c7d0e6");
      if (s.stateT <= 0 && (s.t >> 5) & 1) {
        this.textC(s.inputMode === "pointer" ? "CLICK OR SPACE TO RETRY" : "TAP TO RETRY", s.W / 2, bannerY + 46, "#ffffff");
      }
    } else if (s.state === "win") {
      this.band(bannerY - 8, 62, 0.72);
      this.textC("ALL CLEAR!", s.W / 2, bannerY, "#8dff9a", 2);
      this.textC(`SCORE ${s.score}`, s.W / 2, bannerY + 20, "#fff2a0");
      this.textC(`BEST ${s.best}`, s.W / 2, bannerY + 32, "#c7d0e6");
      if (s.stateT <= 0 && (s.t >> 5) & 1) {
        this.textC(s.inputMode === "pointer" ? "CLICK FOR NEXT LOOP" : "TAP FOR NEXT LOOP", s.W / 2, bannerY + 46, "#ffffff");
      }
    }
    return this.snapshot();
  }
}
