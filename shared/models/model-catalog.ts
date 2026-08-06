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
export interface ModelInfo {  /** Context window in tokens (limit.context). */
  context: number | null;
  /** Max output/completion tokens the model can emit in one reply (limit.output).
   *  Shown as guidance in AI/Agent settings (the ceiling a manual "Max output
   *  tokens" cap can use). null when unknown. */
  maxOutput: number | null;
  /** USD per 1M input tokens (cost.input). */
  input: number | null;
  /** USD per 1M output tokens (cost.output). */
  output: number | null;
  /** Input modalities (modalities.input): text, image, pdf, video, audio… */
  modes: string[];
  /** Whether the model supports tool calls, when known. */
  toolCall: boolean | null;
  /** Whether the model is a reasoning/thinking model (models.dev `reasoning`). */
  reasoning: boolean | null;
  /** models.dev provider slug that owns the catalog entry (drives the logo). */
  provider: string | null;
}

/**
 * A token *limit* is only meaningful when it's a positive integer. models.dev
 * has real entries with `limit.output: 0` (~180 at time of writing); a 0 or
 * negative cap is unusable (it would drive a broken `max={0}` on the settings
 * stepper), so coerce zero/negative/non-finite to null. Fractions are floored.
 */
export function positiveTokenLimit(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return null;
  return Math.floor(v);
}

/** Provider logo URL served by models.dev. */
export function providerLogoUrl(provider: string): string {
  return `https://models.dev/logos/${provider}.svg`;
}

/**
 * models.dev lists every model under EVERY provider that hosts it (a single
 * model can appear under 30+ provider slugs), and parseModelCatalog flattens
 * those into one entry — so `info.provider` is whoever models.dev happened to
 * enumerate first, not the model's own brand. `deepseek/deepseek-v4-flash` can
 * resolve to provider "hpc-ai" or "cortecs" and render that logo instead of
 * DeepSeek's.
 *
 * logoProviderFor() picks the logo slug deterministically so the glyph matches
 * the model's brand, not the arbitrary first-listed host:
 *   1. a leading provider token in the id naming a known brand
 *      ("deepseek/deepseek-v4-flash" → "deepseek", "~anthropic/…" → "anthropic"),
 *   2. a brand-name match on the base id ("gpt-5.2" → "openai", "gemma-3" → "google"),
 *   3. the catalog's own provider slug as a last resort.
 * It also returns a slug for models NOT in the catalog (steps 1–2), so a brand
 * icon can render even before/without catalog data.
 */
const LOGO_SLUG_BY_TOKEN: Record<string, string> = {
  deepseek: "deepseek",
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  xai: "xai",
  meta: "meta",
  mistralai: "mistralai",
  cohere: "cohere",
  amazon: "amazon",
  aws: "amazon",
  microsoft: "microsoft",
  alibaba: "alibaba",
  nvidia: "nvidia",
  databricks: "databricks",
};

const LOGO_BRAND_MATCHES: Array<[RegExp, string]> = [
  [/^claude/, "anthropic"],
  [/^anthropic/, "anthropic"],
  [/^gpt/, "openai"],
  [/^o[1-9]/i, "openai"], // o1/o3/o4/o5…
  [/^grok/, "xai"],
  [/^gemini/, "google"],
  [/^gemma/, "google"],
  [/^palm/, "google"],
  [/^llama/, "meta"],
  [/^mistral|^mixtral|^codestral|^ministral/, "mistralai"],
  [/^deepseek/, "deepseek"],
  [/^qwen/, "alibaba"],
  [/^command(-[a-z]+)?/, "cohere"],
  [/^phi/, "microsoft"],
  [/^dbrx/, "databricks"],
  [/^nous/, "nousresearch"],
];

/** The provider slug whose logo best identifies `modelId` (see above). */
export function logoProviderFor(
  modelId: string,
  catalogProvider: string | null,
  canonicalMap?: Record<string, string> | null,
): string | null {
  if (!modelId) return null;
  // 0. The canonical owner from models.json (when loaded) — data-driven and
  //    covers every lab-owned model, including ones the heuristic table misses.
  if (canonicalMap) {
    const canonical = canonicalProviderFor(canonicalMap, modelId);
    if (canonical) return canonical;
  }
  const s = modelId.trim();
  const head = s.toLowerCase().split(/[/:]/)[0].replace(/^[~.]+/, "");
  const byToken = LOGO_SLUG_BY_TOKEN[head];
  if (byToken) return byToken;
  const base = s.toLowerCase().split("/").pop() as string;
  for (const [re, slug] of LOGO_BRAND_MATCHES) {
    if (re.test(base)) return slug;
  }
  return catalogProvider;
}

