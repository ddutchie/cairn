/**
 * Built-in starter templates offered on-demand (per-project). Kept as plain
 * data so both the desktop and mobile UIs can seed them via their normal
 * note-create path (type="template"). Bodies use {{variables}} resolved by
 * `instantiateTemplate`.
 */

export interface StarterTemplate {
  /** Stored note title (prefixed "Template:" by the UI when created). */
  name: string;
  body: string;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    name: "Meeting Notes",
    body: `# {{title}} — {{date}}

**Attendees:**
**Date:** {{date}} {{time}}

## Agenda

## Discussion

## Decisions

## Action items
- [ ] `,
  },
  {
    name: "Weekly Review — {{weekOf}}",
    body: `# Weekly Review — week of {{weekOf}}

## Wins this week

## What didn't get done

## Blockers

## Priorities for next week
- [ ] `,
  },
  {
    name: "Daily Standup — {{date}}",
    body: `# Standup — {{date}}

**Yesterday:**

**Today:**

**Blockers:**`,
  },
];
