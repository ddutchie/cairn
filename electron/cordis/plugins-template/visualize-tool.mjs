/**
 * Spike (backend half): a Cairn port of `visualize` from the community plugin
 * github:Nagi-ovo/dsh-visualize.
 *
 *   # plugins.yml
 *   - id: visualize
 *     name: ./visualize-tool.mjs      # this file (agent tool)
 *     ui: ./visualize-view.plugin.js  # the toolview (renders the card)
 *
 * Registers a `visualize` agent tool that takes a self-contained HTML fragment
 * and returns it as the durable result. The paired toolview (visualize-view)
 * renders that HTML as a sandboxed interactive card in the transcript.
 *
 * Gap vs real dsh-visualize: dsh persists the fragment to a file via ctx.fs + a
 * bundled skill and enforces a CSP/byte cap; here the tool returns HTML inline
 * (Cairn's plugin API exposes ctx.cairn.defineTool but not ctx.fs yet — a
 * tracked ctx.cairn capability gap for full parity).
 */
export const name = "cairn-visualize";
export const inject = ["tools"];

export async function apply(ctx) {
  const { defineTool } = ctx.cairn;
  const tool = defineTool({
    name: "visualize",
    description:
      "Render an interactive HTML fragment as a sandboxed card in the conversation. " +
      "Pass a self-contained HTML body (inline <style>/<script> ok; no external network). " +
      "Use for simulators, charts, comparisons, or UI mockups.",
    parameters: {
      html: { type: "string", required: true, description: "a self-contained HTML fragment (body content)" },
      title: { type: "string", description: "optional card title" },
    },
    output: {
      schema: { type: "json" },
      // Returned as durable text → the toolview reads + renders it (dsh's
      // "model-visible ⟺ logged" invariant: the card replays from this slice).
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    async execute(args) {
      const html = String(args?.html ?? "");
      return html || "(no html provided)";
    },
  });
  ctx.tools.register(tool);
}
