/**
 * Example runtime plugin: registers an agent-visible `hello` tool on Cairn's
 * shared Cordis context. Copy this file + a matching plugins.yml entry into your
 * <userData>/plugins/ dir (with CAIRN_PLUGINS_DEV=1) and it loads live.
 *
 *   # plugins.yml
 *   - id: hello-tool
 *     name: ./hello-tool.mjs
 *     config: { excitement: 3 }
 *
 * A plugin is just a Cordis plugin — `apply(ctx, config)` (+ optional name/inject).
 * `inject: ['tools']` makes this fiber wait until ctx.tools is provided, so the
 * registration below always has a live tool registry.
 */

export const name = "cairn-example-hello";
export const inject = ["tools"];

export async function apply(ctx, config) {
  const excitement = Number(config?.excitement ?? 1);
  const bang = "!".repeat(Math.max(1, Math.min(10, excitement)));

  // Cairn exposes its tool factory on ctx.cairn so plugins never import app
  // internals (a plugin lives outside the app's node_modules — a bare
  // `import("@deepseek-ai/dsh-tools")` would not resolve from here).
  const { defineTool } = ctx.cairn;

  const tool = defineTool({
    name: "hello",
    description: "Say hello to someone. A runtime-loaded example plugin tool.",
    // dsh parameters = a flat map of param -> ValueSchemaSpec (NOT JSON-Schema).
    // Optional params: OMIT `required` entirely (never set required: false).
    parameters: {
      who: { type: "string", required: true, description: "who to greet" },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    async execute(args) {
      const who = String(args?.who ?? "world");
      return `Hello, ${who}${bang} — from a live-loaded Cairn plugin.`;
    },
  });

  // ctx.tools.register returns a disposer; when this entry is removed from the
  // manifest, the fiber tears down and the tool is unregistered automatically.
  ctx.tools.register(tool);
}
