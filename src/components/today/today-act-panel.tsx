"use client";

/**
 * The Today act panel: a sheet over Today for acting on one item, instead of
 * handing it to whatever chat is open.
 *
 * It runs one short-lived chat (thread id `today-…`, not in the chat list
 * unless the user keeps it) scoped to the item:
 *   - "Goes to" is worked out first (`today:route`): the item's channel and
 *     the in-scope connector tools that could send there. With none, the main
 *     action is Copy and open.
 *   - The draft is edited in place, and Ask Cairn rewrites it in place.
 *   - Send asks the model to make one send call. The chat runs with the
 *     "safe" approval policy, so every connector call shows an approval card
 *     with its arguments here before it runs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { revealCard } from "@/lib/events";
import { ArrowUp, Check, Copy, ExternalLink, Kanban, MessageSquare, Send } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import { useChatStream } from "@/hooks/useChatStream";
import { useSessionOnScreen } from "@/hooks/useSessionOnScreen";
import { useLiveStream } from "@/lib/conversation/live-stream-store";
import { createSessionEventFold } from "../../../shared/agent/session-event-fold";
import { sessionClient } from "@/lib/ipc/session";
import { unwrapSessionPayload } from "@/lib/conversation/session";
import { hasElectron } from "@/lib/ipc/client";
import { todayClient } from "@/lib/ipc/automations";
import { appClient } from "@/lib/ipc/app";
import { effectiveTemperatureForModel } from "@/lib/models-dev";
import { toConversationToolCall } from "@/lib/conversation/message";
import { ConversationToolCall } from "@/components/conversation/ConversationToolCall";
import { MarkdownContent } from "@/components/conversation/MarkdownContent";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { WRITE_VERB, operationWords, toolServer, type TodayRoute } from "../../../shared/today/route";
import type { TodayPrepared } from "../../../shared/today/brief";

/** What the panel acts on: a decision's answer, a to-do, or a prepared draft. */
export interface TodayActTarget {
  /** Stable per item: the need or draft id. */
  key: string;
  /** "Need you · Decision", "Prepared for you · Reply draft"… */
  crumb: string;
  title: string;
  /** The answer picked, for a decision. */
  answer?: string;
  /** The draft that carries it out, as the user last left it. */
  draft?: TodayPrepared;
  source: string;
  url?: string;
  /** Context shown under "About this" and given to the model. */
  context?: string;
  /** Sent once when the panel opens (Plan in slot). */
  initialPrompt?: string;
  /** The Cairn project the item belongs to; its connectors are the ones the panel's chat can use. */
  projectId?: string;
}

interface Turn { role: "user" | "assistant"; text: string }

const DRAFT_RE = /<draft>\s*([\s\S]*?)\s*<\/draft>/i;
const QUICK = ["Shorter", "Warmer", "More direct", "Fix the tone"];
/** For an item with nothing to send yet (a to-do from the board): questions about it. */
const ASK_QUICK = ["What's the next step?", "Break it into steps", "What's blocking it?"];

const SEND_LINES: Record<string, string> = {
  "Add this to the project's board now.": "Add it to the board",
  "Send this reply now.": "Send it",
};

/** What a stored prompt showed in the thread: the message I typed, not the instructions around it. */
function shownText(prompt: string): string {
  const mine = prompt.match(/\n\nMy message: ([\s\S]*?)(?:\n\n|$)/);
  if (mine) return mine[1].trim();
  const first = prompt.split("\n", 1)[0];
  return SEND_LINES[first] ?? first;
}

/** A reply as the thread shows it: the <draft> block is lifted into the draft box. */
function replyTurn(reply: string): { text: string; draft: string | null } {
  const m = reply.match(DRAFT_RE);
  const rest = reply.replace(DRAFT_RE, "").trim();
  return { text: rest || (m ? "Updated the draft above." : reply), draft: m ? m[1] : null };
}

