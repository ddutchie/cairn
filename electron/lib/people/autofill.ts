/**
 * Propose a person's profile fields from their persona note (People layer).
 * One model call over the note body, validated and source-quoted by
 * `shared/people/autofill`. Reads only; the user applies what they accept.
 * A person marked agent-private is never sent to a model.
 */
import type Database from "better-sqlite3";
import { getPerson } from "../../db/people-queries";
import { getNoteById } from "../../db/notes-queries";
import { runOneShot } from "../../agent/index";
import { getCachedConfig } from "../config-cache";
import { isLocalEndpoint, normaliseBaseUrl } from "../llm";
import { DEFAULT_LLM } from "../llm-config";
import { resolveLlmApiKey } from "../secure-store";
import { AUTOFILL_SYSTEM_PROMPT, buildAutofillPrompt, parseAutofill, type AutofillProposal } from "../../../shared/people/autofill";

export type AutofillResult =
  | { proposals: AutofillProposal[] }
  | { skipped: "off" | "no-ai" | "private" | "no-persona" | "empty" | "failed" };

export async function proposeProfileFields(db: Database.Database, personId: string): Promise<AutofillResult> {
  const person = getPerson(db, personId);
  if (!person) return { skipped: "failed" };
  if (person.agentPrivate) return { skipped: "private" };
  const note = person.personaNoteId ? getNoteById(db, person.personaNoteId) : null;
  if (!note) return { skipped: "no-persona" };
  const body = String(note.content ?? "").trim();
  if (!body) return { skipped: "empty" };

  const cached = getCachedConfig().aiConfig;
  const baseUrl = normaliseBaseUrl(cached?.baseUrl || DEFAULT_LLM.baseUrl);
  const model = cached?.model || DEFAULT_LLM.model;
  const keyRef = cached?.apiKey || "";
  if (!keyRef && !isLocalEndpoint(baseUrl)) return { skipped: "no-ai" };
  const apiMode = cached?.savedProviders?.find((p) => p.id === cached?.activeProviderId)?.apiMode as
    ("responses" | "completions" | "anthropic-messages" | undefined);

  try {
    const reply = await runOneShot({
      systemPrompt: AUTOFILL_SYSTEM_PROMPT,
      userPrompt: buildAutofillPrompt(person.name, body),
      config: { baseUrl, model, apiKey: resolveLlmApiKey(keyRef), apiMode },
      source: "people-autofill",
      workspaceId: person.workspaceId,
      maxTokens: 600,
      temperature: 0,
    });
    // Read the profile again: the user may have filled a field while the model ran.
    return { proposals: parseAutofill(reply, body, getPerson(db, personId) ?? person) };
  } catch {
    return { skipped: "failed" };
  }
}
