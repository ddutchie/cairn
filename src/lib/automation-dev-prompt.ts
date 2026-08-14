import type { Automation } from "@/store/slices/automations";

/**
 * Build the initial prompt for the automation "Develop" session — a pi-agent
 * session scoped to the automation's folder (<project>/.automations/<id>/)
 * that authors and tests the automation's scripts.
 *
 * The prompt hands the agent everything it needs: the recipe, the layout
 * (scripts/ + .env + manifest.json), the env contract (non-secret values are
 * in .env; secret values are injected only at run time and never written to
 * files), and the run_script contract it must build against.
 */
export function buildAutomationDevPrompt(automation: Automation): string {
  const envNames = (automation.env ?? []).map((e) => e.name);
  const requires = (automation.requires ?? []).map((r) => `${r.kind}:${r.name}`);

  return [
    `You are building the scripts for the Cairn automation "${automation.name}".`,
    ``,
    `The automation runs this recipe on schedule:`,
    ``,
    automation.instructions.trim(),
    ``,
    `## Your workspace`,
    `Your working directory IS the automation folder. Layout:`,
    `- \`scripts/\` — where you create the scripts (e.g. \`scripts/generate_images.js\`).`,
    `- \`manifest.json\` — the automation's spec (name, env schema, connectors). Read it.`,
    `- \`.env\` — plain (non-secret) env values, already materialized for you.`,
    ``,
    `## Env vars`,
    `${envNames.length > 0
      ? `The automation exposes these env vars to scripts: ${envNames.join(", ")}.\nPlain values are in \`.env\` (source it or read process.env). Secret values are stored in the OS keychain and injected directly into the script's process.env at RUN time — they are never written to files, so during development they are absent. Write scripts that read them from process.env and degrade gracefully (or log a clear message) when a secret is missing.`
      : `The automation has no env vars configured.`}`,
    ``,
    `## The run_script contract`,
    `At run time the automation calls scripts by NAME from \`scripts/\` (resolved as name, .js/.ts/.sh/.py, and .bat/.cmd/.ps1 on Windows). The working directory at run time is a per-run scratch folder, not this folder. Env always includes CAIRN_OUT_DIR (a durable out/ folder) — copy anything worth keeping there. Keep scripts deterministic, bounded, and non-interactive: no prompts, no long sleeps, exit 0 on success with useful output.`,
    ``,
    `## Your task`,
    `Create and iterate on the script(s) the recipe needs. Test them here with \`node\` / \`bash\` against \`.env\` until they work. Prefer a single well-named script that does one thing and prints structured output.`,
    `${requires.length > 0 ? `\nThe automation also uses these connectors: ${requires.join(", ")}. The recipe may expect you to fetch input through them at run time.\n` : ""}`,
    ``,
    `When you are confident the scripts work, tell the user to open the Automations view and press "Run now" to test the real end-to-end path (that run injects the real secret env vars and uses your scripts as-is).`,
  ].join("\n");
}
