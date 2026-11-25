/**
 * Wayfinder island expeditions: what each of the four inland steps offers, and
 * the on-screen layout the sim hit-tests and the renderer draws. Pure: no
 * platform code, so desktop and mobile land on the same pixels.
 */

import { hudFrame, type PixelHud } from "../pixel/hud";
import { hash2, mulberry32, type BiomeName } from "../pixel/terrain";
import type { Priority } from "../../types/domain";
import { FOE_ROSTER, GHOST_FOE } from "./models";

/**
 * Every landing opens on the shore and ends at the note's shrine; the steps
 * between are dealt from a deck seeded by the island, so no two play alike.
 */
export type StepKind = "shore" | "fork" | "ambush" | "den" | "overdue" | "cache" | "camp" | "bridge" | "ford" | "hermit" | "wreck" | "trap" | "shrine";
/** The island's overall character: from its note's links and length. */
export type Mood = "wild" | "lost" | "crossroads" | "deep";
export type ExpeditionPhase = "step" | "summary" | "ko";
export type Choice = "a" | "b";
export const FIGHTS: readonly StepKind[] = ["ambush", "den", "overdue"];
export const isFight = (k: StepKind) => FIGHTS.includes(k);

/** Voyage buffs a banked relic grants (kept until the day ends). */
export type Relic = "KNOT CHARM" | "SPYGLASS" | "BLESSED HOLD" | "DEEP RELIC" | "STORM GLASS" | "KRAKEN TOOTH" | "LUCKY COIN" | "IRON HEART";
export const RELIC_INFO: Record<Relic, string> = {
  "KNOT CHARM": "FASTER SAILING",
  SPYGLASS: "SEE FURTHER IN FOG",
  "BLESSED HOLD": "+1 CARGO SLOT",
  "DEEP RELIC": "SPEED AND SIGHT",
  "STORM GLASS": "STORMS SLOW YOU LESS",
  "KRAKEN TOOTH": "KRAKEN SPARES A CRATE",
  "LUCKY COIN": "+25% ISLAND GOLD",
  "IRON HEART": "+1 MAX HEART",
};

export const MAX_HP = 3;
export const MAX_SUPPLIES = 5;
export const OFFER_COST = 10;
export const TRADE_COST = 10;
/** Sea-clock frames lost when the captain turns back, or is knocked out. */
export const RETREAT_PENALTY = 180;
export const KO_PENALTY = 360;
/** Frames between two choices, so a double tap can't skip a step. */
export const CHOICE_COOLDOWN = 10;
export const WALK_FRAMES = 24;
export const KO_FRAMES = 90;

export interface Voyage {
  hp: number;
  maxHp: number;
  supplies: number;
  /** Fraction added to top speed. */
  speed: number;
  /** Pixels added to the fog-reveal radius. */
  fog: number;
  /** Extra cargo slots. */
  cargo: number;
  /** Speed kept inside a storm, on top of the usual 45%. */
  storm: number;
  /** Times the kraken will let a crate go. */
  kraken: number;
  /** Lucky coins held: each adds 25% to island gold. */
  luck: number;
}

export const freshVoyage = (): Voyage => ({ hp: MAX_HP, maxHp: MAX_HP, supplies: 2, speed: 0, fog: 0, cargo: 0, storm: 0, kraken: 0, luck: 0 });

export function applyRelic(v: Voyage, r: Relic): void {
  if (r === "KNOT CHARM" || r === "DEEP RELIC") v.speed = Math.min(0.32, v.speed + 0.08);
  if (r === "SPYGLASS" || r === "DEEP RELIC") v.fog = Math.min(48, v.fog + 12);
  if (r === "BLESSED HOLD") v.cargo = Math.min(2, v.cargo + 1);
  if (r === "STORM GLASS") v.storm = Math.min(0.4, v.storm + 0.2);
  if (r === "KRAKEN TOOTH") v.kraken = Math.min(2, v.kraken + 1);
  if (r === "LUCKY COIN") v.luck = Math.min(2, v.luck + 1);
  if (r === "IRON HEART" && v.maxHp < MAX_HP + 2) {
    v.maxHp++;
    v.hp++;
  }
}

