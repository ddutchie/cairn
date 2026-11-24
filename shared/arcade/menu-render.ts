/**
 * ArcadeMenu renderer — draws cartridge cards with live animated thumbnails
 * via PixelPainter. Shared across Canvas2D and Skia.
 */

import { BRICKS, PADDLE } from "./breakout/models";
import { CARD_MODELS, TOWER_MODELS } from "./inbox-zero/models";
import type { ArcadeMenu, Cartridge } from "./menu";
import { INK, PixelPainter, type AtlasHandle, type PixelBackend } from "./pixel/painter";
import { BIOMES, CHUNK, Terrain } from "./pixel/terrain";
import { SH, buildStonePixels } from "./stacker/sprites";
import { PLAYER_MODEL } from "./task-force/models";
import { BOAT_MODEL } from "./wayfinder/models";

export class ArcadeRenderer<Img = unknown, Frame = unknown> extends PixelPainter<Img, Frame> {
  private readonly menu: ArcadeMenu;
  private readonly plane: AtlasHandle<Img>;
  private readonly boat: AtlasHandle<Img>;
  private readonly tower: AtlasHandle<Img>;
  private readonly cardModel: AtlasHandle<Img>;
  private readonly paddle: AtlasHandle<Img>;
  private readonly brickProject: AtlasHandle<Img>;
  private readonly brickNote: AtlasHandle<Img>;
  private readonly brickCard: AtlasHandle<Img>;
  private readonly stone: Img;
  private readonly terrain: Terrain;

  constructor(backend: PixelBackend<Img, Frame>, menu: ArcadeMenu) {
    super(backend, menu.W, menu.H);
    this.menu = menu;
    this.plane = this.makeAtlas(PLAYER_MODEL);
    this.boat = this.makeAtlas(BOAT_MODEL);
    this.tower = this.makeAtlas(TOWER_MODELS.quick[0]);
    this.cardModel = this.makeAtlas(CARD_MODELS.medium);
    this.paddle = this.makeAtlas(PADDLE);
    this.brickProject = this.makeAtlas(BRICKS.project);
    this.brickNote = this.makeAtlas(BRICKS.note);
    this.brickCard = this.makeAtlas(BRICKS.card);
    const sp = buildStonePixels(34, "project", "WORK", 3);
    this.stone = this.makeImage(sp.w, sp.h, sp.pixels);
    this.terrain = new Terrain(menu.W, "tropic", 19);
  }

  override resize(width: number, height: number): void {
    this.menu.resize(width, height);
    this.terrain.resize(width);
    super.resize(width, height);
  }

