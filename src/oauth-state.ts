import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Installation, InstallURLOptions, StateStore } from "@slack/bolt";

/** The query parameter the Ship tab's Slack card passes: the installation's one-use bind code. */
export const BIND_PARAMETER = "datalayer_bind";

/** The cookie Slack's OAuth library checks the state against (its default name). */
export const STATE_COOKIE = "slack-app-oauth-state";

export const STATE_SECONDS = 600;

/** A bind code as ai-agents answers it: `dlhc_` and URL-safe base64. */
const BIND_CODE = /^dlhc_[A-Za-z0-9_-]{16,128}$/;

const encode = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string): string =>
  Buffer.from(value, "base64url").toString("utf8");

/**
 * Slack OAuth `state`, signed (HMAC-SHA256 with `SLACK_STATE_SECRET`),
 * expiring after ten minutes and spent once (§9: single-use OAuth state).
 * It carries the install options — among them the Datalayer bind code as
 * `metadata`, which Slack's library hands back on the installation at the
 * callback, before the installation is stored.
 */
export class SignedStateStore implements StateStore {
  constructor(
    readonly secret: string,
    /** Claims a state's nonce once; `false` when it was already spent. */
    readonly spend: (nonce: string) => Promise<boolean>,
    readonly seconds = STATE_SECONDS,
  ) {}

  #sign(payload: string): string {
    return createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
  }

  async generateStateParam(
    installOptions: InstallURLOptions,
    now: Date,
  ): Promise<string> {
    const payload = encode(
      JSON.stringify({
        installOptions,
        nonce: randomBytes(16).toString("base64url"),
        now: now.getTime(),
      }),
    );
    return `${payload}.${this.#sign(payload)}`;
  }

  async verifyStateParam(now: Date, state: string): Promise<InstallURLOptions> {
    const [payload, signature, extra] = state.split(".");
    if (!payload || !signature || extra !== undefined)
      throw new Error("The OAuth state is malformed.");
    const expected = Buffer.from(this.#sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new Error("The OAuth state's signature does not match.");
    const decoded = JSON.parse(decode(payload)) as {
      installOptions: InstallURLOptions;
      nonce: string;
      now: number;
    };
    if (now.getTime() - decoded.now > this.seconds * 1000)
      throw new Error("The OAuth state expired: install again.");
    if (!(await this.spend(`oauth-state:${decoded.nonce}`)))
      throw new Error("The OAuth state was already used: install again.");
    return decoded.installOptions;
  }
}

/** The bind code of an install request, when it carries a well-formed one. */
export function bindCodeOf(url: string | undefined): string | undefined {
  const code = new URL(url ?? "/", "http://install.local").searchParams.get(
    BIND_PARAMETER,
  );
  return code && BIND_CODE.test(code) ? code : undefined;
}

/** The bind code Slack handed back on the installation, from the state's metadata. */
export function bindCodeOfInstallation(
  installation: Pick<Installation, "metadata">,
): string | undefined {
  if (!installation.metadata) return undefined;
  try {
    const parsed = JSON.parse(installation.metadata) as Record<string, unknown>;
    const code = parsed[BIND_PARAMETER];
    return typeof code === "string" && BIND_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Slack's authorize address for these options and this state. */
export function authorizeUrlOf(
  clientId: string,
  options: InstallURLOptions,
  state: string,
): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  const scopes = options.scopes;
  url.searchParams.set(
    "scope",
    Array.isArray(scopes) ? scopes.join(",") : scopes,
  );
  url.searchParams.set("state", state);
  url.searchParams.set("client_id", clientId);
  if (options.redirectUri)
    url.searchParams.set("redirect_uri", options.redirectUri);
  return url.toString();
}

export type BoundInstallOptions = Readonly<{
  clientId: string;
  /** Whether an install without a bind code is refused (outside development). */
  requireBind: boolean;
  redirectUri?: string;
  scopes: string[];
  stateStore: SignedStateStore;
  webUrl: string;
}>;

/**
 * The install page (`GET /slack/install`), as Bolt's `beforeRedirection`:
 * an install carrying the Ship card's `datalayer_bind` is redirected to
 * Slack with its own state — the code in its metadata, never in a shared
 * option another request could read. Without a code, development continues
 * with Bolt's plain install; anywhere else the page says where to start.
 * Answers whether Bolt should go on with its own redirection.
 */
export async function startBoundInstall(
  request: IncomingMessage,
  response: ServerResponse,
  options: BoundInstallOptions,
): Promise<boolean> {
  const code = bindCodeOf(request.url);
  if (!code) {
    if (!options.requireBind) return true;
    response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    response.end(
      page(
        "Install @Datalayer from Datalayer",
        `Open your application's Ship tab in Datalayer and choose <b>Install @Datalayer</b> on its Slack card: it brings you back here with a one-use code. <a href="${escapeHtml(options.webUrl)}/docs/slack">Read the guide</a>.`,
      ),
    );
    return false;
  }
  const installOptions: InstallURLOptions = {
    metadata: JSON.stringify({ [BIND_PARAMETER]: code }),
    redirectUri: options.redirectUri,
    scopes: options.scopes,
  };
  const state = await options.stateStore.generateStateParam(
    installOptions,
    new Date(),
  );
  response.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}; Secure; HttpOnly; Path=/; Max-Age=${STATE_SECONDS}`,
  );
  response.setHeader(
    "Location",
    authorizeUrlOf(options.clientId, installOptions, state),
  );
  response.writeHead(302);
  response.end("");
  return false;
}

/** A short page in the service's own words: OAuth success and failure. */
export function page(title: string, html: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1f2328}h1{font-size:1.5rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>${html}</p></body></html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
