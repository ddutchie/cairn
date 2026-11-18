# Cairn design language

Where to start when you design or restyle a view. It describes what the **Today** and **Overview** pages already do, because those two are the reference implementations. If this document and those pages disagree, fix whichever is wrong and tell the next person.

Mechanical rules (colour tokens, the type scale, elevation, primitives, lint) live in [`AGENTS.md`](../AGENTS.md#styling-rules). This document covers the layer above them: how the pieces are composed so every view looks like the same product.

## The idea

Cairn is a calm place to decide what to do next. The interface should read like a well-set page, not a dashboard.

1. **One memorable thing per view.** Today's is the headline and the cairn stack. Overview's is the project name. Everything else stays quiet so that one thing lands.
2. **Say a number once.** If a figure already appears in a heading, a legend or a progress bar, do not repeat it in a tile. Both reference pages lost a stat row for this reason.
3. **Structure is information.** A rule, a border or a dot has to mean something (a section starts here, this is overdue). If it only decorates, remove it.
4. **Open before boxed.** Sections sit on the page with a rule under the heading. Only individual items (a decision, a draft, a task) get a surface of their own. A box around a group of boxes is the thing to avoid.

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

### Item card
A rounded-lg block: `border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3`. A meta line on top (kind, status in colour, where it lives), the title, then a quiet detail line. Hover moves the surface one step (`hover:bg-[var(--surface-3)]`). No lift, no tilt, no shadow. Clickable cards use `FOCUS_RING`.

The one item that matters most gets a larger display-face title and an accent-tinted surface (Today's focus decision). Only one per view.

### Hero
Headline, lede, then actions. Whatever sits beside it is one illustration or one card, not a row of stats. If a count matters, it belongs in the lede ("Two decisions need you…") or in a legend.

### Progress
The number once in the display face, a sentence about what it is made of, a thin solid bar, the dates. No ring plus numeral plus percent.

### Folding
Anything that restates information already visible (Today's block list under the day strip) folds behind a text button with `aria-expanded`, and stays one keyboard action away.

## Colour carries status

Status colour (`--danger`, `--warning`, `--success`, `--info`) goes on **text or a small dot**, next to a word that says the same thing (Overdue, Due today). It never fills a card, tints a gradient or stripes a tile. Colour is never the only signal.

The accent marks the primary action and the thing to look at first. It is not a decoration.

## Motion

- Motion answers an action: expanding, opening an earlier brief, marking done.
- Nothing animates on load except one deliberate moment per view (the stack dropping in when a new brief arrives).
- No hover lift, tilt or glow on cards. Respect `prefers-reduced-motion`.

## Copy

- Write what the thing is or does, in plain words. "Needs attention", not "Instrument panel".
- Sentence case, active verbs, buttons name the action ("View board", "Open insights").
- Prefer a comma or a full stop to `·` or `—` as a separator inside a sentence. Middle dots are fine between short metadata (`Cairn · Slack`).
- Empty states say what to do next, not how the system feels.
- No implementation notes in the UI (we removed "Status pills are labeled + color…" from Overview).

## Things we removed on purpose

Do not bring these back without a reason that is specific to the view:

- Rows of identical stat tiles, especially with a coloured top stripe.
- A ring, a numeral and a percent all showing the same value.
- Gradient washes and radial glows on cards.
- Cards inside a bordered box inside the page.
- Hover tilt (`TiltCard` is deleted).
- Tinted danger/warning fills on whole cards.
- Icon chips beside every section title.

## Where the code lives

| Thing | File |
|---|---|
| Tokens, type scale, elevation | `src/app/globals.css` |
| Buttons, `FOCUS_RING` | `src/components/ui/button.tsx` |
| Other primitives | `src/components/ui/` |
| `PanelHeading`, `CollapsibleSection` | `src/components/layout/project-overview/primitives.tsx` |
| Today view and its parts | `src/components/today/` |
| Overview and its panels | `src/components/layout/project-overview/` |
| Screenshot fixture (rich mock data, including a week of Today history) | `tests/fixtures/screenshot-fixture.ts` |

`PanelHeading` currently lives in the Overview folder. When a third view adopts it, move it to `src/components/ui/` and export it from there.

## Checking your work

1. Run the app against the screenshot fixture and look at light, dark and a narrow width. `npm run screenshots` uses the same fixture.
2. Ask: what is the one memorable thing? Is any number said twice? Is any box only wrapping other boxes? Is colour doing anything other than status or the primary action?
3. `npm run type-check:all`, then lint the files you touched.
4. Tab through it: every control has a visible focus ring and a name.

## Status

| View | State |
|---|---|
| Today | Reference. |
| Overview | Aligned. Remaining: the radar's six measure tiles and the Activity feed's per-row dates are still the old style. |
| Board, Notes, Calendar, Flow, Knowledge Graph, Insights, Agent, Automations, Usage, Settings | Not audited. Start with Automations and Usage: they are the closest in shape (lists, stats, status) and will show first whether the item card and section heading cover real cases. |

When you align a view, update this table.
