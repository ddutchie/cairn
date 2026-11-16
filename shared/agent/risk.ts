/**
 * The one RiskClass — shared by the engine policy (`electron/agent/rules.ts`)
 * and the UI taxonomy (`shared/agent/tool-risk.ts`).
 *
 * Superset of both predecessors: the engine's 5-member variant (with
 * WRITE_CAIRN) plus the shared 4-member variant. WRITE_CAIRN marks mutations
 * of Cairn's own data (notes/tasks/boards/idea flow); WRITE_LOCAL marks
 * filesystem mutations. Pure types only — no Electron/Node APIs.
 */
export type RiskClass = "READ" | "WRITE_CAIRN" | "WRITE_LOCAL" | "EXEC" | "EXTERNAL";
