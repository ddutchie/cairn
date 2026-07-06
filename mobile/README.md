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
| `EXPO_PUBLIC_TOOLKIT_URL` | First-party Rork endpoint. **Leave blank unless you are the Cairn maintainer.** |

## AI backend

Chat and the note AI actions run through a **pluggable provider** (`src/chat/providers/`).
The active provider is chosen automatically:

1. **Rork toolkit** — used when `EXPO_PUBLIC_TOOLKIT_URL` is set at build time.
   This is a **first-party-only** path. The Rork endpoint is unauthenticated, so
   its URL is never committed to the repo (no default in source) — it is
   injected from `.env.local` at build time only. Do not add it to git.

2. **OpenAI-compatible** — the default for anyone building Cairn themselves.
   Leave `EXPO_PUBLIC_TOOLKIT_URL` blank and configure an endpoint in-app under
   **Settings → AI**:
   - **Base URL** — any OpenAI-compatible `/v1` endpoint (OpenAI, Azure OpenAI,
     OpenRouter, Together, Groq, LM Studio, Ollama's OpenAI shim, …).
     Default: `https://api.openai.com/v1`.
   - **Model** — e.g. `gpt-4o-mini`.
   - **API key** — stored in the device keychain via `expo-secure-store`, never
     in the database and never synced.

If neither is configured, chat surfaces a "No AI provider configured" prompt.

### Why this split

The Rork endpoint has no authentication, so a public URL would let anyone build
an app against it and run up server-side costs. Keeping it out of git — and
giving third parties a first-class bring-your-own-key path — means the open
source build never depends on (or exposes) our endpoint.

> Note: `EXPO_PUBLIC_*` vars are inlined into the shipped JS bundle, so the Rork
> URL is still extractable from a first-party *binary*. Env injection only keeps
> it out of git/source. A fully abuse-proof setup requires an authenticated
> proxy in front of Rork (tracked separately).

### Provider internals

- `providers/types.ts` — normalised `StreamEvent` + `ChatProvider` interface.
- `providers/rork.ts` — Rork `/agent/chat` (native tool-calling, env-only URL).
- `providers/openai.ts` — OpenAI `/v1/chat/completions`, maps our message/tool
  shapes to OpenAI's and translates streamed chunks back to `StreamEvent`s.
- `providers/index.ts` — `resolveProvider()` auto-selection.
- `chat/ai-config.ts` — persists the OpenAI base URL/model (SQLite `app_settings`)
  and API key (keychain).

The agent loop (`chat/agent.ts`) is provider-agnostic — it only consumes the
normalised event stream.
