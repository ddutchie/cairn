"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CustomServiceConfig } from "@/types";
import { type HeaderRow, headersToRows, inputCls, labelCls } from "./helpers";
import { HeaderEditor } from "./HeaderEditor";

/** Add/edit form for a custom HTTP service exposed to the AI as one tool. */
export function ServiceForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: CustomServiceConfig;
  onSave: (s: Partial<CustomServiceConfig>, headerRows: HeaderRow[]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [apiUrl, setApiUrl] = useState(initial?.apiUrl ?? "");
  const [method, setMethod] = useState<CustomServiceConfig["method"]>(initial?.method ?? "GET");
  const [toolDefinition, setToolDefinition] = useState(initial?.toolDefinition ?? "");
  const [responseKeys, setResponseKeys] = useState((initial?.responseKeys ?? []).join(", "));
  const [rows, setRows] = useState<HeaderRow[]>(headersToRows(initial?.headers));

  let toolDefValid = false;
  try {
    if (toolDefinition.trim()) {
      const p = JSON.parse(toolDefinition) as Record<string, unknown>;
      const fn = (p.function ?? p) as Record<string, unknown>;
      toolDefValid = typeof fn.name === "string" && fn.name.trim().length > 0;
    }
  } catch {
    toolDefValid = false;
  }
  const valid = name.trim().length > 0 && /^https?:\/\//.test(apiUrl.trim()) && toolDefValid;

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-4 bg-[var(--surface-2)]">
      <div>
        <label className={labelCls}>Name *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="e.g. Web Search" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this API does" className={inputCls} />
      </div>
      <div className="flex gap-2">
        <div className="w-28">
          <label className={labelCls}>Method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value as CustomServiceConfig["method"])} className={inputCls}>
            {(["GET", "POST", "PUT", "DELETE"] as const).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className={labelCls}>API URL *</label>
          <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://api.example.com/search" className={cn(inputCls, "font-mono")} />
        </div>
      </div>
      <HeaderEditor rows={rows} onChange={setRows} />
      <div>
        <label className={labelCls}>Tool definition (JSON) *</label>
        <textarea
          value={toolDefinition}
          onChange={(e) => setToolDefinition(e.target.value)}
          rows={5}
          placeholder={'{"name":"search","description":"Search the web","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}'}
          className={cn(inputCls, "font-mono text-[0.714rem] resize-y", !toolDefValid && toolDefinition.trim() && "border-[var(--danger)]")}
        />
        {!toolDefValid && toolDefinition.trim() && (
          <p className="text-[0.714rem] text-[var(--danger)] mt-1">Must be valid JSON with a function name.</p>
        )}
      </div>
      <div>
        <label className={labelCls}>Response keys (comma-separated)</label>
        <input value={responseKeys} onChange={(e) => setResponseKeys(e.target.value)} placeholder="results, title, url, snippet" className={cn(inputCls, "font-mono")} />
        <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-1">Only these keys are kept from the response (saves tokens). Leave empty to return everything.</p>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          size="sm"
          disabled={!valid}
          onClick={() =>
            onSave(
              {
                id: initial?.id,
                name: name.trim(),
                description: description.trim() || undefined,
                apiUrl: apiUrl.trim(),
                method,
                toolDefinition: toolDefinition.trim(),
                responseKeys: responseKeys.split(",").map((s) => s.trim()).filter(Boolean),
                enabled: initial?.enabled ?? false,
                source: initial?.source ?? "manual",
              },
              rows
            )
          }
        >
          <Check size={12} /> Save service
        </Button>
      </div>
    </div>
  );
}
