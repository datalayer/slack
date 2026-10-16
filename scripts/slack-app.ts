import { spawn } from "node:child_process";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import { ENVIRONMENT_NAMES, type EnvironmentName, validate } from "./manifest.js";

/**
 * Creates or updates a Slack app from manifests/<env>.yaml through Slack's App
 * Manifest API (plans/SLACK.md §15.2; the user, 16 October 2026: the chart
 * creates the Secret, then "a script to update the slack app").
 *
 * The configuration token and its refresh token come from the rc
 * (DATALAYER_SLACK_CONFIG_TOKEN, DATALAYER_SLACK_CONFIG_REFRESH_TOKEN): the
 * access token lives 12 hours and every rotation spends the refresh token, so
 * each run rotates first and writes both back. On create, Slack answers the
 * app's credentials once: the ids and the secrets go to the rc as
 * DATALAYER_SLACK_<ENV>_*. With --k8s-secret, the app the service on r1
 * runs as (just created, or saved in the rc earlier) is deployed: its signing
 * and client secrets go to the Secret the chart created, and its two
 * non-secret ids to the r1 rc as SLACK_APP_ID and SLACK_CLIENT_ID, which
 * up.sh's datalayer_slack passes to the chart. Nothing secret is printed.
 */

export const SLACK_API = "https://slack.com/api";
export const RC_DEFAULT = `${homedir()}/.datalayer/datalayerrc-prod1`;
/** The rc `p reup datalayer-slack` runs under (r1). */
export const DEPLOY_RC_DEFAULT = `${homedir()}/.datalayer/datalayerrc-r1`;

export type Fetch = typeof fetch;

export type Credentials = {
  client_id: string;
  client_secret: string;
  signing_secret: string;
  verification_token?: string;
};

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly error: string,
    readonly detail?: unknown,
  ) {
    super(`${method}: ${error}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
  }
}

/** One Slack Web API call, form-encoded; fails on ok: false. */
export async function call(
  fetchImpl: Fetch,
  method: string,
  params: Record<string, string>,
  token?: string,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw new SlackApiError(method, `http_${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (body.ok !== true)
    throw new SlackApiError(method, String(body.error ?? "unknown"), body.errors);
  return body;
}

/** tooling.tokens.rotate: a new access token and a new refresh token. */
export async function rotate(
  fetchImpl: Fetch,
  refreshToken: string,
): Promise<{ token: string; refreshToken: string }> {
  const body = await call(fetchImpl, "tooling.tokens.rotate", {
    refresh_token: refreshToken,
  });
  const token = body.token;
  const refresh = body.refresh_token;
  if (typeof token !== "string" || typeof refresh !== "string")
    throw new SlackApiError("tooling.tokens.rotate", "no_token_in_answer");
  return { token, refreshToken: refresh };
}

/**
 * The rc with each `export NAME=value` set: a line replaced in place, or
 * appended. Values are single-quoted so the shell reads them verbatim.
 */
export function withExports(text: string, entries: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(entries)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`not an rc name: ${name}`);
    if (value.includes("'")) throw new Error(`${name}: a quote in the value`);
    const line = `export ${name}='${value}'`;
    const pattern = new RegExp(`^\\s*export ${name}=.*$`, "m");
    out = pattern.test(out)
      ? out.replace(pattern, line)
      : `${out.replace(/\n*$/, "\n")}${line}\n`;
  }
  return out;
}