function openUrl(url?: string) {
  if (url && /^https?:\/\//i.test(url)) void appClient.openExternal(url);
}

function itemBrief(t: TodayActTarget): string {
  return [
    `Item: ${t.title}`,
    t.answer ? `My answer: ${t.answer}` : null,
    `Source: ${t.source}`,
    t.draft?.target ? `Goes to: ${t.draft.target}` : null,
    t.url ? `Link: ${t.url}` : null,
    t.context ? `Context: ${t.context}` : null,
  ].filter(Boolean).join("\n");
}

export function TodayActPanel({ workspaceId, projectId, date, target, onSaveDraft, onDone, onUndoDone, onClose }: {
  workspaceId: string;
  /** Scopes the panel's chat (its connectors and board): the item's project, else the open one. */
  projectId?: string;
  date: string;
  target: TodayActTarget;
  /** Save an edited draft (null puts Cairn's back). Only called for items with a draft. */
  onSaveDraft: (draftId: string, text: string | null) => void;
  onDone: () => void;
  onUndoDone: () => void;
  onClose: () => void;
}) {
  const aiConfig = useCairnStore((s) => s.aiConfig);
  const threadId = `today-${workspaceId}-${date}-${target.key}`;
  const sessionId = `chat-${threadId}`;
  const { isLoading, toolCalls, streamStore, sendStream, syncRunning } = useChatStream(threadId);
  const { content: streaming } = useLiveStream(streamStore);

  const [route, setRoute] = useState<TodayRoute | null>(null);
  const [text, setText] = useState(target.draft?.draft ?? "");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [ask, setAsk] = useState("");
  // Done by hand (Mark done), or by a send call that finished; "Not done after all" undoes either.
  const [manualDone, setManualDone] = useState(false);
  const [undoneCall, setUndoneCall] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [kept, setKept] = useState(false);
  // Send (or Add to the board) was asked for: from then on a Cairn write counts as the send too.
  const [sendAsked, setSendAsked] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The open dialog shows this item's chat: its approvals appear here, not in the bell.
  useSessionOnScreen(sessionId, scrollRef);
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);

  useEffect(() => {
    let live = true;
    todayClient.route({ workspaceId, projectId, source: target.source, target: target.draft?.target, kind: target.draft?.kind })
      .then((r) => { if (live) setRoute(r); })
      .catch((e: unknown) => { if (live) setRoute({ channel: "other", label: "its source", tools: [], error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [workspaceId, projectId, target.source, target.draft?.target, target.draft?.kind]);

  // Assistant replies: a <draft> block replaces the draft; the rest shows in the thread.
  const saveDraftRef = useRef(onSaveDraft);
  useEffect(() => { saveDraftRef.current = onSaveDraft; });
  useEffect(() => {
    if (!hasElectron()) return;
    let content = "";
    const fold = createSessionEventFold({
      onTurnStart: () => { content = ""; },
      onAssistantMessage: (m) => { content = m.text; },
      onTurnEnd: () => {
        const reply = content;
        content = "";
        if (!reply) return;
        const turn = replyTurn(reply);
        if (turn.draft !== null) {
          setText(turn.draft);
          if (target.draft) saveDraftRef.current(target.draft.id, turn.draft);
        }
        setTurns((t) => [...t, { role: "assistant", text: turn.text }]);
      },
    });
    return sessionClient.onEvent((e) => { if (e.sessionId === sessionId) fold(e.event); });
  }, [sessionId, target.draft]);

  // A connector call that writes and finished cleanly is the send. A Cairn write (editing or moving
  // a card, writing a note) only counts once Send was asked for: otherwise it's just a change.
  const sendCall = toolCalls.find((tc) => tc.status === "done" && tc.ok !== false && !tc.error
    && WRITE_VERB.test(operationWords(tc.tool)) && (sendAsked || toolServer(tc.tool) !== ""));
  const sendKey = sendCall ? sendCall.callId ?? sendCall.tool : null;
  const sent = manualDone || (!!sendKey && sendKey !== undoneCall);
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; });
  useEffect(() => { if (sendKey) onDoneRef.current(); }, [sendKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, streaming, toolCalls.length, sent]);

  const prompt = useCallback((shown: string, message: string) => {
    if (isLoading) return;
    setTurns((t) => [...t, { role: "user", text: shown }]);
    sendStream({
      message,
      threadId,
      projectId,
      workspaceId,
      history: [],
      config: {
        provider: aiConfig.provider || "openai",
        baseUrl: aiConfig.baseUrl || undefined,
        model: aiConfig.model || undefined,
        apiKey: aiConfig.apiKey || undefined,
        maxSteps: aiConfig.maxSteps ?? 30,
        temperature: effectiveTemperatureForModel(aiConfig.model, aiConfig.temperature),
        apiMode: aiConfig.savedProviders?.find((p) => p.id === aiConfig.activeProviderId)?.apiMode ?? "completions",
        contextLimit: aiConfig.contextLimit,
        contextWindow: aiConfig.contextLimit,
      },
      // Every connector call asks here, whatever the chat's own policy is.
      approvalPolicy: "safe",
    });
  }, [isLoading, sendStream, threadId, projectId, workspaceId, aiConfig]);

  const revise = (instruction: string) => {
    const current = textRef.current.trim();
    prompt(instruction, [
      "You're helping me act on one item from my Today brief. You can look things up, and when I ask, change things in Cairn (edit, move or add cards, write notes). Don't send or post anything outside Cairn: I do that with the Send button.",
      itemBrief(target),
      current ? `Current draft:\n<draft>\n${current}\n</draft>` : "There's no draft yet.",
      `My message: ${instruction}`,
      "If my message asks for a change (or there's no draft yet and I want one), reply with the full new draft inside <draft></draft>, then at most one short sentence on what you changed. If it's a question, answer it briefly and leave out the draft block.",
    ].join("\n\n"));
  };

  const send = () => {
    if (!route) return;
    const tool = route.tools[0];
    const body = textRef.current.trim();
    const board = route.channel === "board";
    setSendAsked(true);
    prompt(board ? "Add it to the board" : `Send it${tool ? ` with ${tool.op}` : ""}`, [
      board ? "Add this to the project's board now." : "Send this reply now.",
      itemBrief(target),
      board
        ? "Create the cards (or note) described below in this project. Use exactly what's written, one card per line item."
        : `Use ${tool ? `the \`${tool.name}\` tool` : `a tool that sends on ${route.label}`}${route.tools.length > 1 ? ` (or ${route.tools.slice(1, 3).map((t) => `\`${t.name}\``).join(" / ")} if it fits better)` : ""}. Look up any ids you need (channel, thread, message, recipients) with read tools first. Send the text inside <draft> exactly as written, once, as a reply in the same thread when there is one.`,
      `<draft>\n${body}\n</draft>`,
      "Then say in one short sentence what you did and where.",
    ].join("\n\n"));
  };

  const copyAndOpen = async () => {
    await navigator.clipboard.writeText(textRef.current);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
    openUrl(target.url);
  };

  const keepInChat = () => {
    const st = useCairnStore.getState();
    st.keepThread(threadId, workspaceId, projectId, target.title);
    // The ref first: closing unmounts the panel before the effect that copies `kept` could run.
    keptRef.current = true;
    setKept(true);
    st.setActiveChatThreadId(threadId);
    if (!st.chatOpen) st.toggleChat();
    onClose();
  };

  // Off the list unless kept: drop the panel's unread mark and in-memory messages on close. A reply
  // that's still running is kept instead, so it finishes in the chat list. The session itself stays
  // on disk either way, which is how reopening the item shows the chat again.
  const keptRef = useRef(kept);
  useEffect(() => { keptRef.current = kept; }, [kept]);
  const loadingRef = useRef(isLoading);
  useEffect(() => { loadingRef.current = isLoading; }, [isLoading]);
  const keepRef = useRef(() => {});
  useEffect(() => { keepRef.current = () => { useCairnStore.getState().keepThread(threadId, workspaceId, projectId, target.title); }; });
  useEffect(() => () => {
    if (keptRef.current) return;
    if (loadingRef.current) { keepRef.current(); return; }
    useCairnStore.setState((s) => ({
      unreadThreadIds: s.unreadThreadIds.filter((id) => id !== threadId),
      chatMessages: s.chatMessages.filter((m) => m.threadId !== threadId),
    }));
  }, [threadId]);

  // On open: bring back this item's earlier chat, pick up a reply that's still running, then send the
  // prompt that Plan in slot and similar open with (only when there's no earlier chat).
  const opened = useRef(false);
  const syncRunningRef = useRef(syncRunning);
  useEffect(() => { syncRunningRef.current = syncRunning; });
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    // No cancel flag: the guard above makes this run once, and React StrictMode's replay would cancel it.
    void (async () => {
      let earlier: Turn[] = [];
      let lastDraft: string | null = null;
      if (hasElectron()) {
        try {
          const [rows, state] = await Promise.all([
            sessionClient.getSessionMessages(sessionId).then((r) => unwrapSessionPayload(r).messages as Array<{ role: string; content: string }>),
            sessionClient.isRunning(sessionId),
          ]);
          for (const r of rows) {
            if (!r.content?.trim()) continue;
            if (r.role === "user") earlier.push({ role: "user", text: shownText(r.content) });
            else if (r.role === "assistant") {
              const turn = replyTurn(r.content);
              if (turn.draft !== null) lastDraft = turn.draft;
              earlier.push({ role: "assistant", text: turn.text });
            }
          }
          if (state?.running) syncRunningRef.current(true);
        } catch { earlier = []; /* a new item has no session yet */ }
      }
      if (earlier.length) {
        setTurns((t) => [...earlier, ...t]);
        // An item without a saved draft keeps the last one Cairn wrote here.
        if (lastDraft !== null && !target.draft && !textRef.current.trim()) setText(lastDraft);
      } else if (target.initialPrompt) revise(target.initialPrompt);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  const canSend = !!route && (route.channel === "board" || route.tools.length > 0);
  const liveCalls = useMemo(() => toolCalls.map((tc) => toConversationToolCall(tc as never)), [toolCalls]);
  const edited = !!target.draft && text !== target.draft.draft;
  // Something to send: a draft, a picked answer, or a draft Cairn wrote in this chat. Otherwise the
  // dialog is a plain question about the item, with no "Goes to" and no empty draft box.
  const sending = !!target.draft || !!target.answer || text.trim() !== "";
  const cardId = target.key.startsWith("card-") ? target.key.slice(5) : null;
  const setView = useCairnStore((s) => s.setView);
  const openCard = () => { if (cardId) { revealCard(setView, cardId); onClose(); } };

  return (
    // The same centred dialog as Project settings (ModalShell's pieces), with a scrolling body.
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent
          size="lg"
          aria-describedby={undefined}
          className="flex flex-col h-[min(760px,85vh)] p-0 gap-0 overflow-hidden"
        >
          {/* header (right padding leaves room for the dialog's close button) */}
          <div className="pl-5 pr-12 pt-4 pb-3 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-1.5">
              <span className="text-2xs text-[var(--text-tertiary)] truncate flex-1">{target.crumb} · {target.source}</span>
              {target.url && <IconButton label="Open the source" size="sm" onClick={() => openUrl(target.url)}><ExternalLink size={12} /></IconButton>}
            </div>
            <DialogTitle className="text-base font-semibold leading-snug mt-1">{target.title}</DialogTitle>
            {target.answer && (
              <span className="inline-flex items-center gap-1.5 mt-1.5 text-2xs text-[var(--text-secondary)] rounded-full px-2.5 py-0.5 border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface-2))]">
                Your answer: <b className="font-medium text-[var(--text-primary)]">{target.answer}</b>
              </span>
            )}
          </div>

          {/* body */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
            {sent && (
              <div className="rounded-lg border border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,var(--surface-2))] px-3 py-2.5 text-xs">
                <div className="flex items-center gap-1.5 font-semibold"><Check size={13} className="text-[var(--success)]" /> Done{sendCall ? ` · ${operationWords(sendCall.tool)}` : ""}</div>
                <p className="text-2xs text-[var(--text-secondary)] mt-1">Marked done in Today.</p>
                <div className="flex gap-3 mt-1.5">
                  {target.url && <button type="button" className="text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline" onClick={() => openUrl(target.url)}>Open the source</button>}
                  <button type="button" className="text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline" onClick={() => { setManualDone(false); setUndoneCall(sendKey); onUndoDone(); }}>Not done after all</button>
                </div>
              </div>
            )}

            {sending && (
            <section>
              <div className="text-2xs text-[var(--text-tertiary)] mb-1">Goes to</div>
              <RouteBox route={route} target={target} />
            </section>
            )}

            {sending && (
            <section>
              <div className="flex items-center gap-1.5 text-2xs text-[var(--text-tertiary)] mb-1">
                Draft
                {edited && <span className="rounded px-1.5 bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]">edited</span>}
                {edited && target.draft && (
                  <button
                    type="button"
                    className="ml-auto hover:text-[var(--text-primary)] hover:underline"
                    onClick={() => { setText(target.draft!.draft); onSaveDraft(target.draft!.id, null); }}
                  >
                    Use Cairn&apos;s draft
                  </button>
                )}
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => { if (target.draft) onSaveDraft(target.draft.id, text); }}
                placeholder="No draft yet. Ask Cairn to write one below, or type it here."
                aria-label="Draft"
                rows={Math.min(14, Math.max(6, text.split("\n").length + 1))}
                className={cn(
                  "w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 py-2 text-xs leading-relaxed text-[var(--text-primary)] resize-y",
                  FOCUS_RING,
                )}
              />
            </section>
            )}

            {target.context && (
              <section>
                <div className="text-2xs text-[var(--text-tertiary)] mb-1">About this</div>
                <p className="text-2xs text-[var(--text-secondary)] leading-relaxed border-l-2 border-[var(--border)] pl-2.5">{target.context}</p>
              </section>
            )}

            {(turns.length > 0 || isLoading) && (
              <section>
                <div className="flex items-center text-2xs text-[var(--text-tertiary)] mb-1.5">
                  This item&apos;s chat
                  {isLoading && !kept && <span className="ml-2">· Closing keeps it running in your chat list</span>}
                  <Tooltip content="Add this chat to your chat list and open it there">
                    <button type="button" className="ml-auto hover:text-[var(--text-primary)] hover:underline" onClick={keepInChat}>Keep in chat</button>
                  </Tooltip>
                </div>
                <div className="flex flex-col gap-2">
                  {turns.map((t, i) => (
                    <div
                      key={i}
                      className={cn(
                        "text-xs leading-relaxed rounded-lg px-2.5 py-1.5 max-w-[92%]",
                        t.role === "user" ? "self-end bg-[var(--surface-3)]" : "self-start bg-[var(--surface-2)] border border-[var(--border-subtle)] text-[var(--text-secondary)]",
                      )}
                    >
                      {t.role === "assistant" ? <MarkdownContent content={t.text} /> : t.text}
                    </div>
                  ))}
                  {liveCalls.map((tc, i) => (
                    <div key={tc.callId ?? `${tc.name}-${i}`} className="self-stretch">
                      <ConversationToolCall toolCall={tc} sessionId={sessionId} />
                    </div>
                  ))}
                  {isLoading && (
                    <div className="self-start text-xs text-[var(--text-secondary)] max-w-[92%]">
                      {streaming && !DRAFT_RE.test(streaming)
                        ? <MarkdownContent content={streaming.replace(/<draft>[\s\S]*$/i, "")} />
                        : <span className="inline-flex items-center gap-1.5 text-2xs text-[var(--text-tertiary)]"><Spinner size={10} /> Working</span>}
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>

          {/* footer */}
          <div className="border-t border-[var(--border-subtle)] px-5 pt-3 pb-4 flex flex-col gap-2">
            {!sent && (
              <>
                <div className="flex flex-wrap gap-1">
                  {(!sending ? ASK_QUICK : text.trim() ? QUICK : ["Write a reply for this"]).map((q) => (
                    <button
                      key={q}
                      type="button"
                      disabled={isLoading}
                      onClick={() => revise(q)}
                      className="text-2xs rounded-full border border-[var(--border)] px-2 py-px text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:opacity-45"
                    >
                      {q}
                    </button>
                  ))}
                </div>
                <form
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-2.5 pr-1 py-1"
                  onSubmit={(e) => { e.preventDefault(); const v = ask.trim(); if (v) { revise(v); setAsk(""); } }}
                >
                  <MessageSquare size={12} className="text-[var(--text-tertiary)] shrink-0" />
                  <input
                    value={ask}
                    onChange={(e) => setAsk(e.target.value)}
                    placeholder={sending ? "Ask Cairn to change the draft, or ask about this…" : "Ask Cairn about this…"}
                    aria-label="Ask Cairn"
                    className="flex-1 min-w-0 bg-transparent text-xs outline-none"
                  />
                  <IconButton label="Send to Cairn" size="sm" type="submit" disabled={isLoading || !ask.trim()}><ArrowUp size={12} /></IconButton>
                </form>
              </>
            )}
            <div className="flex items-center gap-1.5">
              {sent ? (
                <DialogClose asChild><Button size="sm" variant="accent">Back to Today</Button></DialogClose>
              ) : !sending ? (
                <>
                  <Button size="sm" variant="accent" onClick={() => { setManualDone(true); onDone(); }}><Check size={12} /> Mark done</Button>
                  {cardId && <Button size="sm" variant="outline" onClick={openCard}><Kanban size={12} /> Open the card</Button>}
                  {!cardId && target.url && <Button size="sm" variant="outline" onClick={() => openUrl(target.url)}><ExternalLink size={12} /> Open the source</Button>}
                </>
              ) : canSend ? (
                <>
                  <Button size="sm" variant="accent" disabled={isLoading || !text.trim()} onClick={send}>
                    <Send size={12} /> {route?.channel === "board" ? "Add to board…" : "Send…"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void copyAndOpen()}><Copy size={12} /> {copied ? "Copied" : "Copy"}</Button>
                  <span className="ml-auto text-2xs text-[var(--text-tertiary)] text-right leading-snug">
                    {route?.channel === "board" ? "Cairn adds what's written above" : <>You&apos;ll approve the exact call<br />before anything is sent</>}
                  </span>
                </>
              ) : (
                <>
                  <Button size="sm" variant="accent" disabled={!route || !text.trim()} onClick={() => void copyAndOpen()}>
                    <Copy size={12} /> {copied ? "Copied" : target.url ? "Copy and open" : "Copy"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setManualDone(true); onDone(); }}>Mark done</Button>
                  <span className="ml-auto text-2xs text-[var(--text-tertiary)] text-right leading-snug">
                    {route ? <>Nothing here can send this,<br />so you send it</> : "Checking your connectors…"}
                  </span>
                </>
              )}
            </div>
          </div>
        </DialogContent>
    </Dialog>
  );
}

function RouteBox({ route, target }: { route: TodayRoute | null; target: TodayActTarget }) {
  const box = "rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 py-2 grid grid-cols-[20px_1fr] gap-x-2.5 gap-y-0.5 items-start";
  if (!route) {
    return (
      <div className={box}>
        <Spinner size={12} />
        <span className="text-xs text-[var(--text-secondary)]">Checking which of your connectors can send this…</span>
      </div>
    );
  }
  const where = target.draft?.target ?? `${route.label}`;
  if (route.channel === "board") {
    return (
      <div className={box}>
        <span className="w-5 h-5 rounded-md grid place-items-center bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-[var(--success)]"><Check size={11} /></span>
        <span className="text-xs font-medium">This project&apos;s board</span>
        <span className="col-start-2 text-2xs text-[var(--text-tertiary)]">Cairn creates the cards with its own tools.</span>
      </div>
    );
  }
  const tool = route.tools[0];
  if (tool) {
    return (
      <div className={box}>
        <span className="w-5 h-5 rounded-md grid place-items-center bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-[var(--success)]"><Send size={10} /></span>
        <span className="text-xs font-medium">Reply on {where}</span>
        <span className="col-start-2 text-2xs text-[var(--text-tertiary)] leading-relaxed">
          Cairn can send this with <span className="font-mono text-[var(--text-secondary)] bg-[var(--surface-3)] rounded px-1">{tool.op}</span>
          {route.tools.length > 1 && <> (or {route.tools.length - 1} other {route.tools.length === 2 ? "tool" : "tools"})</>}.
        </span>
      </div>
    );
  }
  return (
    <div className={box}>
      <span className="w-5 h-5 rounded-md grid place-items-center bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-[var(--warning)] text-2xs font-semibold">!</span>
      <span className="text-xs font-medium">Reply on {where}</span>
      <span className="col-start-2 text-2xs text-[var(--text-tertiary)] leading-relaxed">
        {route.error
          ? `Couldn't list your connectors (${route.error}). Copy the reply and send it yourself.`
          : `None of the connectors on this project can send on ${route.label}; they only read. Copy the reply and send it yourself, or attach a connector that can send.`}
      </span>
    </div>
  );
}
