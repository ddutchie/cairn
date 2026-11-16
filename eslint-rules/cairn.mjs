/**
 * Cairn's own lint rules.
 *
 * `icon-button-label`: every icon-only `<button>` should be an `IconButton`:
 * its required `label` is the tooltip and the accessible name, and it brings
 * the shared shape and focus ring. Deliberate exceptions (the chat send/stop
 * glow, a drag handle that spreads listeners, a round logo chip) carry an
 * `eslint-disable-next-line cairn/icon-button-label -- <why>` comment.
 *
 * `engine-boundary`: the F11/C5 engine seam. Outside `electron/agent/`, the
 * engine is reached ONLY through its public surface
 * `electron/agent/index.ts` (type-only imports stay allowed — they are erased
 * at compile time). Inside `electron/agent/`, app code is reached ONLY
 * through `./host-store`, except the explicit allowlist below.
 */

import path from "node:path";

function isIcon(el) {
  if (!el || el.type !== "JSXElement") return false;
  const name = el.openingElement.name;
  return name.type === "JSXIdentifier" && /^[A-Z]/.test(name.name) && el.children.length === 0;
}

/** An icon, or an expression that only ever renders an icon (or nothing):
 *  `{pinned ? <PinOff /> : <Pin />}`, `{open && <X />}`. */
function rendersOnlyIcon(node) {
  if (isIcon(node)) return true;
  if (node.type === "JSXExpressionContainer") return rendersOnlyIcon(node.expression);
  if (node.type === "ConditionalExpression") {
    const branches = [node.consequent, node.alternate];
    return branches.some(isIcon) && branches.every((b) => isIcon(b) || isEmpty(b) || rendersOnlyIcon(b));
  }
  if (node.type === "LogicalExpression" && node.operator === "&&") return isIcon(node.right);
  return false;
}

function isEmpty(node) {
  return node.type === "Literal" && (node.value === null || node.value === false || node.value === "");
}

function isIconOnly(node) {
  const kids = node.children.filter((c) => !(c.type === "JSXText" && !c.value.trim()));
  return kids.length === 1 && rendersOnlyIcon(kids[0]);
}

const iconButtonLabel = {
  meta: {
    type: "suggestion",
    docs: { description: "Use IconButton for icon-only buttons" },
    messages: {
      useIconButton:
        "Icon-only button: use IconButton (ui/icon-button), whose required label is the tooltip and the accessible name. For a deliberate exception, disable this rule on the line and say why.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(node) {
        const open = node.openingElement;
        if (open.name.type !== "JSXIdentifier" || open.name.name !== "button") return;
        if (isIconOnly(node)) context.report({ node: open, messageId: "useIconButton" });
      },
    };
  },
};

/**
 * Engine boundary (F11/C5).
 *
 * Outside `electron/agent/`, the engine is reached ONLY through its public
 * surface `electron/agent/index.ts`. Inside `electron/agent/`, app code is
 * reached ONLY through `./host-store` — except:
 *
 * - `session-search.ts` → `electron/db/embeddings-queries`,
 *   `electron/embeddings/cosine`, `electron/runtime/client` (lazy): the
 *   semantic session index is the single caller of the embedding persistence
 *   layer; threading four db fns through HostStore would widen the seam for
 *   one caller, `toFloat32` is a pure helper, and the runtime client is
 *   loaded lazily so unit importers never pull in the worker client.
 * - `electron/lib/proc` + `electron/lib/git-exec`: F6 process helpers (B5 —
 *   `origin/refactor/b5-proc-helper`). The engine's spawn-heavy modules use
 *   them directly instead of raw `node:child_process`.
 *
 * Deliberately out of scope (unchanged, matching `host-store.ts`): `../mcp/*`
 * and `../notes-files` (documented there as left direct), `node:child_process`
 * (`lsp.ts` and `sandbox.ts` keep managed spawns even after B5), and every
 * `shared/*` import (`shared/` is the pure-logic home, not app code).
 */
const ENGINE_INDEX = "electron/agent/index.ts";
const ENGINE_PREFIX = "electron/agent/";
const APP_PREFIXES = ["electron/db/", "electron/lib/", "electron/embeddings/", "electron/runtime/"];

// Repo-relative file -> repo-relative targets it may value-import.
const INSIDE_ALLOW = new Map([
  [
    "electron/agent/session-search.ts",
    new Set([
      "electron/db/embeddings-queries.ts",
      "electron/embeddings/cosine.ts",
      "electron/runtime/client.ts",
    ]),
  ],
]);