/** The value an rc exports for name, or undefined. */
export function exportOf(text: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*export ${name}=(.*)$`, "m").exec(text);
  if (!match) return undefined;
  return match[1].trim().replace(/^'(.*)'$/s, "$1").replace(/^"(.*)"$/s, "$1");
}

export function envKey(env: EnvironmentName): string {
  return `DATALAYER_SLACK_${env.toUpperCase()}`;
}

/** The rc entries a created app leaves: its ids and its secrets. */
export function createdEntries(
  env: EnvironmentName,
  appId: string,
  credentials: Credentials,
): Record<string, string> {
  const key = envKey(env);
  return {
    [`${key}_APP_ID`]: appId,
    [`${key}_CLIENT_ID`]: credentials.client_id,
    [`${key}_CLIENT_SECRET`]: credentials.client_secret,
    [`${key}_SIGNING_SECRET`]: credentials.signing_secret,
  };
}

/**
 * What deploying an app to the chart writes: its secrets for the Secret and
 * its ids for the r1 rc. From the create answer, else from what the rc saved
 * when the app was created; fails naming what is missing.
 */
export function deployEntries(
  env: EnvironmentName,
  rc: string,
  appId: string,
  credentials?: Credentials,
): { secret: Record<string, string>; ids: Record<string, string> } {
  const key = envKey(env);
  const clientId = credentials?.client_id ?? exportOf(rc, `${key}_CLIENT_ID`);
  const clientSecret = credentials?.client_secret ?? exportOf(rc, `${key}_CLIENT_SECRET`);
  const signingSecret = credentials?.signing_secret ?? exportOf(rc, `${key}_SIGNING_SECRET`);
  const missing = [
    ["CLIENT_ID", clientId],
    ["CLIENT_SECRET", clientSecret],
    ["SIGNING_SECRET", signingSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => `${key}_${name}`);
  if (missing.length || !clientId || !clientSecret || !signingSecret)
    throw new Error(`${missing.join(", ")} not in the rc: Slack answers them only when it creates the app.`);
  return {
    secret: { SLACK_SIGNING_SECRET: signingSecret, SLACK_CLIENT_SECRET: clientSecret },
    ids: { SLACK_APP_ID: appId, SLACK_CLIENT_ID: clientId },
  };
}

export type Outcome = {
  env: EnvironmentName;
  appId: string;
  action: "created" | "updated";
  authorizeUrl?: string;
  credentials?: Credentials;
};

/** Validate, then create the app or update the one the rc names. */
export async function apply(
  fetchImpl: Fetch,
  token: string,
  env: EnvironmentName,
  manifestText: string,
  existingAppId: string | undefined,
): Promise<Outcome> {
  const manifest = JSON.stringify(validate(manifestText, env));
  await call(fetchImpl, "apps.manifest.validate", { manifest }, token);
  if (existingAppId) {
    await call(fetchImpl, "apps.manifest.update", { app_id: existingAppId, manifest }, token);
    return { env, appId: existingAppId, action: "updated" };
  }
  const body = await call(fetchImpl, "apps.manifest.create", { manifest }, token);
  const credentials = body.credentials as Credentials | undefined;
  if (typeof body.app_id !== "string" || !credentials?.client_secret || !credentials.signing_secret)
    throw new SlackApiError("apps.manifest.create", "no_credentials_in_answer");
  return {
    env,
    appId: body.app_id,
    action: "created",
    authorizeUrl: typeof body.oauth_authorize_url === "string" ? body.oauth_authorize_url : undefined,
    credentials,
  };
}

/** Writes the rc in place, keeping its mode (owner-only when it was). */
async function writeRc(path: string, text: string): Promise<void> {
  const { mode } = await stat(path);
  await writeFile(path, text);
  await chmod(path, mode & 0o777);
}

/** kubectl patch of the Secret, the values read from stdin, never argv. */
export function patchSecret(
  namespace: string,
  name: string,
  values: Record<string, string>,
  spawnImpl: typeof spawn = spawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      "kubectl",
      ["patch", "secret", name, "-n", namespace, "--type", "merge", "--patch-file", "/dev/stdin"],
      { stdio: ["pipe", "ignore", "inherit"] },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`kubectl patch secret ${name}: exit ${code}`)),
    );
    child.stdin?.end(JSON.stringify({ stringData: values }));
  });
}

async function main(argv: string[]): Promise<void> {
  const env = argv.find((one) => !one.startsWith("--")) as EnvironmentName | undefined;
  if (!env || !ENVIRONMENT_NAMES.includes(env))
    throw new Error(`usage: slack-app <${ENVIRONMENT_NAMES.join("|")}> [--k8s-secret namespace/name]`);
  const k8sIndex = argv.indexOf("--k8s-secret");
  const k8sTarget = k8sIndex >= 0 ? argv[k8sIndex + 1] : undefined;
  if (k8sIndex >= 0 && !k8sTarget?.includes("/"))
    throw new Error("--k8s-secret takes namespace/name, e.g. datalayer-api/datalayer-slack-env");
  const rcPath = process.env.DATALAYER_SLACK_RC ?? RC_DEFAULT;
  const deployRcPath = process.env.DATALAYER_SLACK_DEPLOY_RC ?? DEPLOY_RC_DEFAULT;

  let rc = await readFile(rcPath, "utf8");
  const refresh = exportOf(rc, "DATALAYER_SLACK_CONFIG_REFRESH_TOKEN");
  if (!refresh)
    throw new Error(`DATALAYER_SLACK_CONFIG_REFRESH_TOKEN is not in ${rcPath}: generate a configuration token at api.slack.com/apps.`);
  const rotated = await rotate(fetch, refresh);
  rc = withExports(rc, {
    DATALAYER_SLACK_CONFIG_TOKEN: rotated.token,
    DATALAYER_SLACK_CONFIG_REFRESH_TOKEN: rotated.refreshToken,
  });
  await writeRc(rcPath, rc);
  console.log("Configuration token rotated; both tokens saved to the rc.");

  const manifestText = await readFile(new URL(`../manifests/${env}.yaml`, import.meta.url), "utf8");
  const existing = exportOf(rc, `${envKey(env)}_APP_ID`);
  const outcome = await apply(fetch, rotated.token, env, manifestText, existing);
  if (outcome.action === "created" && outcome.credentials) {
    rc = withExports(rc, createdEntries(env, outcome.appId, outcome.credentials));
    await writeRc(rcPath, rc);
    console.log(`Created ${env} app ${outcome.appId}; ids and secrets saved to the rc as ${envKey(env)}_*.`);
    if (outcome.authorizeUrl) console.log(`Install: ${outcome.authorizeUrl}`);
  } else {
    console.log(`Updated ${env} app ${outcome.appId} from manifests/${env}.yaml.`);
  }
  if (k8sTarget) {
    const deploy = deployEntries(env, rc, outcome.appId, outcome.credentials);
    const [namespace, name] = k8sTarget.split("/");
    await patchSecret(namespace, name, deploy.secret);
    console.log(`Signing and client secrets written to the Secret ${k8sTarget}.`);
    await writeRc(deployRcPath, withExports(await readFile(deployRcPath, "utf8"), deploy.ids));
    console.log(`SLACK_APP_ID and SLACK_CLIENT_ID of ${outcome.appId} saved to ${deployRcPath}.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
