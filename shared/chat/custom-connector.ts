/**
 * A connector the user adds by hand (not from the community registry): a remote
 * MCP server URL, optionally with OAuth and a pre-registered client id.
 *
 * Pure so the phone's form and any other surface agree on what is valid. The
 * client id is the part providers that do not offer dynamic registration need
 * (Microsoft Entra, Slack, and any tenant that wants its own app): the user
 * registers an app with the provider and pastes its public id here. PKCE means
 * there is no client secret to store.
 */

export interface CustomMcpInput {
  name: string;
  url: string;
  /** "oauth" runs the sign-in flow; "none" connects with no credentials. */
  authMode: "none" | "oauth";
  /** Space-delimited OAuth scopes. */
  scope?: string;
  /** Public client id from the user's own app registration. Empty means discovery + dynamic registration. */
  clientId?: string;
  /** Redirect URI registered on that app. Empty means Cairn's default. */
  redirectUri?: string;
}

export interface CustomMcpConfig {
  name: string;
  baseUrl: string;
  authMode: "none" | "oauth";
  oauthScope?: string;
  oauthClientId?: string;
  oauthRedirectUri?: string;
}

export type CustomMcpResult = { ok: true; value: CustomMcpConfig } | { ok: false; error: string };

/** Whether a URL is one the phone can use for a redirect: https, or an app scheme (never http, never a script). */
function redirectOk(u: URL): boolean {
  if (u.protocol === "https:") return true;
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["http:", "javascript:", "data:", "file:", "blob:"].includes(u.protocol);
}

/** Validate and normalise the form. Errors are written for the person filling it in. */
export function parseCustomMcp(input: CustomMcpInput): CustomMcpResult {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the connector a name." };

  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    return { ok: false, error: "That isn't a valid server URL." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "The server URL must start with https://." };
  if (url.username || url.password) return { ok: false, error: "Remove the username and password from the URL." };

  const out: CustomMcpConfig = { name, baseUrl: url.toString(), authMode: input.authMode };
  if (input.authMode === "oauth") {
    const scope = input.scope?.trim().replace(/\s+/g, " ");
    if (scope) out.oauthScope = scope;
    const clientId = input.clientId?.trim();
    if (clientId) out.oauthClientId = clientId;
    const redirect = input.redirectUri?.trim();
    if (redirect) {
      if (!clientId) return { ok: false, error: "A redirect URI only applies with your own client ID." };
      try {
        if (!redirectOk(new URL(redirect))) throw new Error("scheme");
      } catch {
        return { ok: false, error: "The redirect URI must be https:// or an app link like cairn://oauth/callback." };
      }
      out.oauthRedirectUri = redirect;
    }
  }
  return { ok: true, value: out };
}

/** A stable, collision-resistant id for a hand-added connector. The `custom-` prefix keeps it clear of registry ids. */
export function customConnectorId(name: string, random: () => number = Math.random): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "server";
  return `custom-${slug}-${Math.floor(random() * 0xffffff).toString(36)}`;
}
