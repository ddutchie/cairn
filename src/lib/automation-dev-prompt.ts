import type { Automation } from "@/store/slices/automations";

/**
 * Build the initial prompt for the automation "Develop" session — a pi-agent
 * session scoped to the automation's folder (<project>/.automations/<id>/)
 * that authors the automation's scripts AND its final recipe.
 *
 * The agent is the automation builder: it writes `scripts/` for the custom
 * logic, and edits `manifest.json` to set the final `instructions` (the recipe
 * that orchestrates connectors + run_script + note writing) and the env schema.
 * Connectors are tools the automation's own agent calls at run time — the dev
 * agent must never replicate them in scripts.
 */
export function buildAutomationDevPrompt(automation: Automation): string {
  const envNames = (automation.env ?? []).map((e) => e.name);
  const requires = (automation.requires ?? []).map((r) => `${r.kind}:${r.name}`);
  const recipe = automation.instructions.trim();

  return [
    `You are building the Cairn automation "${automation.name}" — its scripts AND its recipe.`,
    ``,
    `## The automation`,
    `It currently runs this recipe on schedule:`,
    ``,
    recipe,
    ``,
    `## Your workspace`,
    `Your working directory IS the automation folder. Layout:`,
    `- \`scripts/\` — where you create the scripts (e.g. \`scripts/generate_images.js\`).`,
    `- \`manifest.json\` — the automation's spec. READ it, and EDIT it: it is where you write the final recipe.`,
    `- \`.env\` — plain (non-secret) env values, already materialized.`,
    ``,
    `## Connectors — do NOT replicate them`,
    requires.length > 0
      ? `This automation uses: ${requires.join(", ")}. At run time the automation's agent calls these MCP/service tools DIRECTLY as part of the recipe. You must NOT write scripts that wrap, call, or re-implement them — the script would just duplicate what the automation already does.`
      : `This automation has no connectors.`,
    ``,
    `## The division of labour`,
    `- The RECIPE (manifest.json \`instructions\`) orchestrates: call connectors, then \`run_script\` for custom logic, then write the result as a note.`,
    `- SCRIPTS do what the tools cannot: image generation, file processing, running CLIs, computing values. A script takes arguments, reads env, writes deliverables to \`CAIRN_OUT_DIR\` (or stdout), and exits 0 on success.`,
    ``,
    `## The recipe you must produce`,
    `Edit \`manifest.json\` and set its \`instructions\` field to the FULL, final recipe — the automation must actually call your script. For example:`,
    ``,
    "```json",
    `"instructions": "Check the latest architectural news with the Tavily connector, then run generate_images with the argument '-prompt <news summary>', then present the findings in a new note."`,
    "```",
    ``,
    `The recipe is what the automation agent follows every run: it should name the connectors, name the \`run_script\` calls, and say how to deliver results.`,
    ``,
    `## Env vars`,
    `${envNames.length > 0
      ? `The automation already exposes: ${envNames.join(", ")}. `
      : `The automation has no env vars yet. `
    }If your scripts need configuration (e.g. an API key), add it to \`manifest.json\` under \`env\` as { name, secret } — do NOT invent secrets in scripts. The user fills in values in the Environment editor. Plain values go in \`.env\`; secret values are injected from the OS keychain at run time and are never written to files.`,
    ``,
    `## run_script contract (how scripts are called at run time)`,
    `Scripts are resolved by NAME from \`scripts/\` (name, .js/.ts/.sh/.py, and .bat/.cmd/.ps1 on Windows). The working directory at run time is a per-run scratch folder, NOT this folder. Env always includes CAIRN_OUT_DIR (a durable out/ folder) — copy anything worth keeping there. Keep scripts deterministic, bounded, and non-interactive: no prompts, no long sleeps, exit 0 on success with useful output. You have NO shell here — you cannot execute the scripts; reason about them statically (paths, env names, exit codes) and tell the user to verify with "Run now".`,
    ``,
    `## Handing data to scripts`,
    `The automation's agent can fetch results (connectors) but CANNOT write files itself. To feed a script fetched data, the recipe uses \`write_run_file\` to save it into the run folder (e.g. \`write_run_file path="tavily_results.json" content=<json>\`), then calls \`run_script\` with \`-input <file>\` — the script reads it from its cwd. A good recipe chains: fetch → \`write_run_file\` → \`run_script\` → use the printed JSON for the note.`,
    ``,
    `## Delivering images so notes can show them`,
    `Scripts write generated files into \`CAIRN_OUT_DIR\` — that folder is HIDDEN, so a note cannot reference those paths directly. To embed an image in the delivered note: (1) the script writes it to \`CAIRN_OUT_DIR\` only (do NOT also mirror into the run cwd — that folder is scratch and gets pruned); (2) the recipe calls \`deliver_file path="<file-in-CAIRN_OUT_DIR>"\` for each image, which copies it into the workspace \`attachments/\` folder and returns an \`assetUrl\`; (3) the note embeds it with \`![alt](<assetUrl>)\`. A good delivery step is: generate → \`deliver_file\` each image → write the note referencing the returned assetUrls.`,
    ``,
    `## Finish`,
    `When the scripts work and manifest.json's \`instructions\` is the full recipe, tell the user to: open the Automations view → this automation's details → "Sync from manifest" (writes your recipe into the automation) → "Run now" (tests the real end-to-end path with your scripts and real secrets).`,
  ].join("\n");
}