/** models.dev logo URL for a model id, or null when nothing resolves. */
export function providerLogoUrlFor(
  modelId: string,
  catalogProvider: string | null,
  canonicalMap?: Record<string, string> | null,
): string | null {
  const slug = logoProviderFor(modelId, catalogProvider, canonicalMap);
  return slug ? providerLogoUrl(slug) : null;
}

/**
 * Hostname → models.dev provider slug for well-known direct vendors. Used as a
 * brand-logo fallback for saved OpenAI-compatible providers that the cairn-
 * community catalog has no inline `iconSvg` for (e.g. OpenAI, Together, Groq,
 * Fireworks, Neuralwatt) — models.dev serves their logos at /logos/{slug}.svg.
 * Keyed by hostname so path/version differences (`/v1`, trailing slash) don't
 * matter. Not exhaustive; unknown hostnames fall through to the generic glyph.
 */
const ENDPOINT_LOGO_SLUGS: Record<string, string> = {
  "api.openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "google",
  "aiplatform.googleapis.com": "google",
  "api.deepseek.com": "deepseek",
  "openrouter.ai": "openrouter",
  "api.together.ai": "together",
  "api.together.xyz": "together",
  "api.groq.com": "groq",
  "api.fireworks.ai": "fireworks-ai",
  "api.x.ai": "xai",
  "api.mistral.ai": "mistralai",
  "api.cohere.ai": "cohere",
  "api.cohere.com": "cohere",
  "integrate.api.nvidia.com": "nvidia",
  "api.neuralwatt.com": "neuralwatt",
  "api.perplexity.ai": "perplexity",
};

/**
 * models.dev logo slug for an OpenAI-compatible endpoint's hostname, or null.
 * Lets a saved provider that shares a hostname with a known direct vendor
 * (whether installed from the community catalog or added manually) render that
 * vendor's brand mark even when no inline iconSvg exists.
 */
export function endpointLogoSlug(baseUrl: string): string | null {
  const u = (baseUrl ?? "").trim();
  if (!u) return null;
  let host: string;
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch {
    // Bare host like "api.openai.com" — new URL needs a scheme.
    const m = u.match(/^([a-z0-9.-]+)(?:\/|$)/i);
    host = (m?.[1] ?? "").toLowerCase();
  }
  return ENDPOINT_LOGO_SLUGS[host] ?? null;
}

/** Parse models.json → canonical <provider>/<model> id → owner provider slug. */
export function parseCanonicalCatalog(modelsJson: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!modelsJson || typeof modelsJson !== "object") return out;
  for (const id of Object.keys(modelsJson)) {
    const idx = id.indexOf("/");
    if (idx > 0) out[id] = id.slice(0, idx);
  }
  return out;
}

// Lazily-built normalized index (normalized canonical id → owner provider).
let canonNormIndex: Record<string, string> | null = null;
let canonNormFor: Record<string, string> | null = null;

/**
 * Resolve a model id to its canonical OWNER provider slug (e.g. "deepseek" for
 * "deepseek/deepseek-v4-flash" or "deepseek-v4-flash"). Matches exact canonical
 * ids first, then a normalized fuzzy match (same normalization as
 * lookupModelInfo) so proxy/gateway spellings resolve. Returns null when the
 * id isn't a known canonical model.
 */
export function canonicalProviderFor(
  canonicalMap: Record<string, string>,
  modelId: string,
): string | null {
  if (!canonicalMap || !modelId) return null;
  if (canonicalMap[modelId]) return canonicalMap[modelId];
  if (canonNormFor !== canonicalMap) {
    const idx: Record<string, string> = {};
    for (const [id, provider] of Object.entries(canonicalMap)) {
      const n = normalizeModelId(id);
      // First writer wins — two canonical ids can normalize the same way.
      if (!(n in idx)) idx[n] = provider;
    }
    canonNormIndex = idx;
    canonNormFor = canonicalMap;
  }
  const n = normalizeModelId(modelId);
  if (canonNormIndex![n]) return canonNormIndex![n];
  // Try swapping version separators both ways (e.g. "4-8" ⇄ "4.8").
  const dashToDot = n.replace(/(\d)-(\d)/g, "$1.$2");
  if (canonNormIndex![dashToDot]) return canonNormIndex![dashToDot];
  const dotToDash = n.replace(/(\d)\.(\d)/g, "$1-$2");
  if (canonNormIndex![dotToDash]) return canonNormIndex![dotToDash];
  return null;
}

