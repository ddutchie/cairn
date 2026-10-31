# Cairn Mobile

Expo (React Native) client for Cairn. Offline-first notes/tasks/board synced to
the desktop via an iCloud folder, plus an AI chat + note assistant.

## Setup

```bash
npm install            # also symlinks ../shared as @cairn/shared (postinstall)
cp .env.example .env.local   # fill in as needed (see below)
npm start
```

## Environment

All build-time config lives in `.env.local` (git-ignored). See `.env.example`
for the full list. `.env.example` is the only committed env file and contains
no secrets.

| Var | Purpose |
|-----|---------|
| `APPLE_TEAM_ID` | Apple Developer team for automatic on-device signing. Optional. |

## AI backend

Chat and the note AI actions run through a **pluggable provider** (`src/chat/providers/`).
The active provider is chosen automatically:

1. **Apple Intelligence** — when the device supports it and the user picks it in
   the AI settings sheet. No key needed.

2. **OpenAI-compatible** — configure an endpoint in-app via the
   **gear icon on the Chat screen**:
   - **Base URL** — any OpenAI-compatible `/v1` endpoint (OpenAI, Azure OpenAI,
     OpenRouter, Together, Groq, LM Studio, Ollama's OpenAI shim, …).
     Default: `https://api.openai.com/v1`.
   - **Model** — e.g. `gpt-4o-mini`.
   - **API key** — stored in the device keychain via `expo-secure-store`, never
     in the database and never synced.

If neither is available, chat shows a "Set up AI" prompt.

### Provider internals

- `providers/types.ts` — normalised `StreamEvent` + `ChatProvider` interface.
- `providers/responses.ts` — OpenAI Responses API, for endpoints that serve it.
- `providers/apple.ts` — Apple Intelligence.
- `providers/openai.ts` — OpenAI `/v1/chat/completions`, maps our message/tool
  shapes to OpenAI's and translates streamed chunks back to `StreamEvent`s.
- `providers/index.ts` — `resolveProvider()` auto-selection.
- `chat/ai-config.ts` — persists the OpenAI base URL/model (SQLite `app_settings`),
  API key (keychain), and the provider preference (`getProviderPref`/`setProviderPref`).
- `components/AiSettingsSheet.tsx` — the in-app AI settings sheet (Apple/OpenAI
  toggle + OpenAI base URL / model / key fields), opened from the Chat header.

The agent loop (`chat/agent.ts`) is provider-agnostic — it only consumes the
normalised event stream.

## Releasing to TestFlight

CI builds the iOS app on **EAS Build** (Expo's cloud macOS workers, managed
signing) and uploads it to TestFlight with **EAS Submit**. The workflow lives at
`.github/workflows/release-mobile.yml`.

### One-time setup

1. Create an Expo account and, in `mobile/`, initialise the EAS project:
   ```sh
   npm i -g eas-cli
   eas login
   eas init                 # fills extra.eas.projectId in app.json (commit it)
   eas credentials          # set up iOS distribution cert + provisioning (managed)
   ```
2. Configure TestFlight submission credentials once (App Store Connect API key,
   stored on EAS, not in git):
   ```sh
   eas submit --platform ios --profile production   # prompts + stores the key
   ```
3. In the GitHub repo, add secret **`EXPO_TOKEN`**
   (expo.dev → Account → Access tokens). CI uses it for build + submit.

### Cutting a release

```sh
./scripts/releasemobile.sh 2.4.0
```

This bumps `mobile/app.json` `version`, commits, and pushes the tag
`mobile-v2.4.0`, which triggers the workflow. The iOS **build number** is
auto-incremented by EAS (`appVersionSource: "remote"` in `eas.json`) — you only
bump the marketing version. You can also run the workflow manually from the
Actions tab (**Release Mobile (TestFlight)** → Run workflow).
> Builds without it fall back to the in-app OpenAI-compatible provider.

## Over-the-air updates (EAS Update)

JS and asset changes can ship to already-installed builds **without a new
TestFlight submission** via EAS Update — much cheaper and faster than a full
build. Configured with `runtimeVersion: { policy: "appVersion" }`, so updates
only reach builds with the same marketing `version`.

Publish an update:

```sh
./scripts/publishupdate.sh "what changed"          # → production channel
./scripts/publishupdate.sh "what changed" preview  # → preview channel
```

The app checks for updates on cold launch and on returning to the foreground
(`src/updates/useAppUpdates.ts`), downloads them in the background, and shows a
**"An update is ready — Restart"** banner (`src/components/UpdateBanner.tsx`)
that reloads into the new bundle when tapped. Updates are disabled in dev, so
this is inert until a release/EAS build.

> **Native changes need a full build.** Adding a native module, changing a
> config plugin, bumping the SDK, or adding permissions changes the
> runtimeVersion — push those with `scripts/releasemobile.sh` (build + submit),
> not an OTA update. Shipping JS that expects native changes to an old build
> will crash it.
