/** Default board columns created with every new project, on desktop and mobile. */
export const DEFAULT_COLUMNS = [
  { name: "Backlog",     type: "backlog",     order: 0 },
  { name: "Todo",        type: "todo",        order: 1 },
  { name: "In Progress", type: "in_progress", order: 2 },
  { name: "Review",      type: "review",      order: 3 },
  { name: "Done",        type: "done",        order: 4 },
] as const;

/** Project statuses a person picks from (archiving is its own action, `archived_at`). */
export const PROJECT_STATUSES = ["active", "on_hold", "completed"] as const;