/**
 * Whether a model can take image input. Unknown models (not in the catalog) are
 * allowed — the gate is conservative and only blocks models models.dev
 * explicitly lists as not accepting images. Defensive against legacy/cached
 * entries that predate the `modes` field (treated as no known modes).
 */
export function supportsImageInput(info: ModelInfo | null): boolean {
  return info ? (info.modes ?? []).includes("image") : true;
}

/** A single input-capability chip (icon key + tooltip title). */
export interface ModelModeChip {
  key: string;
  /** Fallback label (e.g. accessibility / non-icon renderers). */
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
  const modes = info.modes ?? [];
  const chips: ModelModeChip[] = [];
  for (const m of order) {
    if (modes.includes(m)) {
      const def = MODE_CHIP_DEFS[m];
      if (def) chips.push(def);
    }
  }
  return chips;
}

/**
 * Normalize a ModelInfo entry so it can't crash consumers: guarantees `modes`
 * is an array, and migrates the pre-`modes` legacy `image` boolean. Used when
 * reading cached catalog maps that may predate the current shape.
 */
export function normalizeModelInfo(info: ModelInfo | null | undefined): ModelInfo | null {
  if (!info || typeof info !== "object") return null;
  const legacy = info as ModelInfo & { image?: boolean };
  const modes = Array.isArray(info.modes)
    ? info.modes
    : typeof legacy.image === "boolean"
      ? (legacy.image ? ["text", "image"] : ["text"])
      : [];
  return {
    context: typeof info.context === "number" ? info.context : null,
    maxOutput: positiveTokenLimit(info.maxOutput),
    input: typeof info.input === "number" ? info.input : null,
    output: typeof info.output === "number" ? info.output : null,
    modes,
    toolCall: typeof info.toolCall === "boolean" ? info.toolCall : null,
    reasoning: typeof info.reasoning === "boolean" ? info.reasoning : null,
    provider: typeof info.provider === "string" ? info.provider : null,
  };
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
        limit?: { context?: unknown; output?: unknown };
        cost?: { input?: unknown; output?: unknown };
        modalities?: { input?: unknown };
        tool_call?: unknown;
        reasoning?: unknown;
      };
      const readNum = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      const inModes = Array.isArray(m.modalities?.input)
        ? (m.modalities!.input as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      map[id] = {
        context: readNum(m.limit?.context),
        maxOutput: positiveTokenLimit(m.limit?.output),
        input: readNum(m.cost?.input),
        output: readNum(m.cost?.output),
        modes: inModes,
        toolCall: typeof m.tool_call === "boolean" ? m.tool_call : null,
        reasoning: typeof m.reasoning === "boolean" ? m.reasoning : null,
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

/**
 * Default max output tokens used only as a floor when a user's manual value is
 * missing/invalid but they've turned Auto off. Comfortably above a "thinking"
 * model's reasoning budget. NOT used in Auto mode (Auto omits the field).
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Resolve the `max_tokens` to send for a chat request, or `undefined` to OMIT
 * the field entirely.
 *
 * The correct default is to send NOTHING: given no cap, providers run the model
 * to its natural `finish_reason:"stop"` — emitting full reasoning AND a complete
 * answer, typically using far fewer tokens than any cap we'd pick. A fixed cap
 * only ever truncates the tail case: a "thinking" model can spend the whole
 * budget on reasoning and stop with empty content (`finish_reason:"length"`),
 * which then trips a "content or tool_calls must be set" 400 on the next
 * message. (That regression is what the old hardcoded 4096 caused.)
 *
 * So:
 *  - `userOverride` (>= 1) → send it, floored. A user's explicit cap is a
 *    deliberate cost/latency ceiling; honour it.
 *  - otherwise (Auto, or a fractional/zero/negative value) → return `undefined`:
 *    omit `max_tokens` and let the model finish naturally, bounded only by the
 *    provider's own server-side limit.
 */
export function resolveMaxOutputTokens(userOverride?: number | null): number | undefined {
  // Require >= 1 before flooring: a fractional cap in (0,1) would floor to 0 and
  // send `max_tokens: 0` (a broken cap), which is worse than omitting the field.
  if (typeof userOverride === "number" && Number.isFinite(userOverride) && userOverride >= 1) {
    return Math.floor(userOverride);
  }
  return undefined;
}
