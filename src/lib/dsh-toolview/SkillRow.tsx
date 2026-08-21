/**
 * §11 spike — vendored dsh `skill` toolview (SkillRow), rendering inside Cairn.
 *
 * A faithful port of scratch/dsh-repo/packages/client/ui-skill/src/client/SkillRow.tsx:
 * a replay-stable accent row derived ONLY from the logged tool call/result slice
 * (our ToolCallBlock) — no session store, no RPC, no dsh shell. The ONLY changes
 * vs upstream: (1) local primitive stand-ins (primitives.tsx), (2) plain
 * className strings against the scoped stylesheet (dsw-theme.css) instead of a
 * CSS module, (3) an inlined `t()` (we don't wire dsh's locale seat for a spike).
 *
 * This is the artifact that proves a dsh plugin's UI renders in Cairn's own
 * transcript when handed a Cairn-built ToolCallViewProps.
 */
import React, { useState, type KeyboardEvent, type ReactNode } from "react";
import { IconChevronDownOutline14, IconInspectOutline12, IconSkillOutline16, StateDot } from "./primitives";
import type { ToolCallViewProps, ToolCallBlock } from "./contract";

type SkillRowState = "running" | "ok" | "error" | "stopped";

interface SkillRowModel {
  readonly name: string;
  readonly output: string | null;
  readonly errorSummary: string | null;
  readonly state: SkillRowState;
}

const t = (key: string): string => {
  switch (key) {
    case "row.running": return "Skill running";
    case "row.failed": return "Skill failed";
    case "row.stopped": return "Skill stopped";
    case "row.instructions": return "Instructions";
    default: return key;
  }
};

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}

function skillName(argsRaw: string, callId: string): string {
  try {
    const parsed = JSON.parse(argsRaw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const name = (parsed as Record<string, unknown>).name;
      if (typeof name === "string" && name !== "") return firstLine(name);
    }
  } catch { /* streaming truncated-JSON prefix — fall through */ }
  return argsRaw === "" ? callId : firstLine(argsRaw);
}

function resultText(block: ToolCallBlock): string | null {
  if (!("kind" in block)) return null;
  const parts: string[] = [];
  for (const item of block.content) {
    parts.push(item.type === "text" ? (item as { text: string }).text : JSON.stringify(item, null, 2));
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`);
  return parts.join("\n") || null;
}

function skillRowModel(block: ToolCallBlock): SkillRowModel {
  const settled = "kind" in block;
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
  const state: SkillRowState = !settled
    ? "running"
    : block.error?.code === "interrupted"
      ? "stopped"
      : block.isError ? "error" : "ok";
  const output = resultText(block);
  return {
    name: skillName(argsRaw, block.callId),
    output,
    errorSummary: state === "error" && output !== null ? firstLine(output) : null,
    state,
  };
}

function leadingFor(state: SkillRowState): ReactNode {
  switch (state) {
    case "error": return <StateDot state="error" />;
    case "stopped": return <StateDot state="warning" />;
    default: return <IconSkillOutline16 size={14} />;
  }
}

function disclosureLeading(state: SkillRowState, open: boolean, expandable: boolean): ReactNode {
  if (open) return <IconChevronDownOutline14 className="dsh-skill-chevron" />;
  const icon = leadingFor(state);
  if (!expandable) return icon;
  return (
    <>
      <span className="dsh-skill-iconIdle">{icon}</span>
      <IconChevronDownOutline14 className="dsh-skill-chevron dsh-skill-chevronHover" />
    </>
  );
}

function stateStatus(state: SkillRowState): string | null {
  switch (state) {
    case "running": return t("row.running");
    case "error": return t("row.failed");
    case "stopped": return t("row.stopped");
    default: return null;
  }
}

export function SkillRow({ block, inspect }: ToolCallViewProps) {
  const model = skillRowModel(block);
  const [expanded, setExpanded] = useState(false);
  const expandable = model.output !== null;
  const open = expanded && expandable;
  const status = stateStatus(model.state);
  const summary = model.errorSummary ?? model.name;
  const toggleExpand = (): void => setExpanded((v) => !v);
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggleExpand();
  };
  const disclosureProps = expandable
    ? { role: "button" as const, tabIndex: 0, "aria-expanded": open, onClick: toggleExpand, onKeyDown: toggleFromKeyboard }
    : {};
  const leading = disclosureLeading(model.state, open, expandable);
  return (
    <div className="dsh-skill-card" data-tool="skill" data-state={model.state}>
      <div className="dsh-skill-row" data-expandable={expandable || undefined} {...disclosureProps}>
        <span className="dsh-skill-leading">{leading}</span>
        {status !== null ? <span className="dsh-skill-visuallyHidden">{status}</span> : null}
        <span className="dsh-skill-title">Skill</span>
        <span className="dsh-skill-separator" aria-hidden />
        <span className={model.errorSummary === null ? "dsh-skill-summary" : "dsh-skill-summary dsh-skill-errorSummary"}>
          {summary}
        </span>
      </div>
      {open ? (
        <div className="dsh-skill-bodyWrap">
          <section className="dsh-skill-instructionsCard" aria-label={t("row.instructions")}>
            <div className="dsh-skill-instructionsHeader">{t("row.instructions")}</div>
            <pre className="dsh-skill-instructions" data-error={model.state === "error" || undefined}>{model.output}</pre>
          </section>
          {inspect !== undefined ? (
            <button type="button" className="dsh-skill-inspectButton" onClick={inspect}>
              <IconInspectOutline12 />
              Inspect
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
