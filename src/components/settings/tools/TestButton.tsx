"use client";

import { useState } from "react";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export type TestState = { status: "idle" | "testing" | "ok" | "error"; detail?: string };

/** "Test connection" button that runs an async probe and shows the result inline. */
export function TestButton({ onTest }: { onTest: () => Promise<TestState> }) {
  const [state, setState] = useState<TestState>({ status: "idle" });
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={state.status === "testing"}
        onClick={async () => {
          setState({ status: "testing" });
          try {
            setState(await onTest());
          } catch (err) {
            setState({ status: "error", detail: err instanceof Error ? err.message : "Test failed" });
          }
        }}
      >
        {state.status === "testing" ? <Loader2 size={12} className="animate-spin" /> : null}
        Test connection
      </Button>
      {state.status === "ok" && (
        <span className="flex items-center gap-1 text-[0.714rem] text-[var(--success)]">
          <CheckCircle size={12} /> {state.detail ?? "OK"}
        </span>
      )}
      {state.status === "error" && (
        <span className="flex items-center gap-1 text-[0.714rem] text-[var(--danger)] truncate max-w-[16rem]" title={state.detail}>
          <XCircle size={12} /> {state.detail ?? "Failed"}
        </span>
      )}
    </div>
  );
}
