/** Default board columns created with every new project. */
export const DEFAULT_COLUMNS = [
  { name: "Backlog",     type: "backlog",     order: 0 },
  { name: "Todo",        type: "todo",        order: 1 },
  { name: "In Progress", type: "in_progress", order: 2 },
  { name: "Review",      type: "review",      order: 3 },
  { name: "Done",        type: "done",        order: 4 },
] as const;