  private drawThumb(c: Cartridge, rx: number, ry: number): void {
    const rw = 42;
    const rh = c.h - 10;
    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    const t = this.menu.t;

    this.rect(rx, ry, rw, rh, "#0c1428");
    this.clip(rx, ry, rw, rh, () => {
      switch (c.id) {
        case "task-force": {
          this.rect(rx, ry, rw, rh, BIOMES.tropic.water[0]);
          const iy = ry + ((t * 0.4) % (rh + 12)) - 8;
          this.rect(rx + 9, iy, 14, 9, "#3f8f2e");
          this.rect(rx + 12, iy + 2, 8, 5, "#5cb83a");
          this.shadow(this.plane, cx, cy + 4, 0, 2, 3, 0.35, 0.75);
          this.stack(this.plane, cx, cy + 2, Math.sin(t * 0.05) * 0.2, { k: 0.75 });
          this.px(cx, ry + ((t * 1.4) % rh), "#fff2a0");
          break;
        }
        case "wayfinder": {
          this.rect(rx, ry, rw, rh, BIOMES.tropic.water[1]);
          this.rect(rx + rw - 13, ry + 6, 8, 8, "#c9a56a");
          this.rect(rx + rw - 11, ry + 8, 4, 4, "#5cb83a");
          this.shadow(this.boat, cx - 5, cy + 5, -0.5, 2, 3, 0.35, 0.9);
          this.stack(this.boat, cx - 5, cy + 3, -0.5 + Math.sin(t * 0.06) * 0.15, { k: 0.9 });
          break;
        }
        case "inbox-zero": {
          this.rect(rx, ry, rw, rh, "#151b2e");
          this.rect(rx + 4, cy - 3, rw - 8, 6, "#2a3350");
          const cardX = rx + 4 + ((t * 0.5) % (rw - 10));
          this.stack(this.cardModel, cardX, cy, Math.PI / 2, { k: 0.7 });
          this.stack(this.tower, cx + 4, cy - 9, Math.sin(t * 0.06) * 0.5, { k: 0.8 });
          break;
        }
        case "stacker": {
          this.rect(rx, ry, rw, rh, "#264778");
          const sy = ry + rh - 8;
          this.rect(rx, sy + 4, rw, 5, "#4d8a42");
          this.imageRect(this.stone, 0, 0, 34, SH, Math.round(cx - 17), sy - 7, 34, SH);
          const swing = Math.round(Math.sin(t * 0.08) * 5);
          this.imageRect(this.stone, 0, 0, 26, SH, Math.round(cx - 13 + swing), sy - 18, 26, SH);
          break;
        }
        case "breakout": {
          this.rect(rx, ry, rw, rh, "#101628");
          this.stack(this.brickProject, rx + 10, ry + 6, 0, { k: 0.55 });
          this.stack(this.brickNote, rx + 21, ry + 6, 0, { k: 0.55 });
          this.stack(this.brickCard, rx + 32, ry + 6, 0, { k: 0.55 });
          this.stack(this.paddle, cx + Math.sin(t * 0.06) * 6, ry + rh - 5, 0, { k: 0.65 });
          this.px(cx + Math.sin(t * 0.11) * 9, cy + 2 + Math.cos(t * 0.13) * 4, "#fff2a0", 2);
          break;
        }
      }
    });
    this.strokeRect(rx, ry, rw, rh, "#2c3658");
  }

  draw(): Frame {
    const m = this.menu;
    const t = m.t;
    const cx = Math.round((m.hud.left + m.W - m.hud.right) / 2);

    this.clear(BIOMES.tropic.water[0]);
    const camR = t * 0.18;
    m.terrainPump?.(camR);
    this.terrain.pump(Math.floor(camR) + m.H + CHUNK, 3);
    this.drawTerrain(this.terrain, 1, camR, 0, ((t >> 5) & 1) as 0 | 1);
    this.rect(0, 0, m.W, m.H, INK, 0.66);

    this.band(m.titleY - 4, 32, 0.55);
    this.textC("CAIRN ARCADE", cx, m.titleY, "#fff2a0", 2);
    this.textC("YOUR WORKSPACE, PLAYABLE", cx, m.titleY + 18, "#8b98bc");

    m.cards.forEach((c, i) => {
      const sel = i === m.selected || i === m.chosen;
      const blinkHide = i === m.chosen && (m.blink & 2) !== 0;
      this.rect(c.x, c.y, c.w, c.h, sel ? c.accent : "#1d2642");
      this.rect(c.x + 1, c.y + 1, c.w - 2, c.h - 2, blinkHide ? "#1d2848" : "#12182b");
      this.drawThumb(c, c.x + 5, c.y + 5);

      const tx = c.x + 52;
      const maxChars = Math.max(8, Math.floor((c.w - 56) / 4));
      this.text(PixelPainter.clip(c.title, maxChars), tx, c.y + 7, sel ? c.accent : "#ffffff");
      this.text(PixelPainter.clip(c.blurb, maxChars), tx, c.y + 17, "#99a6c4");
      if (c.best > 0) {
        this.text(`BEST ${c.best}`, tx, c.y + Math.min(c.h - 10, 29), "#fff2a0", 1, null);
      }
    });

    const footerY = m.H - Math.max(10, m.hud.bottom + 6);
    const hint = m.inputMode === "pointer" ? "ARROWS + ENTER   OR CLICK A GAME" : "TAP A CARTRIDGE TO PLAY";
    this.textC(hint, cx, footerY, "#8b98bc");
    return this.snapshot();
  }
}

// Helper no-op typing guard if needed
declare module "./menu" {
  interface ArcadeMenu {
    terrainPump?: (camR: number) => void;
  }
}
