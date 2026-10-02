"use client";

/**
 * ChatApprovalPicker — what the chat assistant asks before running, shown next
 * to the personality picker under the chat input. Global like the personality
 * (aiConfig.chatApprovalPolicy); main resolves the same value for requests
 * that don't carry it. Chat has no sandbox, so this is chosen per tool class
 * (see shared/agent/chat-approval.ts) rather than via the coding agent's
 * permission presets.
 */

import { ShieldCheck } from "lucide-react";
import { useCairnStore } from "@/store";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import {
  CHAT_APPROVAL_OPTIONS,
  resolveChatApprovalPolicy,
  type ChatApprovalPolicy,
} from "../../../shared/agent/chat-approval";

export function ChatApprovalPicker({ disabled }: { disabled?: boolean }) {
  const stored = useCairnStore((s) => s.aiConfig.chatApprovalPolicy);
  const setPolicy = useCairnStore((s) => s.setChatApprovalPolicy);
  const value = resolveChatApprovalPolicy(stored);
  const current = CHAT_APPROVAL_OPTIONS.find((o) => o.value === value);

  return (
    <Tooltip content={current?.description ?? "What the assistant asks before running"} side="top">
      <span className="flex items-center gap-1" aria-label={`Chat approvals: ${current?.label ?? value}`}>
        <ShieldCheck size={11} className="text-[var(--text-tertiary)] shrink-0" />
        <Select<ChatApprovalPolicy>
          size="sm"
          ariaLabel="Chat approvals"
          value={value}
          disabled={disabled}
          onChange={(next) => { if (next !== value) setPolicy(next); }}
          options={CHAT_APPROVAL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          className="text-[0.643rem] px-1.5 py-0.5"
        />
      </span>
    </Tooltip>
  );
}
