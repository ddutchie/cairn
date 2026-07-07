// Ambient module declarations for JS-only packages without bundled types.

declare module "markdown-it-mark" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}
