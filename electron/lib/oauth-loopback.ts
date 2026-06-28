/**
 * Loopback redirect listener for the remote-MCP OAuth flow (RFC 8252 §7.3).
 *
 * Many authorization servers (Canva, Google, …) reject custom URI schemes such
 * as `cairn://oauth/callback` at the `/authorize` step and require an
 * `http://127.0.0.1:<port>/callback` loopback redirect instead. This module
 * spins up an ephemeral HTTP server bound to a random loopback port, hands back
 * the chosen redirect URI plus a promise that resolves with the `code`/`state`
 * once the browser is redirected to it.
 *
 * The server only ever binds to 127.0.0.1 and shuts itself down after the first
 * callback (or on timeout / explicit close). It serves a tiny HTML page telling
 * the user they can return to the app.
 *
 * Main-process only.
 */

import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import type { OAuthCallback } from "./mcp-oauth";

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** Abandon a loopback listener if the user never finishes in the browser. */
const LOOPBACK_TTL_MS = 10 * 60_000;

const DONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Cairn</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:22rem;padding:2rem}h1{font-size:1.1rem;margin:0 0 .5rem}
p{color:#a3a3a3;margin:0}</style></head><body><div class="card">
<h1>Signed in to Cairn</h1><p>You can close this tab and return to the app.</p>
</div></body></html>`;

const ERROR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Cairn</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:22rem;padding:2rem}h1{font-size:1.1rem;margin:0 0 .5rem}
p{color:#a3a3a3;margin:0}</style></head><body><div class="card">
<h1>Sign-in failed</h1><p>The authorization response was missing or invalid. Return to Cairn and try again.</p>
</div></body></html>`;

export interface LoopbackListener {
  /** The `http://127.0.0.1:<port>/callback` URI to register as the redirect. */
  redirectUri: string;
  /** Resolves with the parsed callback, or rejects on timeout/close. */
  waitForCallback: Promise<OAuthCallback>;
  /** Tear the listener down (idempotent). Safe to call after resolution. */
  close: () => void;
}

/**
 * Start an ephemeral loopback HTTP server for one OAuth round-trip. Binds to a
 * random free port on 127.0.0.1 and resolves once the browser hits
 * `/callback?code=…&state=…`.
 */
export function startLoopbackListener(): Promise<LoopbackListener> {
  return new Promise<LoopbackListener>((resolveListener, rejectListener) => {
    let settled = false;
    let resolveCb!: (cb: OAuthCallback) => void;
    let rejectCb!: (err: Error) => void;
    const waitForCallback = new Promise<OAuthCallback>((res, rej) => {
      resolveCb = res;
      rejectCb = rej;
    });
    // A rejection is expected when the user abandons the flow; pre-attach a noop
    // catch so an unhandled rejection is never reported before the caller awaits.
    void waitForCallback.catch(() => {});

    let timer: NodeJS.Timeout | undefined;

    const server: Server = createServer((req, res) => {
      // Only the callback path matters; everything else gets a 404.
      const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(ERROR_PAGE);
        if (!settled) {
          settled = true;
          rejectCb(new Error("OAuth callback missing code/state"));
          shutdown();
        }
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(DONE_PAGE);
      if (!settled) {
        settled = true;
        resolveCb({ code, state });
        shutdown();
      }
    });

    function shutdown(): void {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      server.close();
      if (!settled) {
        settled = true;
        rejectCb(new Error("OAuth loopback listener closed before completion"));
      }
    }

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        rejectCb(err);
      }
      rejectListener(err);
    });

    server.listen(0, LOOPBACK_HOST, () => {
      const { port } = server.address() as AddressInfo;
      timer = setTimeout(() => shutdown(), LOOPBACK_TTL_MS);
      // Don't keep the event loop / app alive for an idle listener.
      timer.unref?.();
      resolveListener({
        redirectUri: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`,
        waitForCallback,
        close: shutdown,
      });
    });
  });
}
