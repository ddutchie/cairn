/**
 * Cairn — models.dev catalog helpers (shared desktop + mobile).
 *
 * Pure, framework-free: parses the public models.dev catalog
 * (https://models.dev/api.json) into a compact per-model record (context window,
 * per-1M-token input/output cost, image-input support, tool-calling, owning
 * provider) and formats per-1M costs for display. The fetch + persistence layer
 * lives with each caller (desktop: localStorage; mobile: app_settings).
 *
 * Models.dev pricing units are USD per 1M tokens (`cost.input` / `cost.output`);
 * cheap models can be well under $0.01/M, so the formatter keeps significant
 * digits instead of collapsing to $0. Provider logos are served at
 * /logos/{provider}.svg.
 */

/** Per-model info extracted from the models.dev catalog. */
export interface ModelInfo {
  /** Context window in tokens (limit.context). */
  context: number | null;
  /** USD per 1M input tokens (cost.input). */
  input: number | null;
  /** USD per 1M output tokens (cost.output). */
  output: number | null;
  /** Input modalities (modalities.input): text, image, pdf, video, audio… */
  modes: string[];
  /** Whether the model supports tool calls, when known. */
  toolCall: boolean | null;
  /** models.dev provider slug that owns the catalog entry (drives the logo). */
  provider: string | null;
}

/** Provider logo URL served by models.dev. */
export function providerLogoUrl(provider: string): string {
  return `https://models.dev/logos/${provider}.svg`;
}

/**
 * Whether a model can take image input. Unknown models (not in the catalog) are
 * allowed — the gate is conservative and only blocks models models.dev
 * explicitly lists as not accepting images.
 */
export function supportsImageInput(info: ModelInfo | null): boolean {
  return info ? info.modes.includes("image") : true;
}

/** A single input-capability chip (icon/label + tooltip title). */
export interface ModelModeChip {
  key: string;
  label: string;
  title: string;
}

const MODE_CHIP_DEFS: Record<string, ModelModeChip> = {
  text: { key: "text", label: "T", title: "Text input" },
  image: { key: "image", label: "I", title: "Image input" },
  pdf: { key: "pdf", label: "PDF", title: "PDF input" },
  video: { key: "video", label: "V", title: "Video input" },
  audio: { key: "audio", label: "A", title: "Audio input" },
};

/** The model's input-modality chips in a stable order (text → image → pdf → …). */
export function modelInputChips(info: ModelInfo | null): ModelModeChip[] {
  if (!info) return [];
  const order = ["text", "image", "pdf", "video", "audio"];
  const chips: ModelModeChip[] = [];
  for (const m of order) {
    if (info.modes.includes(m)) {
      const def = MODE_CHIP_DEFS[m];
      if (def) chips.push(def);
    }
  }
  return chips;
}

/**
 * Flatten the models.dev catalog into id → ModelInfo. Model ids are keyed as
 * published (bare, e.g. "glm-5"); lookupModelInfo handles gateway/proxy ids.
 */
