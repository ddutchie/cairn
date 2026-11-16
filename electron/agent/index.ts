export * from "./events";
export * from "./gate";
export * from "./loop";
export * from "./policy";
export * from "./reviewer";
export * from "./rules";
export * from "./tool-types";
export * from "./provider";
export * from "./context";

/**
 * Public surface of the agent engine (F11/C5 boundary).
 *
 * Code outside `electron/agent/` reaches the engine ONLY through this file —
 * enforced by the `cairn/engine-boundary` lint rule (see
 * `eslint-rules/cairn.mjs`). Deep imports (`../agent/host`, `../agent/tool-types`,
 * …) from outside the engine are banned at lint time (type-only imports stay
 * allowed: they are erased at compile time and cannot smuggle behaviour).
 *
 * No logic lives here: every line below is a re-export of an engine module,
 * so routing an importer through this barrel changes no runtime behaviour.
 */
export * from "./host";
export * from "./host-store";
export * from "./sandbox";
export * from "./jobs";
export * from "./hooks";
export * from "./lsp";
export * from "./terminals";
export * from "./attachments";
export * from "./profiles";
export * from "./route";
export * from "./one-shot";
export * from "./session-search";
export * from "./session/log";
export * from "./session/adapter";
export * from "./session/legacy-import";
export * from "./tools/index";
export * from "./tools/schema";
