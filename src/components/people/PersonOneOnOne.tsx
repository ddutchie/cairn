"use client";

/**
 * The 1:1 loop on the person page (W6): the person's Slack fields (read at
 * view time, never stored on the person) and the Next meeting section with the
 * Prep button and the saved brief.
 *
 * Fields: the cache shows first, a refresh runs in the background when it is
 * old, and a failed refresh keeps the last values marked "as of". With no Slack
 * connector the fields are absent. The brief describes what someone worked on;
 * there are no activity counts on this page.
 */

import React, { useCallback, useEffect, useState } from "react";
import { ExternalLink, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanelHeading } from "@/components/ui/panel";
import { MicroLabel } from "@/components/ui/labels";
import { peopleClient } from "@/lib/ipc/people";
import { useCairnStore } from "@/store";
import { useNow } from "@/lib/viz/hooks";
import { formatDate, formatRelative } from "../../../shared/format/date";
import { statusEmojiChar, type PersonProfile, type PrepBrief } from "../../../shared/people/oneonone";
import type { Person } from "../../../shared/types/people";
import type { PersonTimelineItem } from "../../../shared/types/people-view";

/** "14:05" in a time zone, or null when the zone isn't one the runtime knows. */
export function localTimeIn(timezone: string | undefined, now: Date = new Date()): string | null {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(now);
  } catch {
    return null;
  }
}

/** The profile for a person: the cache at once, then a background refresh. The page is keyed by person, so state starts empty for each; a late answer for a previous person is ignored. */
export function usePersonProfile(person: Pick<Person, "id" | "slackId">): PersonProfile | null {
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  useEffect(() => {
    let live = true;
    void peopleClient.profile(person.id).then((p) => { if (live) setProfile(p); }).catch(() => {});
    if (person.slackId) void peopleClient.refreshProfile(person.id).then((p) => { if (live) setProfile(p); }).catch(() => {});
    return () => { live = false; };
  }, [person.id, person.slackId]);
  return profile;
}

/**
 * Role, team, place, local time, pronouns and status. What you entered on the
 * person wins; Slack's title and time zone fill gaps, with an "as of" marker
 * when they may be old. Nothing when neither has any.
 */
export function ProfileLine({ profile, person }: { profile: PersonProfile | null; person?: Pick<Person, "title" | "team" | "location" | "timezone"> }) {
  const fields = profile?.fields ?? {};
  const time = localTimeIn(person?.timezone ?? fields.timezone);
  const own = [person?.title, person?.team, person?.location].filter(Boolean);
  const parts = [person?.title ?? fields.title, person?.team, person?.location, time ? `${time} local` : null, fields.pronouns].filter(Boolean);
  const status = [statusEmojiChar(fields.statusEmoji), fields.statusText].filter(Boolean).join(" ");
  // A failed read with nothing cached used to leave the page silent, so say so.
  const unavailable = profile?.error && Object.keys(fields).length === 0
    ? <p role="status" className="mt-1 text-xs text-[var(--text-tertiary)]">Slack profile unavailable: {profile.error}</p>
    : null;
  if (parts.length === 0 && !status) return unavailable;
  return (
    <>
    <p className="mt-1.5 text-sm text-[var(--text-secondary)]" aria-label={own.length > 0 || person?.timezone ? "Profile" : "From Slack"}>
      {parts.join(" · ")}
      {status && <span className="text-[var(--text-tertiary)]">{parts.length ? " · " : ""}{status}</span>}
      {profile?.stale && profile.fetchedAt && (
        <span className="ml-2 text-xs text-[var(--text-tertiary)]" title={profile.error ?? undefined}>
          as of {formatRelative(profile.fetchedAt, { absoluteAfterDays: 30 })}
        </span>
      )}
    </p>
    {unavailable}
    </>
  );
}

/** One line for the Slack id field in Settings: whether their profile is being read, and why not. */
export function slackStatusText(profile: PersonProfile | null, slackId: string | null | undefined): string {
  if (!slackId) return "Add their Slack id to show their title, time zone and status from Slack.";
  if (!profile) return "Reading their Slack profile…";
  if (profile.error) return `Couldn't read their Slack profile: ${profile.error}`;
  if (profile.fetchedAt) return `Read from Slack ${formatRelative(profile.fetchedAt, { absoluteAfterDays: 30 })}.`;
  return "Not read from Slack yet. Needs a connected Slack server.";
}

const SKIP_TEXT: Record<string, string> = {
  busy: "Another brief is being prepared. Try again in a moment.",
  off: "People is switched off.",
  "no-ai": "Set up an AI connection in Settings first.",
  "unknown-person": "That person isn't in this workspace.",
};

/** How long the button says "Preparing" on the strength of the click alone, before the run's first save confirms it. */
const STARTING_MS = 15_000;

