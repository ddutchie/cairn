/** Cordis plugins (developer preview) as the Plugins settings section sees them. */

export type PluginKind = "ui" | "backend" | "both";

/** An enabled UI plugin's id and raw module source (evaluated in the renderer). */
export interface UiPluginSource {
  id: string;
  source: string;
}

/** One row of plugins.yml. */
export interface PluginEntry {
  id: string;
  kind: PluginKind;
  /** Backend entry (relative to the plugins root), or null. */
  name: string | null;
  /** UI entry (relative to the plugins root), or null. */
  ui: string | null;
  /** Install spec (`github:owner/repo` or a local path), when recorded. */
  source: string | null;
  disabled: boolean;
}

export interface PluginList {
  /** Install/enable controls only work with CAIRN_PLUGINS_DEV=1. */
  devEnabled: boolean;
  root: string | null;
  plugins: PluginEntry[];
}

/** Result of installing or updating a plugin. */
export interface InstalledPlugin {
  id: string;
  /** Backend entry (relative to the plugins root), or null. */
  name: string | null;
  /** UI entry (relative to the plugins root), or null. */
  ui: string | null;
  kind: PluginKind;
}
