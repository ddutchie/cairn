"use client";

import { memo, useState, useCallback } from "react";
import { Handle, Position, type NodeProps, useReactFlow } from "@xyflow/react";
import { Sparkles, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { NoteMarkdownPreview } from "@/components/notes/NoteMarkdownPreview";

export interface AiSummaryNodeData {
  content?: string;
}

export const AiSummaryNode = memo(function AiSummaryNode({ id, data, selected, isConnectable }: NodeProps) {
  const d = data as unknown as AiSummaryNodeData;
  const aiConfig = useCairnStore((s) => s.aiConfig);
  const aiEnabled = aiConfig.aiEnabled ?? true;
  const { updateNodeData } = useReactFlow();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!window.electron) return;
    setStatus("loading");
    setErrorMsg(null);

    const config = {
      baseUrl: aiConfig.baseUrl || "https://api.openai.com",
      model: aiConfig.model || "gpt-4o-mini",
      apiKey: aiConfig.apiKey || "",
    };

    try {
      // invoke() unwraps { data } and throws on { error }, so we get the
      // payload directly: { nodeId, content }
      const result = await window.electron.flow.node.summarize(id, config) as
        { nodeId: string; content: string };

      // Optimistically update local React Flow state so the UI refreshes
      // without waiting for the onDbChanged reload cycle.
      updateNodeData(id, { content: result.content });
      setStatus("idle");
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStatus("error");
    }
  }, [id, aiConfig, updateNodeData]);

  const hasContent = !!d.content;

  return (
    <div
      className={cn(
        "min-w-[200px] max-w-[320px] rounded-xl border bg-[var(--surface)] shadow-sm transition-shadow",
        selected
          ? "border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-dim)]"
          : "border-[var(--accent)]/30 hover:border-[var(--accent)]/60"
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
        className="!bg-[var(--accent)] !border-[var(--surface)] !w-2.5 !h-2.5"
      />

      <div className="px-3 pt-2.5 pb-2.5">
        {/* Header row */}
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <Sparkles size={12} className="text-[var(--accent)]" />
            <span className="text-[0.714rem] font-semibold text-[var(--accent)] uppercase tracking-wide">
              AI Summary
            </span>
          </div>
          <button
            className={cn(
              "nodrag flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.714rem] font-medium transition-colors",
              status === "loading" || !aiEnabled
                ? "text-[var(--text-tertiary)] cursor-not-allowed opacity-40"
                : "text-[var(--accent)] hover:bg-[var(--accent)]/10 cursor-pointer"
            )}
            onClick={handleGenerate}
            disabled={status === "loading" || !aiEnabled}
            title={!aiEnabled ? "AI features are disabled — enable in Settings → AI" : hasContent ? "Re-generate summary from connected nodes" : "Generate summary from connected nodes"}
          >
            {status === "loading" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <RefreshCw size={10} />
            )}
            {status === "loading" ? "Generating…" : hasContent ? "Regenerate" : "Generate"}
          </button>
        </div>

        {/* Content */}
        {status === "error" && errorMsg ? (
          <p className="text-[0.786rem] text-[var(--danger)] leading-relaxed break-words">
            {errorMsg}
          </p>
        ) : hasContent ? (
          <div className="text-[0.786rem] text-[var(--text-secondary)] leading-relaxed break-words max-h-64 overflow-y-auto nodrag">
            <NoteMarkdownPreview content={d.content!} className="!px-0 !py-0 !overflow-visible !h-auto" />
          </div>
        ) : (
          <p className="text-[0.786rem] text-[var(--text-tertiary)] leading-relaxed italic">
            Connect to nodes, then hit Generate.
          </p>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        className="!bg-[var(--accent)] !border-[var(--surface)] !w-2.5 !h-2.5"
      />
    </div>
  );
});
