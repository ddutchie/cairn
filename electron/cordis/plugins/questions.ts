import type { Context } from "@deepseek-ai/cordis";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import "../ctx-augment";
import { newId } from "../host-store";
import { APPROVAL_TIMEOUT_MS } from "./approval";

// ── cairn-questions ───────────────────────────────────────────────────────────
export interface CairnQuestionsConfig {
  /**
   * The dsh session id this mount serves. The waterfall dispatches every
   * agent's requests to every root listener, so the answerer only answers
   * requests whose asking agent belongs to this session and passes the rest
   * down the chain — otherwise concurrent turns (chat + coding) would answer
   * each other's questions.
   */
  sessionId: string;
  /** Emit a Cairn IPC event to the renderer (threadId tagged by the caller). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /**
   * Register a resolver for one pending question request; returns a disposer.
   * The IPC handler calls the stored resolver when the renderer answers.
   */
  registerPending: (requestId: string, resolve: (answersText: string) => void) => () => void;
  /**
   * How to surface the question form to the renderer. All surfaces use the
   * shared `session:ask-questions` channel.
   * Receives the requestId (echoed back on answer) + the questions.
   */
  emitQuestions?: (requestId: string, questions: CairnQuestionItem[]) => void;
  signal?: AbortSignal;
  /** Fail-closed idle timeout for the form. Defaults to APPROVAL_TIMEOUT_MS. */
  questionsTimeoutMs?: number;
}

/** The question shape that flows through ask() — Cairn's ask_questions schema
 *  ({id,label,prompt}), which is already the renderer's PendingQuestion shape.
 *  dsh's user-questions service forwards the questions array opaquely. */
/**
 * A pending question forwarded to the renderer. Two shapes are accepted so
 * both Cairn's own `ask_questions` tool (which emits `{id, label, prompt}`)
 * AND any dsh-native provider (dsh-plan-mode's `exit_plan_mode` uses
 * `AskUserQuestionItem = {id, question, header?, detail?, options?, intent?}`,
 * where `detail` carries the FULL markdown plan for plan-review) render as
 * a filled-in form. Previously we only forwarded Cairn's shape and dsh's
 * plan-review card came through empty and unapprovable.
 */
