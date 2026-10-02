"use client";

/**
 * AgentPermissionSelect — permission-preset switcher for coding sessions.
 *
 * Data comes from the dsh permission-presets domain: an initial
 * `session:permissions` snapshot on mount, then live `session:projection
 * kind:"permissions"` updates from permissions-bridge. Writes go through
 * `session:permissions:set`, which applies live when a turn has the presets
 * service mounted and otherwise queues the choice for the next turn — the
 * service inject-gates on the per-turn `shell`, so `/permission` does not
 * exist while the session is idle (including a new session before its first
 * message). The snapshot serves the package's static preset table in that
 * state, so the switcher renders immediately. The upstream `custom` value
 * (effective knobs match no preset) renders as a disabled row — shown, never
 * a switch target.
 */

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import type { SessionProjection, SessionProjectionData } from "../../../shared/agent/session-projection";

type PermissionsSelect = SessionProjectionData["permissions"];

/** Upstream's derived not-a-preset marker — shown, never a switch target. */
const CUSTOM_VALUE = "custom";

interface AgentPermissionSelectProps {
  sessionId: string;
}

type SnapshotResult =
  | { ok: true; value: PermissionsSelect }
  | { ok: false; code: string; message: string };

function isSelect(value: unknown): value is PermissionsSelect {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { options?: unknown; currentValue?: unknown };
  return Array.isArray(v.options) && typeof v.currentValue === "string";
}

export function AgentPermissionSelect({ sessionId }: AgentPermissionSelectProps) {
  const [select, setSelect] = useState<PermissionsSelect | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A live projection is newer than the in-flight cold read — once one
    // arrives, the pending snapshot must not clobber it when it settles.
    let liveUpdate = false;
    const electron = window.electron;
    if (!electron) return;
    // Cold read — works before any live projection (fresh pane, no turn yet).
    const read = () => void electron.session.permissions(sessionId).then((res: SnapshotResult) => {
      if (cancelled || liveUpdate || !res || typeof res !== "object" || !("ok" in res) || !res.ok) return;
      if (isSelect(res.value)) setSelect(res.value);
    }).catch(() => undefined);
    read();
    // The presets service only mounts with a coding turn's shell, and a resumed
    // session emits no preset change — so re-read once each turn is underway.
    const unsubEvent = electron.session.onEvent?.((envelope) => {
      if (!cancelled && envelope.sessionId === sessionId && envelope.event.type === "step/start") read();
    });
    // Live select — preset switches (this pane's or the model's) re-render.
    const unsub = electron.session.onProjection((projection: SessionProjection) => {
      if (cancelled || projection.sessionId !== sessionId || projection.kind !== "permissions") return;
      if (isSelect(projection.data)) { liveUpdate = true; setSelect(projection.data); }
    });
    return () => { cancelled = true; unsub?.(); unsubEvent?.(); };
  }, [sessionId]);

  if (!select) return null;

  const onChange = (value: string) => {
    if (value === CUSTOM_VALUE || value === select.currentValue) return;
    // Refresh after settle so a rejected switch snaps back to the true value
    // even if the projection broadcast is missed.
    const done = window.electron?.session.setPermissionPreset(sessionId, value);
    void done?.catch(() => undefined).finally(() => {
      void window.electron?.session.permissions(sessionId).then((res: SnapshotResult) => {
        if (!res || typeof res !== "object" || !("ok" in res) || !res.ok) return;
        if (isSelect(res.value)) setSelect(res.value);
      }).catch(() => undefined);
    });
  };

  const current = select.options.find((o) => o.value === select.currentValue);
  const tip = current?.description ?? "Permission preset (sandbox + approval)";

  return (
    <Tooltip content={tip} side="left">
      <span className="flex items-center gap-1" aria-label={`Permission preset: ${current?.name ?? select.currentValue}`}>
        <ShieldCheck size={12} className="text-[var(--text-tertiary)] shrink-0" />
        <Select
          size="sm"
          ariaLabel="Permission preset"
          value={select.currentValue}
          onChange={onChange}
          options={select.options.map((o) => ({
            value: o.value,
            label: o.name,
            disabled: o.value === CUSTOM_VALUE,
          }))}
          className="max-w-44 text-[0.714rem] py-1"
        />
      </span>
    </Tooltip>
  );
}
