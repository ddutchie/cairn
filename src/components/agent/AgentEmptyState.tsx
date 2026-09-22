"use client";

import { Plus, Bot } from "lucide-react";
import { useAgentSessionActions } from "./useAgentSessionActions";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

export function AgentEmptyState() {
  const { handleNewSession, project } = useAgentSessionActions();

  return (
    <EmptyState
      icon={Bot}
      iconTone="accent"
      title="Cairn Agent"
      description={
        project?.codeDirectory
          ? "Start a new session or resume a previous one."
          : "Set a code directory on this project to start a session."
      }
      action={
        <Button
          variant="accent"
          size="sm"
          onClick={() => { void handleNewSession(); }}
          disabled={!project?.codeDirectory}
        >
          <Plus size={11} />
          New session
        </Button>
      }
      className="h-full p-6"
    />
  );
}
