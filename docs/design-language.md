# Cairn design language

Where to start when you design or restyle a view. It describes what the **Today** and **Overview** pages already do, because those two are the reference implementations. If this document and those pages disagree, fix whichever is wrong and tell the next person.

Mechanical rules (colour tokens, the type scale, elevation, primitives, lint) live in [`AGENTS.md`](../AGENTS.md#styling-rules). This document covers the layer above them: how the pieces are composed so every view looks like the same product.

## The idea

Cairn is a calm place to decide what to do next. The interface should read like a well-set page, not a dashboard.

1. **One memorable thing per view.** Today's is the headline and the cairn stack. Overview's is the project name. Everything else stays quiet so that one thing lands.
2. **Say a number once per view.** If a figure already appears in a heading, a legend or a progress bar, do not repeat it in a tile. Today lost its stat row for this reason; Overview keeps a strip but each tile says something the others do not.
3. **Structure is information.** A rule, a border or a dot has to mean something (a section starts here, this is overdue). If it only decorates, remove it.
4. **Open lists, raised instruments.** Prose and lists of items (decisions, drafts, tasks) sit on the page under a heading with a rule. *Instruments* (a timeline, a progress ring, a flow chart, a radar) get a raised surface, because they are things you look at rather than read. A box around a group of boxes is the thing to avoid.

## Tokens

Use the CSS variables in `src/app/globals.css`. Never raw colours.

| Role | Token | Notes |
|---|---|---|
| Page | `--background` | Warm neutral, light and dark. |
| Item surface | `--surface-2` | Cards inside a section: a decision, a task, a draft. |
| Raised surface | `--surface` | The page-level card when one is needed (the Overview progress card, the Today hero when history is on). |
| Hairlines | `--border-subtle` | Section rules, item borders. `--border` only for controls. |
| Text | `--text-primary` / `-secondary` / `-tertiary` | Tertiary is for meta, never for anything that must be read. |
| Accent | `--accent` | One green. Primary action, the focus item, progress. |
| Status | `--danger`, `--warning`, `--success`, `--info` | See "Colour carries status" below. |
| Layers | `--stone-1/2/3` | The cairn's layers, and meeting blocks. |

## Type

Two faces, clearly different.

- **Display** (`font-display`, New York with Iowan/Palatino fallbacks): headlines, section headings, big numerals. Never bold. Use `font-normal`.
- **Sans** (Geist): everything you read or click.
- **Mono**: code, paths, kbd. Not dates, counts or status words (use `tabular-nums` on the sans or display face instead).

| Use | Class | Roughly |
|---|---|---|
| Page headline | `font-display text-3xl md:text-4xl font-normal leading-[1.08] tracking-tight text-balance` | 26–32px |
| Lede under it | `text-base text-[var(--text-secondary)] leading-relaxed max-w-[62ch] text-pretty` | 14px |
| Hero numeral | `font-display text-5xl leading-none tabular-nums` | 42px, one per view at most |
| Section heading | `font-display text-base` (via `PanelHeading`) | 14px |
| Focus item title | `font-display text-xl tracking-tight` | 17px |
| Item title | `text-sm font-medium` | |
| Meta | `text-2xs` or `text-xs`, `--text-tertiary` | |

Rules:
- Sizes scale with `--font-scale`. Use the scale, never `text-[Npx]`.
- Sentence case everywhere. No all-caps labels (the dock sidebar group headers are the one exception).
- Line length under 80 characters; ledes cap at `62ch`.
- Do not accent a single word in a headline (we removed an italic green suffix from the Overview title for this).

## Layout

- **Left-aligned.** No centred content blocks except empty states.
- **Vertical rhythm.** Sections are separated by `mt-9` / `mb-9` (36px). Inside a section: heading, then `mb-3`, then content, with `space-y-2.5` between items. Hero to first section is `mb-8`.
- **Width.** Content caps at `max-w-[1240px]`. Two-column splits use a dominant column plus a supporting one (`1.35fr / 1fr` on Today, `1.55fr / 0.95fr` on Overview), never three equal columns. Stack on narrow containers with `@container` queries (`@4xl:`), not viewport media queries.
- **Priority order.** What the person must decide comes first and sits above the fold at 1440×900. Reference material (activity, runs, sessions) comes last and can be collapsed.

## Patterns

### Section heading
`PanelHeading` in `src/components/layout/project-overview/primitives.tsx`. Display-face title, optional quiet note beside it, optional action at the right edge, hairline beneath.

```tsx
<PanelHeading title="Needs attention" note="10 of 38 open tasks" action={<button …>Open notes</button>} />
```

`CollapsibleSection` is the same heading with a chevron, for reference sections that can fold. Today's `LaneBox` is the same shape plus a small tone dot that matches the cairn layer it belongs to.

### Surfaces: items, instruments, reference

| Kind | Examples | Treatment |
|---|---|---|
| Open list | Today's lanes, Needs attention | Heading with a rule, items beneath. No box around the list. |
| Item | A decision, a draft, a task | `rounded-lg`, `--border-subtle`, `--surface-2` (or tinted for status), `shadow-elev-1`. |
| Instrument | Progress ring, task flow, priority, radar, the day timeline | `InstrumentCard` (`src/components/ui/panel.tsx`): `rounded-2xl`, `--surface`, `--border`, lifts and tilts toward the pointer. Wide instruments that hold interactive hover targets (the Today timeline) use `SURFACE` and do not tilt. |
| Reference | Notes summary, shipped, at risk, runs, sessions, activity | `SURFACE`: `rounded-xl`, `--surface`, `--border`, `shadow-elev-1`, heading inside. |

### Item card
A rounded block: `border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3 shadow-elev-1`. A meta line on top (kind, status in colour, where it lives), the title, then a quiet detail line. Hover moves the surface one step (`hover:bg-[var(--surface-3)]`). Items do not tilt. Clickable cards use `FOCUS_RING`.

On a page about *status* (Overview's Needs attention), an item may carry a soft tint of its status colour (about 7%) and a small icon tile in that colour, plus the label in text. Keep the tint faint and always say the status in words.

The one item that matters most gets a larger display-face title and an accent-tinted surface (Today's focus decision). Only one per view.

### Hero
Headline, lede, then actions. Whatever sits beside it is one illustration or one instrument, not a row of stats. If a count matters, it belongs in the lede ("Two decisions need you…") or in a legend. A display-face italic suffix after a title (Overview's "— backlog holds 13") is allowed when it states the single most useful fact about the page; use it once and never to repeat what the page already shows.

### Progress
An instrument: the ring holds the percentage, the display numeral holds the count ("5 of 43"), a thin bar and the dates sit beneath. Each says something different. A soft accent wash and glow are welcome here and nowhere else.

### At a glance strip
One raised strip, four tiles divided by hairlines. Each tile: a status dot (not a stripe), a short label, a display-face numeral, one line of detail. No two tiles, and no tile and the hero, may show the same number.

### Folding
Anything that restates information already visible (Today's block list under the day strip) folds behind a text button with `aria-expanded`, and stays one keyboard action away.

## Colour carries status

Status colour (`--danger`, `--warning`, `--success`, `--info`) goes on **text, a small dot or an icon tile**, next to a word that says the same thing (Overdue, Due today). A whole item may take a faint tint (see Item card) but never a saturated fill, and a tile never gets a coloured stripe. Colour is never the only signal.

The accent marks the primary action and the thing to look at first. It is not a decoration.

## Motion

- Motion answers an action: expanding, opening an earlier brief, marking done.
- Nothing animates on load except one deliberate moment per view (the stack dropping in when a new brief arrives).
- Instruments may lift and tilt toward the pointer (`InstrumentCard`); items, lists and text never do. `prefers-reduced-motion` turns the tilt off.

## Copy

- Write what the thing is or does, in plain words. "Needs attention", not "Instrument panel".
- Sentence case, active verbs, buttons name the action ("View board", "Open insights").
- Prefer a comma or a full stop to `·` or `—` as a separator inside a sentence. Middle dots are fine between short metadata (`Cairn · Slack`).
- Empty states say what to do next, not how the system feels.
- No implementation notes in the UI (we removed "Status pills are labeled + color…" from Overview).

## Things we removed on purpose

Do not bring these back without a reason specific to the view:

- Rows of identical stat tiles with coloured top stripes, and any tile that repeats a number already on the page.
- A ring, a numeral and a percent all showing the same value.
- Gradient washes and glows on anything that is not an instrument.
- A bordered box around a group of already-bordered items.
- Icon chips beside every section title.
- Hover tilt on lists, items or text.
- Developer notes in the UI ("pills are labeled + color…").

## Where the code lives

| Thing | File |
|---|---|
| Tokens, type scale, elevation | `src/app/globals.css` |
| Buttons, `FOCUS_RING` | `src/components/ui/button.tsx` |
| Other primitives | `src/components/ui/` |
| `PanelHeading`, `SURFACE`, `InstrumentCard`, `TiltCard` | `src/components/ui/panel.tsx`, `src/components/ui/tilt-card.tsx` |
| `CollapsibleSection` (a `SURFACE` with a foldable body) | `src/components/layout/project-overview/primitives.tsx` |
| Today view and its parts | `src/components/today/` |
| Overview and its panels | `src/components/layout/project-overview/` |
| Screenshot fixture (rich mock data, including a week of Today history) | `tests/fixtures/screenshot-fixture.ts` |

## Checking your work

1. Run the app against the screenshot fixture and look at light, dark and a narrow width. `npm run screenshots` uses the same fixture.
2. Ask: what is the one memorable thing? Is any number said twice? Is any box only wrapping other boxes? Is colour doing anything other than status or the primary action?
3. `npm run type-check:all`, then lint the files you touched.
4. Tab through it: every control has a visible focus ring and a name.

## Status

| View | State |
|---|---|
| Today | Reference for prose pages: open lists, one raised instrument (the day), items with a light lift. |
| Overview | Reference for instrument pages: raised instruments, at-a-glance strip, status-tinted attention items. |
| Board, Notes, Calendar, Flow, Knowledge Graph, Insights, Agent, Automations, Usage, Settings | Not audited. Start with Automations and Usage: they are the closest in shape (lists, stats, status) and will show first whether the item card and section heading cover real cases. |

When you align a view, update this table.