/** A trail at a fork: toward a linked note (`isle` ≥ 0) or into the wild (-1), and what waits there. */
export interface Route {
  isle: number;
  title: string;
  kind: StepKind;
}

/** What the sim knows about an island and its project when the captain lands. */
export interface IslandInfo {
  isleIndex: number;
  title: string;
  biome: BiomeName;
  orphan: boolean;
  words: number;
  links: { isle: number; title: string }[];
  project: { name: string; accent: string } | null;
  /** The project's first overdue task, if any (it brews one of the day's storms). */
  overdue: string | null;
  /** The project's next task crate waiting at the lighthouse, if any. */
  crate: { title: string; pr: Priority } | null;
  luck: number;
}

export interface Expedition {
  isleIndex: number;
  title: string;
  biome: BiomeName;
  orphan: boolean;
  mood: Mood;
  words: number;
  /** 1 for a short note, up to 2 for a long one: scales treasure. */
  rich: number;
  luck: number;
  deck: StepKind[];
  step: number;
  phase: ExpeditionPhase;
  links: { isle: number; title: string }[];
  /** The two trails offered at a fork. */
  routes: [Route, Route] | null;
  /** Linked islands to chart when the island is cleared. */
  charts: number[];
  project: { name: string; accent: string } | null;
  overdue: string | null;
  crate: { title: string; pr: Priority } | null;
  crateTaken: boolean;
  /** The overdue task's foe was beaten: its storm weakens on banking. */
  calmed: boolean;
  /** Which foe stands on this step: an index into the biome's roster, or -1 for a ghost. */
  foe: number;
  foeHp: number;
  foeMax: number;
  /** The foe swings back after every other strike. */
  foeTurn: boolean;
  scouted: boolean;
  /** Unbanked treasure: lost on a retreat or knock-out. */
  gold: number;
  bonus: number;
  relics: Relic[];
  /** Keyboard highlight. */
  sel: 0 | 1;
  /** Timers, in frames. */
  t: number;
  walk: number;
  trail: number;
  swing: number;
  hit: number;
  hurt: number;
  cool: number;
  toast: { s: string; c: string; t: number } | null;
}

export interface ChoiceText {
  label: string;
  desc: string;
}