export function parseModelCatalog(catalog: unknown): Record<string, ModelInfo> {
  const map: Record<string, ModelInfo> = {};
  if (!catalog || typeof catalog !== "object") return map;
  for (const [slug, provider] of Object.entries(catalog as Record<string, unknown>)) {
    const models = (provider as { models?: unknown })?.models;
    if (!models || typeof models !== "object") continue;
    for (const [id, model] of Object.entries(models as Record<string, unknown>)) {
      const m = model as {
        limit?: { context?: unknown };
        cost?: { input?: unknown; output?: unknown };
        modalities?: { input?: unknown };
        tool_call?: unknown;
      };
      const readNum = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      const inModes = Array.isArray(m.modalities?.input)
        ? (m.modalities!.input as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      map[id] = {
        context: readNum(m.limit?.context),
        input: readNum(m.cost?.input),
        output: readNum(m.cost?.output),
        modes: inModes,
        toolCall: typeof m.tool_call === "boolean" ? m.tool_call : null,
        provider: slug,
      };
    }
  }
  return map;
}

/**
 * Normalize a model id to a canonical form so proxy/gateway variants resolve to
 * the underlying catalog entry. Handles:
 *  - provider path/dotted prefixes: `anthropic/…`, `us.anthropic.…`, `~anthropic/…`
 *  - gateway/vendor prefixes: `playground-`, `databricks-`, `duo-chat-`, `anthropic--`, `stealth/`
 *  - variant suffixes: `:thinking`, `@default`, `-thinking`, `-fast`, `-latest`, dates, `-v1:0`
 * The result is lowercase with those decorations stripped. Not exhaustive — just
 * enough to catch the common real-world proxy id shapes.
 */
export function normalizeModelId(id: string): string {
  let s = id.toLowerCase().trim();
  // Strip a leading gateway "provider:" prefix that some endpoints prepend to the
  // model id (e.g. "merge:deepseek/deepseek-v4-flash" → "deepseek/deepseek-v4-flash",
  // "merge:deepseek-v4-flash" → "deepseek-v4-flash"). We must NOT confuse this with
  // a colon-delimited VARIANT suffix on a plain model id (e.g. "gpt-4:thinking" or
  // "gpt-4:thinking-v2"), which the later ":" split handles. So only strip when the
  // tail is a real model id: it either carries a path ("/"), or its first token is
  // not a known variant keyword.
  const providerPrefix = s.match(/^([a-z0-9_-]+):(.+)$/);
  if (providerPrefix) {
    const tail = providerPrefix[2];
    const firstToken = tail.split(/[/-]/)[0];
    const isVariantTail = /^(thinking|think|fast|free|latest|reasoning|distilled|low|medium|high|max)$/.test(firstToken);
    if (tail.includes("/") || (/-/.test(tail) && !isVariantTail)) {
      s = tail;
    }
  }
  // Keep only the last path segment (e.g. "anthropic/claude-opus-4" → "claude-opus-4").
  if (s.includes("/")) s = s.split("/").pop() as string;
  // Strip a leading "~" (some gateways prefix aliases with it).
  s = s.replace(/^~/, "");
  // Strip region + vendor dotted prefixes: "us.anthropic.", "anthropic.", "eu.".
  s = s.replace(/^[a-z]{2}\.anthropic\./, "").replace(/^anthropic\./, "").replace(/^[a-z]{2}\./, "");
  // Drop everything after ":" or "@" (thinking budgets, versions, dates).
  s = s.split(":")[0].split("@")[0];
  // Strip common gateway/vendor prefixes.
  s = s.replace(
    /^(playground-|databricks-|duo-chat-|anthropic--|anthropic-|stealth-|global\.|us\.|eu\.|au\.|jp\.)/,
    "",
  );
  // Strip trailing variant suffixes.
  s = s.replace(/-(thinking|think|fast|free|latest|reasoning|distilled)$/, "");
  // Strip trailing dates ("-20250514") and pure version tags ("-v1", "-v1:0").
  // The version tag may only continue with dot/colon-separated numbers — it must
  // NOT swallow a trailing word like "-flash" or "-luna" (e.g. "deepseek-v4-flash"
  // must stay intact, not collapse to "deepseek").
  s = s.replace(/-\d{6,8}$/, "").replace(/-v\d+([.:]\d+)*$/, "");
  return s;
}

// Lazily-built normalized index (normalized id → ModelInfo) for fuzzy matching.
// Rebuilt whenever the passed map changes identity.
let normIndex: Record<string, ModelInfo> | null = null;
let normIndexFor: Record<string, ModelInfo> | null = null;

/**
 * Resolve a model id to its catalog entry via exact → normalized → separator-
 * variant lookup, so proxy/gateway ids (e.g. "playground-claude-opus-4-8" or
 * "merge:deepseek/deepseek-v4-flash") resolve to the underlying model. Returns
 * null when the id isn't in the catalog.
 */
export function lookupModelInfo(
  map: Record<string, ModelInfo>,
  modelId: string,
): ModelInfo | null {
  if (map[modelId]) return map[modelId];
  if (normIndexFor !== map) {
    const idx: Record<string, ModelInfo> = {};
    for (const [id, info] of Object.entries(map)) {
      const n = normalizeModelId(id);
      // First writer wins — exact-looking short ids tend to be enumerated first.
      if (!(n in idx)) idx[n] = info;
    }
    normIndex = idx;
    normIndexFor = map;
  }
  const n = normalizeModelId(modelId);
  if (normIndex![n]) return normIndex![n];
  // Try swapping version separators both ways (e.g. "4-8" ⇄ "4.8").
  const dashToDot = n.replace(/(\d)-(\d)/g, "$1.$2");
  if (normIndex![dashToDot]) return normIndex![dashToDot];
  const dotToDash = n.replace(/(\d)\.(\d)/g, "$1-$2");
  if (normIndex![dotToDash]) return normIndex![dotToDash];
  return null;
}

/**
 * Compact "in/out" cost label for a model, in USD per 1M tokens. "$1/$3.2" for
 * the usual case, "free" when both are 0, null when neither is known. Tiny
 * prices keep significant digits so $0.0008 doesn't collapse to $0.
 */
export function formatModelCost(input: number | null, output: number | null): string | null {
  if (input == null && output == null) return null;
  const i = input ?? 0;
  const o = output ?? 0;
  if (i === 0 && o === 0) return "free";
  const fmt = (n: number): string => {
    if (n === 0) return "$0";
    const abs = Math.abs(n);
    const s = abs >= 1 ? abs.toFixed(2).replace(/\.?0+$/, "") : String(parseFloat(abs.toPrecision(3)));
    return `${n < 0 ? "-" : ""}$${s}`;
  };
  return `${fmt(i)}/${fmt(o)}`;
}
