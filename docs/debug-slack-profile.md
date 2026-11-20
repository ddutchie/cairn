# Debug: Slack profile not showing (branch `debug/slack-profile`)

Slack profile fields (title, time zone, pronouns, status) are read from the Slack
connector when a person's page opens. This branch traces that and shows failures.

What differs from the main branch (revert before merging anything):
- `electron/lib/people/profile.ts`: `[slack-profile]` logging at every decision, and the
  24h-fresh and 10-minute retry guards are bypassed, so every page open fetches.
- `PersonOneOnOne.tsx`: when Slack gave nothing, the error is shown in red under the name.
  (The `#` icon when a profile is connected is meant to stay.)

## Test
1. `git fetch && git checkout debug/slack-profile && npm install && npm run compile`
2. Start from a terminal so the main-process log is visible: `npm run dev` (or the
   usual Electron start script). Logs print in that terminal.
3. Settings → Tools: confirm a Slack connector is connected and note its name.
4. Open a person with a Slack id (e.g. U0123ABCD) from People.
5. Read the `[slack-profile]` lines, top to bottom:
   - `refresh start` shows the slackId. `null` means the id isn't saved on that person.
   - `connectors in scope` lists every connector. If Slack isn't there it isn't enabled for this workspace's projects.
   - `slack connectors matched` is empty → the connector's id/name doesn't contain "slack". Rename it.
   - `tools on <id>` lists the connector's tools. `picked lookup tool: null` → no read-only
     user-profile tool with a user-id argument; paste the tool list back.
   - `reply` is Slack's raw answer. `parsed fields: null` → format we don't parse; paste the reply.
6. Success: the `#` icon appears beside the profile line and the fields show.
7. Retry any time by switching to another person and back.

Paste the `[slack-profile]` output (remove names you don't want to share) to continue.
