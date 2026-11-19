"use client";

/**
 * Shared pieces of the two People canvases in Insights (relationship canvas,
 * org chart): the data hook, link colours, the filter chips and "open person".
 * Mounted by InsightsView.
 */
import { useCallback, useEffect, useState } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { peopleClient } from "@/lib/ipc/people";
import { hasElectron } from "@/lib/ipc/client";
import type { PeopleNetwork } from "../../../shared/types/people-view";
import { LINK_KIND_LABELS, type LinkKind } from "@/lib/people/network";

export const LINK_COLOR: Record<LinkKind, string> = {
  reporting: "var(--accent)",
  mentor: "var(--info)",
  buddy: "var(--success)",
  stakeholder: "var(--warning)",
  peer: "var(--text-secondary)",
  partner: "var(--node-person)",
  meeting: "var(--node-meeting)",
};

const EMPTY_NETWORK: PeopleNetwork = { edges: [], coAttendance: [] };

/**
 * People of the active workspace plus the network (edges, co-attendance).
 * Reloads when the people list changes (every people write refetches it).
 */
export function usePeopleNetwork() {
  const { people, workspaceId, loadPeople, peopleLoaded } = useCairnStore(useShallow((s) => ({
    people: s.people, workspaceId: s.activeWorkspaceId, loadPeople: s.loadPeople, peopleLoaded: s.peopleLoaded,
  })));
  const [network, setNetwork] = useState<{ workspaceId: string; data: PeopleNetwork } | null>(null);

  useEffect(() => { if (!peopleLoaded) void loadPeople(); }, [peopleLoaded, loadPeople]);

  useEffect(() => {
    if (!workspaceId || !hasElectron("people")) return;
    let cancelled = false;
    peopleClient.network(workspaceId)
      .then((data) => { if (!cancelled) setNetwork({ workspaceId, data }); })
      .catch((err) => {
        // Render with what the people list alone gives (relationship chips) rather than a blank canvas.
        console.warn("[people] network read failed", err);
        if (!cancelled) setNetwork({ workspaceId, data: EMPTY_NETWORK });
      });
    return () => { cancelled = true; };
  }, [workspaceId, people]);

  const data = network && network.workspaceId === workspaceId ? network.data : EMPTY_NETWORK;
  return { people: peopleLoaded ? people : EMPTY_PEOPLE, network: data, loading: !peopleLoaded || (hasElectron("people") && network?.workspaceId !== workspaceId) };
}
const EMPTY_PEOPLE: never[] = [];

/** Open a person in the Insights side panel. */
export function useOpenPerson() {
  const setPeoplePanel = useCairnStore((s) => s.setPeoplePanel);
  return useCallback((id: string) => setPeoplePanel(id), [setPeoplePanel]);
}

interface KindChipProps {
  kind: LinkKind;
  active: boolean;
  count: number;
  onToggle: () => void;
}

/** Filter chip for a link kind: coloured dot, name, count; toggles with aria-pressed. */
export function LinkKindChip({ kind, active, count, onToggle }: KindChipProps) {
  const color = LINK_COLOR[kind];
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={`${LINK_KIND_LABELS[kind]}, ${count}`}
      disabled={count === 0}
      className={cn(
        "flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors disabled:opacity-40 disabled:cursor-default",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        active ? "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)]" : "border-[var(--border-subtle)] text-[var(--text-tertiary)]",
      )}
    >
      <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, background: active ? color : "var(--text-tertiary)" }} />
      {LINK_KIND_LABELS[kind]}
      <span className="text-2xs tabular-nums text-[var(--text-tertiary)]">{count}</span>
    </button>
  );
}