// F6 process helpers (B5): any engine module may use these directly.
const PROC_ALLOW = new Set(["electron/lib/proc.ts", "electron/lib/git-exec.ts"]);

/** Repo-relative posix path parts for files under `<repo>/electron/`, else null. */
function electronParts(absFilename) {
  const norm = absFilename.split(path.sep).join("/");
  const i = norm.indexOf("/electron/");
  if (i === -1) return null;
  return norm.slice(i + 1).split("/");
}

/** Resolve a relative module specifier to a repo-relative posix path (best effort, no fs). */
function resolveRelative(fromAbs, spec) {
  let abs = path.resolve(path.dirname(fromAbs), spec).split(path.sep).join("/");
  if (abs.endsWith("/")) abs = abs.slice(0, -1);
  const i = abs.indexOf("/electron/");
  const rel = i === -1 ? abs : abs.slice(i + 1);
  if (rel.endsWith(".ts") || rel.endsWith(".tsx")) return rel;
  if (rel.endsWith("/index")) return `${rel}.ts`;
  return `${rel}.ts`;
}

/** True when every imported/exported name is type-only (`import type`, inline `type`). */
function isTypeOnly(node) {
  if (node.importKind === "type" || node.exportKind === "type") return true;
  const specs = node.specifiers || [];
  if (specs.length === 0) return false; // side-effect import/export: value
  return specs.every((s) => s.importKind === "type" || s.exportKind === "type");
}

const engineBoundary = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Outside electron/agent/, import the engine only via electron/agent/index; inside, reach app code only through ./host-store.",
    },
    messages: {
      outsideDeepEngine:
        "Outside electron/agent/, import the engine only via electron/agent/index (not '{{spec}}'). Type-only imports (import type) stay allowed.",
      insideAppCode:
        "Inside electron/agent/, reach app code through ./host-store (not '{{spec}}'). If this import is load-bearing, add an explicit per-module allowlist entry in eslint-rules/cairn.mjs with a reason instead of widening the rule.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getPhysicalFilename?.();
    if (typeof filename !== "string") return {};
    if (/\.test\.[cm]?[tj]s$/.test(filename)) return {}; // tests keep deep access
    const parts = electronParts(filename);
    if (!parts || parts[0] !== "electron") return {};
    const fileRel = parts.join("/");
    const insideEngine = parts[1] === "agent";
    if (insideEngine && fileRel === "electron/agent/host-store.ts") return {}; // the facade itself
    if (insideEngine && fileRel === ENGINE_INDEX) return {}; // the public surface re-exports by design

    function check(spec, node, typeOnly) {
      if (typeof spec !== "string" || !spec.startsWith(".")) return;
      if (typeOnly) return;
      const target = resolveRelative(filename, spec);
      if (!insideEngine) {
        if (target.startsWith(ENGINE_PREFIX) && target !== ENGINE_INDEX) {
          context.report({ node, messageId: "outsideDeepEngine", data: { spec } });
        }
        return;
      }
      if (!APP_PREFIXES.some((p) => target.startsWith(p))) return;
      if (PROC_ALLOW.has(target)) return;
      if (INSIDE_ALLOW.get(fileRel)?.has(target)) return;
      context.report({ node, messageId: "insideAppCode", data: { spec } });
    }

    return {
      ImportDeclaration(node) {
        if (node.source?.value) check(node.source.value, node.source, isTypeOnly(node));
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value) check(node.source.value, node.source, isTypeOnly(node));
      },
      ExportAllDeclaration(node) {
        if (node.source?.value) check(node.source.value, node.source, isTypeOnly(node));
      },
      ImportExpression(node) {
        const src = node.source;
        if (src && src.type === "Literal" && typeof src.value === "string") {
          check(src.value, src, false);
        } else if (src && src.type === "TemplateLiteral" && src.expressions.length === 0) {
          // Static backtick import: text lives in quasis, not value.
          const cooked = src.quasis[0]?.value?.cooked;
          if (typeof cooked === "string") check(cooked, src, false);
        }
      },
      CallExpression(node) {
        if (node.callee?.type === "Identifier" && node.callee.name === "require" && node.arguments?.length === 1) {
          const arg = node.arguments[0];
          if (arg.type === "Literal" && typeof arg.value === "string") check(arg.value, arg, false);
        }
      },
      // `import("../x")` used as a TYPE annotation: `mode?: import("../x").T`.
      // TS-only positions — erased at compile time, always allowed.
      TSImportType() {},
    };
  },
};

const cairn = { rules: { "icon-button-label": iconButtonLabel, "engine-boundary": engineBoundary } };

export default cairn;