interface CairnQuestionItem {
  id: string;
  /** Cairn shape */
  label?: string;
  prompt?: string;
  /** dsh AskUserQuestionItem shape — see dsh-user-questions/lib/types/types.d.ts. */
  question?: string;
  header?: string;
  detail?: string;
  options?: ReadonlyArray<string | { label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: { kind?: string; approve?: string; [k: string]: unknown };
}

/** dsh AskUserQuestionAnswer shape returned by the answerer. */
interface DshAnswer { answers: Array<{ id: string; selected: string[]; custom?: string }> }
/** The waterfall request dsh-user-questions dispatches to answerers. */
interface UserQuestionsRequest {
  questions: CairnQuestionItem[];
  agent?: unknown;
  signal?: AbortSignal;
}

/**
 * Bridge the dsh user-questions seam (ctx.userQuestions) to Cairn's renderer
 * question form. Answers the `user-questions/request` waterfall: maps dsh
 * questions to the `ask_questions` IPC shape the renderer already renders,
 * sends it, blocks until the renderer answers (via registerPending), then maps
 * the answer text back to dsh's structured AskUserQuestionAnswer. This gives
 * the coding agent and chat a blocking, same-turn question flow without the
 * unpublished dsh-tool-ask-user package.
 *
 * dsh 0.1.2-alpha.4 removed registerProvider (and its DUPLICATE_PROVIDER
 * failure mode) — answerers are plain waterfall listeners now, scoped to the
 * asking agent when one is supplied. Unsubscribing at turn end is enough;
 * no cross-turn holder needed.
 */
export function cairnQuestionsPlugin(ctx: Context, config: CairnQuestionsConfig): (() => void) | void {
  const { sessionId, registerPending, emitQuestions, signal, questionsTimeoutMs } = config;
  // ctx.userQuestions is provided by dsh-user-questions (see ctx-augment).
  // Presence-gate only — answering happens through the waterfall event below.
  if (!ctx.userQuestions) return;

  const unsub = (ctx.on as unknown as (ev: string, fn: (...args: unknown[]) => unknown) => () => void)(
    "user-questions/request",
    (...args: unknown[]) => {
      const request = args[0] as UserQuestionsRequest;
      const next = args[1] as (() => unknown) | undefined;
      // Session scoping: the waterfall reaches every root listener, so only
      // answer when the asking agent belongs to this mount's session.
      // Anything else passes down the chain (another turn's answerer, or
      // dsh's NO_PROVIDER rejection when nobody matches). Without this,
      // concurrent chat + coding turns would answer each other's questions.
      const asker = request.agent as { id?: unknown; session?: { id?: unknown } } | undefined;
      const askerSessionId = asker ? String(asker.session?.id ?? asker.id ?? "") : "";
      if (askerSessionId && askerSessionId !== sessionId) {
        return typeof next === "function" ? next() : Promise.reject(new Error("no matching questions answerer"));
      }
      return (async (): Promise<DshAnswer> => {
        const requestId = `q-${newId()}`;
        // Forward the raw question objects to the renderer unchanged. The
        // renderer's QuestionForm now understands BOTH the Cairn shape
        // ({id, label, prompt}) and dsh's AskUserQuestionItem shape
        // ({id, question, header?, options?, intent?}), so a payload from
        // Cairn's own ask_questions tool AND one from a dsh-native provider
        // (e.g. dsh-plan-mode's exit_plan_mode) both render as filled-in
        // forms. This closes the review's plan-mode-blank-form bug.
        const questions = request.questions;
         if (emitQuestions) emitQuestions(requestId, questions);

        const answersText = await new Promise<string>((resolve) => {
          const onAborts: Array<() => void> = [];
          let settled = false;
          // Hoist the timer binding so settle() can clearTimeout(timer) even
          // when called from the synchronous-replay path below — a const
          // declaration at the tail would be in TDZ during a sync replay.
          // eslint-disable-next-line prefer-const -- reassigned at end of block; declaration must precede settle() to avoid TDZ during sync replay.
          let timer: ReturnType<typeof setTimeout> | undefined;
          // Synchronous-resolve safety — see the identical pattern in the
          // approval answerer below for the full rationale. Buffer the
          // outcome + replay after registerPending returns so dispose runs.
          const disposeRef: { current: (() => void) | null } = { current: null };
          let syncOutcome: string | null = null;
          const settle = (text: string) => {
            if (settled) return;
            if (disposeRef.current === null && syncOutcome === null) {
              syncOutcome = text;
              return;
            }
            settled = true;
            clearTimeout(timer);
            disposeRef.current?.();
            for (const off of onAborts) off();
            resolve(text);
          };
          disposeRef.current = registerPending(requestId, (text) => settle(text));
          if (syncOutcome !== null && !settled) {
            const captured = syncOutcome;
            syncOutcome = null;
            settle(captured);
          }
          const onAbort = () => settle('{"cancelled":true,"answers":[]}');
          if (request.signal?.aborted || signal?.aborted) onAbort();
          for (const sig of [request?.signal, signal]) {
            if (!sig) continue;
            sig.addEventListener?.("abort", onAbort, { once: true });
            onAborts.push(() => sig.removeEventListener?.("abort", onAbort));
          }
          // Same fail-closed budget as approvals: an unanswered form must not
          // block the loop forever. No expiry IPC needed — the loop settles
          // with the cancelled answers and the pane clears its state on done.
          timer = setTimeout(() => settle('{"cancelled":true,"answers":[]}'), questionsTimeoutMs ?? APPROVAL_TIMEOUT_MS);
        });

        // The renderer answers with a JSON blob {answers:[{id,selected[],custom?}]}
        // (structured) or plain text. Map both back to dsh's answer structure.
        //
        // Two special sentinels the renderer can send:
        //   { __dismissed__: true } — the user closed the question without
        //     answering (Discuss button on plan-review, or aborted the pane).
        //     Throw UserQuestionError with code 'ASK_CANCELLED' so
        //     dsh-plan-mode's `exit_plan_mode` reports "user dismissed to
        //     speak instead" instead of "user chose to keep planning".
        //   { cancelled: true, answers: [] } — legacy shape emitted on the
        //     turn-abort / timeout paths; treated as an empty answer batch
        //     (dsh maps that to a generic decline / keep-planning).
        try {
          const parsed = JSON.parse(answersText) as { answers?: Array<{ id?: string; selected?: string[]; custom?: string }>; __dismissed__?: boolean; cancelled?: boolean };
          if (parsed?.__dismissed__ === true) {
            throw new UserQuestionError(
              "ask_user_question was dismissed by the user",
              "ASK_CANCELLED",
            );
          }
          if (Array.isArray(parsed.answers)) {
            return { answers: parsed.answers.map((a, i) => ({ id: a.id ?? request.questions[i]?.id ?? String(i), selected: a.selected ?? [], custom: a.custom })) };
          }
        } catch (err) {
          // Re-throw UserQuestionError so plan-mode's dismiss handling fires.
          // Any other parse error falls through to plain-text treatment below.
          if (err instanceof UserQuestionError) throw err;
        }
        return { answers: request.questions.map((q, i) => ({ id: q.id, selected: [], custom: i === 0 ? answersText : undefined })) };
      })();
    },
  );
  return unsub;
}
// Cordis gates ctx.userQuestions behind an explicit injection declaration.
cairnQuestionsPlugin.inject = ["userQuestions"];