function usePrep(workspaceId: string, personId: string) {
  const [state, setState] = useState<{ brief: PrepBrief | null; running: boolean }>({ brief: null, running: false });
  const [message, setMessage] = useState<string | null>(null);
  // Between the click and the run's first save the server has no brief yet; this bridges that gap.
  const [starting, setStarting] = useState(false);
  const load = useCallback(() => {
    void peopleClient.prep(workspaceId, personId).then(setState).catch(() => {});
  }, [workspaceId, personId]);
  useEffect(() => {
    load();
    return peopleClient.onPrepUpdated((e) => {
      if (e.personId !== personId) return;
      setStarting(false);
      load();
    });
  }, [load, personId]);
  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(() => { setStarting(false); load(); }, STARTING_MS);
    return () => clearTimeout(t);
  }, [starting, load]);
  const run = useCallback(async (meetingId?: string) => {
    setMessage(null);
    try {
      const r = await peopleClient.runPrep(workspaceId, personId, meetingId);
      if ("skipped" in r) setMessage(SKIP_TEXT[r.skipped] ?? "Couldn't start.");
      else setStarting(true);
    } catch {
      setMessage("Couldn't start.");
    }
    load();
  }, [workspaceId, personId, load]);
  return { brief: state.brief, running: state.running || starting, message, run };
}

/** The meeting the Prep button prepares for: the soonest one that hasn't begun. */
function nextMeeting(timeline: PersonTimelineItem[], now: number): { id: string; title: string; at: string } | null {
  let best: { id: string; title: string; at: string; ms: number } | null = null;
  for (const item of timeline) {
    if (item.kind !== "meeting") continue;
    const ms = Date.parse(item.meeting.startsAt);
    if (Number.isNaN(ms) || ms <= now) continue;
    if (!best || ms < best.ms) best = { id: item.meeting.id, title: item.meeting.title, at: item.meeting.startsAt, ms };
  }
  return best;
}

function BriefList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <MicroLabel>{label}</MicroLabel>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-[var(--text-secondary)]">
        {items.map((t) => <li key={t}>{t}</li>)}
      </ul>
    </div>
  );
}

function Brief({ brief }: { brief: PrepBrief }) {
  if (brief.error) {
    return <p className="text-xs text-[var(--danger)]">Couldn&apos;t prepare: {brief.error}</p>;
  }
  return (
    <div>
      {brief.summary && <p className="text-sm text-[var(--text-primary)]">{brief.summary}</p>}
      {brief.recent.length > 0 && (
        <div className="mt-3">
          <MicroLabel>Recently</MicroLabel>
          <ul className="mt-1 space-y-1 text-sm text-[var(--text-secondary)]">
            {brief.recent.map((r) => (
              <li key={r.text} className="flex items-start gap-1.5">
                <span className="min-w-0">{r.text}</span>
                {r.source && <span className="flex-shrink-0 text-xs text-[var(--text-tertiary)]">{r.source}</span>}
                {r.url && /^https?:\/\//.test(r.url) && (
                  <a href={r.url} target="_blank" rel="noreferrer" aria-label={`Open ${r.source ?? "the original"}`} className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                    <ExternalLink size={11} aria-hidden />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <BriefList label="Follow up" items={brief.followUps} />
      <BriefList label="Worth asking" items={brief.questions} />
      {brief.sources.some((s) => s.status === "error") && (
        <p className="mt-3 text-xs text-[var(--text-tertiary)]">
          Couldn&apos;t read {brief.sources.filter((s) => s.status === "error").map((s) => s.name).join(", ")}.
        </p>
      )}
    </div>
  );
}

/** Next meeting, the Prep button and the newest brief. */
export function NextMeeting({ person, timeline }: { person: Person; timeline: PersonTimelineItem[] }) {
  const workspaceId = useCairnStore((s) => s.activeWorkspaceId) ?? person.workspaceId;
  const { brief, running, message, run } = usePrep(workspaceId, person.id);
  const now = useNow();
  const next = nextMeeting(timeline, now);
  const preparing = running || brief?.status === "gathering";
  return (
    <section className="mb-9" aria-label="Next meeting">
      <PanelHeading
        title="Next meeting"
        note={next ? `${next.title}, ${formatDate(next.at)}` : "None booked"}
        action={(
          <Button variant="outline" size="sm" onClick={() => void run(next?.id)} disabled={preparing}>
            <Sparkles size={12} aria-hidden /> {preparing ? "Preparing" : brief ? "Prepare again" : "Prepare"}
          </Button>
        )}
      />
      {message && <p role="status" className="mb-2 text-xs text-[var(--text-tertiary)]">{message}</p>}
      {preparing && !brief?.summary ? (
        <p className="text-xs text-[var(--text-tertiary)]">Looking at your last meeting, open items and what they&apos;ve been working on.</p>
      ) : brief ? (
        <>
          <p className="mb-2 text-xs text-[var(--text-tertiary)]">Prepared {formatRelative(brief.generatedAt, { absoluteAfterDays: 30 })}</p>
          <Brief brief={brief} />
        </>
      ) : (
        <p className="text-xs text-[var(--text-tertiary)]">
          A short brief from your last meeting, open items and what they&apos;ve recently worked on.
        </p>
      )}
    </section>
  );
}