export interface StepCard {
  kind: StepKind;
  tag: string;
  title: string;
  lines: [string, string];
  a: ChoiceText;
  b: ChoiceText;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}.` : s);

export function moodFor(info: Pick<IslandInfo, "orphan" | "links" | "words">): Mood {
  if (info.orphan) return "lost";
  if (info.links.length >= 3) return "crossroads";
  if (info.words >= 1200) return "deep";
  return "wild";
}

/** Middle-of-the-deck encounters, with how often each turns up. */
const POOL: [StepKind, number][] = [
  ["cache", 3],
  ["bridge", 2],
  ["ford", 2],
  ["hermit", 2],
  ["wreck", 2],
  ["trap", 2],
  ["camp", 1],
  ["den", 1],
];
/** What a fork's trails can lead to. */
const ROUTE_KINDS: StepKind[] = ["cache", "den", "wreck", "hermit", "camp", "ford"];

/**
 * Deal an island's deck: the shore, then 2–4 encounters (always a fight; a
 * fork toward linked notes when it has links; a camp when its project has a
 * crate waiting), then the shrine. Same island, same deck.
 */
export function dealDeck(info: IslandInfo): { deck: StepKind[]; mood: Mood; routes: [Route, Route] | null } {
  const mood = moodFor(info), rng = mulberry32(info.isleIndex * 7919 + info.words * 31 + 17);
  const n = mood === "lost" ? 4 : Math.min(6, 4 + (info.words >= 600 ? 1 : 0) + (info.words >= 1500 ? 1 : 0) + (mood === "crossroads" ? 1 : 0));
  const middle: StepKind[] = [info.overdue && mood !== "lost" ? "overdue" : "ambush"];
  if (mood === "crossroads") middle.push("den");
  if (info.crate && mood !== "lost") middle.push("camp");
  const forked = info.links.length > 0 && mood !== "lost";
  while (middle.length < n - 2 - (forked ? 1 : 0)) {
    const pool = POOL.filter(([k]) => !middle.includes(k) && !(k === "camp" && mood === "lost"));
    let r = rng() * pool.reduce((s, [, w]) => s + w, 0), pick = pool[0][0];
    for (const [k, w] of pool) if ((r -= w) <= 0) {
      pick = k;
      break;
    }
    middle.push(pick);
  }
  for (let i = middle.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [middle[i], middle[j]] = [middle[j], middle[i]];
  }
  let routes: [Route, Route] | null = null;
  if (forked) {
    // The fork comes first; its two trails pick the encounter after it.
    middle.unshift("fork");
    const a = info.links[Math.floor(rng() * info.links.length)];
    const others = info.links.filter((l) => l !== a);
    const b = others.length ? others[Math.floor(rng() * others.length)] : { isle: -1, title: "THE WILD PATH" };
    const ka = ROUTE_KINDS[Math.floor(rng() * ROUTE_KINDS.length)];
    let kb = ROUTE_KINDS[Math.floor(rng() * ROUTE_KINDS.length)];
    if (kb === ka) kb = ROUTE_KINDS[(ROUTE_KINDS.indexOf(ka) + 1) % ROUTE_KINDS.length];
    routes = [
      { isle: a.isle, title: a.title, kind: ka },
      { isle: b.isle, title: b.title, kind: kb },
    ];
  }
  return { deck: ["shore", ...middle, "shrine"], mood, routes };
}

/** Per-biome set dressing for the shore and cache cards. */
const FLAVOUR: Record<BiomeName, { trail: [string, string]; cache: string; river: string }> = {
  tropic: { trail: ["A TANGLE OF VINES", "HIDES AN OLD TRAIL"], cache: "WEEDS WRAP A", river: "A WARM GREEN RIVER" },
  desert: { trail: ["WIND-CARVED DUNES", "HIDE AN OLD TRAIL"], cache: "SAND HALF BURIES A", river: "A SLOW OASIS STREAM" },
  tundra: { trail: ["FRESH SNOW COVERS", "AN OLD TRAIL"], cache: "ICE LOCKS IN A", river: "AN ICY MELTWATER" },
  volcano: { trail: ["WARM ASH DRIFTS", "OVER AN OLD TRAIL"], cache: "SOOT BLACKENS A", river: "A STEAMING STREAM" },
};
const MOOD_TAG: Record<Mood, string> = { wild: "SHORELINE", lost: "LOST ISLAND", crossroads: "CROSSROADS", deep: "DEEP ISLAND" };
const ROUTE_DESC: Partial<Record<StepKind, string>> = {
  cache: "A CACHE AHEAD",
  den: "A BEAST DEN",
  wreck: "A WRECK AHEAD",
  hermit: "A HERMIT AHEAD",
  camp: "A CAMP AHEAD",
  ford: "A RIVER AHEAD",
};

export const kindAt = (e: Expedition): StepKind => e.deck[Math.min(e.step, e.deck.length - 1)];
export const goldFor = (e: Expedition, base: number) => Math.round(base * e.rich * (1 + 0.25 * e.luck));
/** A coin flip fixed for this island and step: risky choices are fair but not re-rollable. */
export const unlucky = (e: Expedition, salt: number, p = 0.5) => hash2(e.isleIndex, e.step * 13 + salt, 97) < p;
/** The relic a wreck gives up on this island. */
export const wreckRelic = (e: Expedition): Relic => (hash2(e.isleIndex, 5, 41) < 0.5 ? "STORM GLASS" : "KRAKEN TOOTH");

export function foeName(e: Expedition): string {
  const kind = kindAt(e);
  if (kind === "overdue" && e.overdue) return clip(e.overdue, 16);
  const base = e.foe < 0 ? GHOST_FOE.name : FOE_ROSTER[e.biome][e.foe % FOE_ROSTER[e.biome].length].name;
  return kind === "den" ? `ELDER ${base}` : base;
}

export function stepCard(e: Expedition, v: Voyage): StepCard {
  const kind = kindAt(e), fl = FLAVOUR[e.biome];
  const flee = v.supplies > 0 ? { label: "BAIT IT", desc: "-1 SUPPLY" } : { label: "DASH PAST", desc: "-1 HEART" };
  switch (kind) {
    case "shore":
      return {
        kind,
        tag: MOOD_TAG[e.mood],
        title: e.title,
        lines: e.mood === "lost" ? ["NO TRAIL LEADS HERE", "NO NOTE LINKS IN"] : fl.trail,
        a: { label: "SCOUT AHEAD", desc: "WEAKEN FOE, TRAPS" },
        b: { label: "COMB BEACH", desc: `+${goldFor(e, 8)} GOLD` },
      };
    case "fork": {
      const [ra, rb] = e.routes!;
      return {
        kind,
        tag: "FORK",
        title: "TWO TRAILS",
        lines: ["SIGNPOSTS NAME", "YOUR LINKED NOTES"],
        a: { label: clip(ra.title, 12), desc: ROUTE_DESC[ra.kind] ?? "" },
        b: { label: clip(rb.title, 12), desc: ROUTE_DESC[rb.kind] ?? "" },
      };
    }
    case "ambush":
    case "den":
    case "overdue": {
      const foe = foeName(e);
      return {
        kind,
        tag: kind === "den" ? "BEAST DEN" : kind === "overdue" ? "OVERDUE!" : e.foe < 0 ? "HAUNTED!" : "AMBUSH!",
        title: foe,
        lines: kind === "overdue" ? ["AN OVERDUE TASK", "BREWS A STORM"] : kind === "den" ? ["A HUGE BEAST", "GUARDS ITS DEN"] : [`${clip(foe, 14)} BLOCKS`, "THE NARROW PASS"],
        a: { label: "STRIKE", desc: `CUTLASS ${e.foeHp}/${e.foeMax}` },
        b: kind === "den" ? { label: "SNEAK PAST", desc: v.supplies > 0 ? "-1 SUPPLY" : "-1 HEART" } : flee,
      };
    }
    case "cache":
      return {
        kind,
        tag: "FOUND CACHE",
        title: e.orphan ? "LOST STRONGBOX" : "SUNKEN CHEST",
        lines: [fl.cache, "BRASS LOCKBOX"],
        a: { label: "PRY OPEN", desc: `${e.orphan ? "DEEP RELIC" : "KNOT CHARM"} +${goldFor(e, 12)}G` },
        b: { label: "PATCH UP", desc: "+1 HEART +1 SUP" },
      };
    case "camp":
      return {
        kind,
        tag: "PROJECT CAMP",
        title: clip(e.project?.name ?? "OLD CAMP", 22),
        lines: e.crate && !e.crateTaken ? ["A CRATE IS WAITING", "FOR DELIVERY"] : ["A TENT FLIES THE", "PROJECT COLOURS"],
        a: e.crate && !e.crateTaken ? { label: "LOAD CRATE", desc: clip(e.crate.title, 14) } : { label: "FORAGE", desc: `+${goldFor(e, 6)} GOLD` },
        b: { label: "REST", desc: "+1 HEART +1 SUP" },
      };
    case "bridge":
      return {
        kind,
        tag: "ROPE BRIDGE",
        title: "THE GORGE",
        lines: ["A FRAYED BRIDGE", "SPANS A GORGE"],
        a: { label: "CROSS FAST", desc: `RISKY +${goldFor(e, 14)}G` },
        b: { label: "CLIMB DOWN", desc: v.supplies > 0 ? "-1 SUPPLY" : "-1 HEART" },
      };
    case "ford":
      return {
        kind,
        tag: "RIVER FORD",
        title: "THE FORD",
        lines: [fl.river, "FULL OF FISH"],
        a: { label: "FISH", desc: "+1 SUP, RISKY" },
        b: { label: "WADE ACROSS", desc: "SAFE" },
      };
    case "hermit":
      return {
        kind,
        tag: "HERMIT",
        title: "OLD HERMIT",
        lines: ["A HERMIT SELLS", "LUCK AND DIRECTIONS"],
        a: { label: `TRADE ${TRADE_COST}G`, desc: "LUCKY COIN" },
        b: e.links.length ? { label: "ASK THE WAY", desc: `CHART ${Math.min(3, e.links.length)} LINKS` } : { label: "ASK THE WAY", desc: "SCOUT AHEAD" },
      };
    case "wreck":
      return {
        kind,
        tag: "SHIPWRECK",
        title: "OLD WRECK",
        lines: ["A HULL LIES", "BROKEN ON ROCKS"],
        a: { label: "SEARCH HULL", desc: `-1 SUP ${wreckRelic(e) === "STORM GLASS" ? "STORMGLASS" : "TOOTH"}` },
        b: { label: "STRIP PLANKS", desc: `+1 SUP +${goldFor(e, 6)}G` },
      };
    case "trap":
      return {
        kind,
        tag: "STONE CAIRN",
        title: "MARKED PATH",
        lines: e.scouted ? ["YOUR SCOUT SPOTTED", "A SNARE AHEAD"] : ["STACKED STONES", "WARN OF DANGER"],
        a: { label: "STEP AROUND", desc: e.scouted ? "SAFE" : v.supplies > 0 ? "-1 SUPPLY" : "-1 HEART" },
        b: { label: "PUSH ON", desc: e.scouted ? `+${goldFor(e, 10)}G` : `+${goldFor(e, 10)}G -1 HEART` },
      };
    case "shrine":
      return {
        kind,
        tag: "NOTE SHRINE",
        title: e.title,
        lines: [`${e.words} WORDS CARVED`, "IN THE BEACON STONE"],
        a: { label: "CLAIM CHART", desc: "WIDER SIGHT" },
        b: { label: "LEAVE OFFER", desc: `-${OFFER_COST}G BIGGER HOLD` },
      };
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const inRect = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export interface ExploreLayout {
  lx: number;
  rx: number;
  /** The HUD bar's sides: it hugs the top edge, so it also clears the rounded corners. */
  barLx: number;
  barRx: number;
  ty: number;
  cx: number;
  /** Bottom of the HUD bar. */
  barH: number;
  sail: Rect;
  card: Rect;
  a: Rect;
  b: Rect;
  panel: Rect;
  panelBtn: Rect;
  horizon: number;
  foeY: number;
  captainY: number;
  toastY: number;
}

/** Everything sits between `hud.left` and `W - hud.right`, below `hud.top` and above `hud.bottom`; the top bar also clears the corners. */
export function exploreLayout(W: number, H: number, hud: PixelHud): ExploreLayout {
  const F = hudFrame(hud, W, H);
  const { lx, rx } = F.content, ty = F.top.y, barLx = F.top.lx, barRx = F.top.rx;
  const cx = Math.round((lx + rx) / 2);
  const avail = rx - lx;
  const barH = ty + 19;
  const sail = { x: barRx - 38, y: ty, w: 38, h: 15 };
  const cw = Math.min(196, avail);
  const card = { x: Math.round(cx - cw / 2), y: barH + 4, w: cw, h: 78 };
  const gap = 6;
  const bw = Math.floor((cw - 14 - gap) / 2);
  const a = { x: card.x + 7, y: card.y + 49, w: bw, h: 24 };
  const b = { x: a.x + bw + gap, y: a.y, w: bw, h: 24 };
  const horizon = Math.max(card.y + card.h + 16, Math.round(H * 0.6));
  const captainY = H - Math.max(24, hud.bottom + 18);
  const foeY = Math.round(horizon + (captainY - horizon) * 0.42);
  const pw = Math.min(176, avail);
  const panel = { x: Math.round(cx - pw / 2), y: Math.max(barH + 8, horizon - 34), w: pw, h: 100 };
  const panelBtn = { x: panel.x + 14, y: panel.y + panel.h - 28, w: pw - 28, h: 20 };
  const toastY = H - Math.max(14, hud.bottom + 10);
  return { lx, rx, barLx, barRx, ty, cx, barH, sail, card, a, b, panel, panelBtn, horizon, foeY, captainY, toastY };
}

/** The "LAND AT …" prompt shown at sea next to an unexplored note island. */
export function landRect(W: number, H: number, hud: PixelHud, cargo: number): Rect {
  const F = hudFrame(hud, W, H), { lx, rx } = F.content;
  const w = Math.min(150, rx - lx), h = 20;
  return { x: Math.round((lx + rx - w) / 2), y: F.bottom.y - 6 - cargo * 8 - h - 8, w, h };
}
