/**
 * Cairn — IPC handlers for the People layer (channels `people:*` and
 * `db:people:*`). Thin wrappers over `db/people-queries.ts` (writes, entity
 * reads) and `db/people-view-queries.ts` (the People view's read models).
 *
 * Plan: docs/plans/people-layer.md.
 */

import { registerContractHandle, broadcastEvent } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as pq from "../db/people-queries";
import * as pv from "../db/people-view-queries";
import * as tq from "../../shared/people/team-queries";
import { getCachedProfile, refreshProfile } from "../lib/people/profile";
import { proposeProfileFields } from "../lib/people/autofill";
import { findPrepAutomation, isPrepRunning, loadLatestPrepBrief, settleBrief } from "../lib/people/prep";
import { runPrepNow } from "../lib/heartbeat-runner";
import { applyMigration, buildInventory } from "../db/people-migration";
import { makeFrontmatterReader, refreshMeetingFrontmatter } from "../people-files";
import { suppressNextChange } from "../file-watcher";

export function registerPeopleHandlers(ctx: DbContext): void {
  registerContractHandle("db:people:list", (_e, { workspaceId, ...opts }) => handle(() => pq.listPeople(ctx.db, workspaceId, opts)));
  registerContractHandle("db:people:summaries", (_e, { workspaceId, ...opts }) =>
    handle(() => pv.listPersonSummaries(ctx.db, workspaceId, opts)),
  );
  registerContractHandle("db:people:network", (_e, { workspaceId }) => handle(() => pv.getPeopleNetwork(ctx.db, workspaceId)));
  registerContractHandle("db:people:get", (_e, { id }) => handle(() => pq.getPerson(ctx.db, id)));
  registerContractHandle("db:people:page", (_e, { id }) => handle(() => pv.getPersonPage(ctx.db, id)));
  registerContractHandle("db:people:create", (_e, input) => handle(() => pq.createPerson(ctx.db, input)));
  registerContractHandle("db:people:update", (_e, { id, patch }) =>
    handle(() => pq.updatePerson(ctx.db, id, patch)),
  );
  registerContractHandle("db:people:delete", (_e, { id }) => handle(() => pq.deletePerson(ctx.db, id)));

  registerContractHandle("db:people:relations", (_e, { personId, ...opts }) => handle(() => pq.getRelations(ctx.db, personId, opts)));
  registerContractHandle("db:people:edge:add", (_e, input) => handle(() => pq.addEdge(ctx.db, input)));
  registerContractHandle("db:people:edge:update", (_e, { id, patch }) => handle(() => pq.updateEdge(ctx.db, id, patch)));
  registerContractHandle("db:people:edge:remove", (_e, { id }) => handle(() => pq.removeEdge(ctx.db, id)));

  registerContractHandle("db:people:merge", (_e, { keepId, dropId }) =>
    handle(() => {
      const { person, meetingNoteIds } = pq.mergePeople(ctx.db, keepId, dropId);
      // The merged-away name leaves the attendee lists in those meeting notes' frontmatter.
      if (meetingNoteIds.length) refreshMeetingFrontmatter(ctx.db, ctx.workspacePath, meetingNoteIds, suppressNextChange);
      return person;
    }),
  );

  registerContractHandle("db:people:teams:list", (_e, { workspaceId }) => handle(() => tq.listTeams(ctx.db, workspaceId)));
  registerContractHandle("db:people:team:create", (_e, input) => handle(() => tq.createTeam(ctx.db, input)));
  registerContractHandle("db:people:team:update", (_e, { id, patch }) => handle(() => tq.updateTeam(ctx.db, id, patch)));
  registerContractHandle("db:people:team:delete", (_e, { id }) => handle(() => tq.deleteTeam(ctx.db, id)));
  registerContractHandle("db:people:team:merge", (_e, { keepId, dropId }) => handle(() => tq.mergeTeams(ctx.db, keepId, dropId)));
  registerContractHandle("db:people:memberships:list", (_e, { workspaceId }) => handle(() => tq.listMemberships(ctx.db, workspaceId)));
  registerContractHandle("db:people:team:member:add", (_e, input) => handle(() => tq.addMember(ctx.db, input)));
  registerContractHandle("db:people:team:member:end", (_e, { teamId, personId, endedAt }) => handle(() => tq.endMember(ctx.db, teamId, personId, endedAt)));
  registerContractHandle("db:people:team:member:delete", (_e, { teamId, personId }) => handle(() => tq.deleteMembership(ctx.db, teamId, personId)));

  registerContractHandle("db:people:meetings", (_e, { personId, limit }) => handle(() => pq.listPersonMeetings(ctx.db, personId, limit)));
  registerContractHandle("db:people:mentionNoteIds", (_e, { personId }) => handle(() => pq.listPersonMentionNoteIds(ctx.db, personId)));
  registerContractHandle("db:people:ownedCardIds", (_e, { personId }) => handle(() => pq.listOwnedCardIds(ctx.db, personId)));
  registerContractHandle("db:people:attendees", (_e, { meetingId, statuses }) => handle(() => pq.listAttendees(ctx.db, meetingId, statuses)));
  registerContractHandle("db:people:attendee:add", (_e, input) => handle(() => pq.addAttendee(ctx.db, input)));
  registerContractHandle("db:people:attendee:remove", (_e, { meetingId, personId }) =>
    handle(() => pq.removeAttendee(ctx.db, meetingId, personId)),
  );

  // ── 1:1 loop ─────────────────────────────────
  // Profile fields and prep briefs are read-time and device-local.
  registerContractHandle("people:profile:get", (_e, { personId }) =>
    handle(() => getCachedProfile(ctx.db, personId)),
  );
  registerContractHandle("people:profile:refresh", (_e, { personId }) =>
    handle(() => refreshProfile(ctx.db, personId)),
  );
  registerContractHandle("people:autofill:propose", (_e, { personId }) =>
    handle(() => proposeProfileFields(ctx.db, personId)),
  );
  registerContractHandle("people:prep:get", (_e, { workspaceId, personId }) =>
    handle(() => {
      const automation = findPrepAutomation(ctx.db, workspaceId);
      if (!automation) return { brief: null, running: false };
      const brief = loadLatestPrepBrief(ctx.workspacePath, automation, personId);
      // "Preparing" is for this person only, and only while their run is alive; a placeholder left by a crash reads as failed.
      return { brief: settleBrief(brief), running: isPrepRunning(personId) };
    }),
  );
  registerContractHandle("people:prep:run", (_e, { workspaceId, personId, meetingId }) =>
    handle(() => {
      return runPrepNow({ db: ctx.db, workspacePath: ctx.workspacePath, send: (channel, payload) => broadcastEvent(channel, payload) }, workspaceId, { personId, meetingId });
    }),
  );

  // Migration gate (W9): the inventory only reads; apply writes what the user approved, and never in a dry run.
  registerContractHandle("db:people:migration:inventory", (_e, { workspaceId }) =>
    handle(() => buildInventory(ctx.db, workspaceId, { readFrontmatter: makeFrontmatterReader(ctx.db, ctx.workspacePath, workspaceId) })),
  );
  registerContractHandle("db:people:migration:apply", (_e, { workspaceId, approvals, dryRun }) =>
    handle(() => {
      const result = applyMigration(ctx.db, workspaceId, approvals ?? {}, {
        dryRun: dryRun === true,
        readFrontmatter: makeFrontmatterReader(ctx.db, ctx.workspacePath, workspaceId),
        refreshFrontmatter: (noteIds) => refreshMeetingFrontmatter(ctx.db, ctx.workspacePath, noteIds, suppressNextChange),
      });
      if (!result.dryRun && result.applied) broadcastEvent("db:changed", null);
      return result;
    }),
  );
}
