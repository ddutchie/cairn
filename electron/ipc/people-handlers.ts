/**
 * Cairn — IPC handlers for the People layer (channels `people:flag:*` and
 * `db:people:*`). Thin wrappers over `db/people-queries.ts` (writes, entity
 * reads) and `db/people-view-queries.ts` (the People view's read models).
 *
 * The data layer answers whether or not the `feature.people` flag is on (plan:
 * docs/plans/people-layer.md); the renderer gates the view on the flag.
 */

import { registerContractHandle, broadcastEvent } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as pq from "../db/people-queries";
import * as pv from "../db/people-view-queries";
import { getCachedProfile, refreshProfile, clearProfile } from "../lib/people/profile";
import { findPrepAutomation, loadLatestPrepBrief } from "../lib/people/prep";
import { runPrepNow } from "../lib/heartbeat-runner";
import { hasInFlightRun } from "../db/automation-queries";

export function registerPeopleHandlers(ctx: DbContext): void {
  registerContractHandle("people:flag:get", () => handle(() => pq.isPeopleEnabled(ctx.db)));
  registerContractHandle("people:flag:set", (_e, { on }) =>
    handle(() => {
      pq.setPeopleEnabled(ctx.db, on === true);
      // Other windows re-read the flag on db:changed (see runChangeFeedRefresh).
      broadcastEvent("db:changed", null);
      return pq.isPeopleEnabled(ctx.db);
    }),
  );

  registerContractHandle("db:people:list", (_e, { workspaceId, ...opts }) => handle(() => pq.listPeople(ctx.db, workspaceId, opts)));
  registerContractHandle("db:people:summaries", (_e, { workspaceId, ...opts }) =>
    handle(() => pv.listPersonSummaries(ctx.db, workspaceId, opts)),
  );
  registerContractHandle("db:people:get", (_e, { id }) => handle(() => pq.getPerson(ctx.db, id)));
  registerContractHandle("db:people:page", (_e, { id }) => handle(() => pv.getPersonPage(ctx.db, id)));
  registerContractHandle("db:people:create", (_e, input) => handle(() => pq.createPerson(ctx.db, input)));
  registerContractHandle("db:people:update", (_e, { id, patch }) =>
    handle(() => {
      const before = patch.slackId !== undefined ? pq.getPerson(ctx.db, id)?.slackId : undefined;
      const updated = pq.updatePerson(ctx.db, id, patch);
      // Fields cached for another Slack id would belong to someone else.
      if (patch.slackId !== undefined && updated.slackId !== before) clearProfile(ctx.db, id);
      return updated;
    }),
  );
  registerContractHandle("db:people:delete", (_e, { id }) => handle(() => { pq.deletePerson(ctx.db, id); clearProfile(ctx.db, id); }));

  registerContractHandle("db:people:relations", (_e, { personId, ...opts }) => handle(() => pq.getRelations(ctx.db, personId, opts)));
  registerContractHandle("db:people:edge:add", (_e, input) => handle(() => pq.addEdge(ctx.db, input)));
  registerContractHandle("db:people:edge:update", (_e, { id, patch }) => handle(() => pq.updateEdge(ctx.db, id, patch)));
  registerContractHandle("db:people:edge:remove", (_e, { id }) => handle(() => pq.removeEdge(ctx.db, id)));

  registerContractHandle("db:people:meetings", (_e, { personId, limit }) => handle(() => pq.listPersonMeetings(ctx.db, personId, limit)));
  registerContractHandle("db:people:mentionNoteIds", (_e, { personId }) => handle(() => pq.listPersonMentionNoteIds(ctx.db, personId)));
  registerContractHandle("db:people:ownedCardIds", (_e, { personId }) => handle(() => pq.listOwnedCardIds(ctx.db, personId)));
  registerContractHandle("db:people:attendees", (_e, { meetingId, statuses }) => handle(() => pq.listAttendees(ctx.db, meetingId, statuses)));
  registerContractHandle("db:people:attendee:add", (_e, input) => handle(() => pq.addAttendee(ctx.db, input)));
  registerContractHandle("db:people:attendee:remove", (_e, { meetingId, personId }) =>
    handle(() => pq.removeAttendee(ctx.db, meetingId, personId)),
  );

  // ── 1:1 loop ─────────────────────────────────
  // Profile fields and prep briefs are read-time and device-local: the flag gates them like the rest.
  registerContractHandle("people:profile:get", (_e, { personId }) =>
    handle(() => (pq.isPeopleEnabled(ctx.db) ? getCachedProfile(ctx.db, personId) : { fields: {}, stale: false })),
  );
  registerContractHandle("people:profile:refresh", (_e, { personId }) =>
    handle(() => (pq.isPeopleEnabled(ctx.db) ? refreshProfile(ctx.db, personId) : { fields: {}, stale: false })),
  );
  registerContractHandle("people:prep:get", (_e, { workspaceId, personId }) =>
    handle(() => {
      if (!pq.isPeopleEnabled(ctx.db)) return { brief: null, running: false };
      const automation = findPrepAutomation(ctx.db, workspaceId);
      if (!automation) return { brief: null, running: false };
      const brief = loadLatestPrepBrief(ctx.workspacePath, automation, personId);
      // The placeholder a run saves first reads as "preparing" while the run is alive; a stale one (crash) doesn't.
      const running = hasInFlightRun(ctx.db, automation.id) && brief?.status === "gathering";
      return { brief: brief && brief.status === "gathering" && !running ? { ...brief, status: "ready" as const, error: "The run was interrupted." } : brief, running };
    }),
  );
  registerContractHandle("people:prep:run", (_e, { workspaceId, personId, meetingId }) =>
    handle(() => {
      return runPrepNow({ db: ctx.db, workspacePath: ctx.workspacePath, send: (channel, payload) => broadcastEvent(channel, payload) }, workspaceId, { personId, meetingId });
    }),
  );
}
