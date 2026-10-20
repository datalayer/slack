import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { z } from "zod";

/**
 * The Slack app manifests as code (S-006, S-107).
 *
 * `app-manifest.template.yaml` is rendered once per environment into
 * `manifests/<name>.yaml`. A rendered manifest is parsed as YAML and held to
 * the schema of the manifest fields this service uses, with every object
 * strict, so a key that moves out of its parent fails. The drift check
 * compares the committed bytes with the rendered ones.
 */

export interface Environment {
  baseUrl: string;
  socket: boolean;
  suffix: string;
  tokenRotation: boolean;
}

export const ENVIRONMENTS = {
  development: {
    baseUrl: "https://slack-dev.datalayer.run",
    socket: true,
    suffix: " Dev",
    tokenRotation: false,
  },
  staging: {
    baseUrl: "https://slack-staging.datalayer.run",
    socket: false,
    suffix: " Staging",
    tokenRotation: true,
  },
  production: {
    baseUrl: "https://slack.datalayer.run",
    socket: false,
    suffix: "",
    tokenRotation: true,
  },
} as const satisfies Record<string, Environment>;

export type EnvironmentName = keyof typeof ENVIRONMENTS;

export const ENVIRONMENT_NAMES = Object.keys(ENVIRONMENTS) as EnvironmentName[];

/**
 * The bot scopes, in order: the same list `src/bolt.ts` asks OAuth for. The
 * baseline, `assistant:write` (S-104) and `users:read` (S-209), both decided
 * by the user 16 October 2026.
 */
export const MANIFEST_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "chat:write",
  "im:history",
  "users:read",
] as const;

/** The events the service handles, in order. */
export const MANIFEST_BOT_EVENTS = [
  // Slack's native Stop on a streamed answer (S-206): without it Slack says
  // "Stop is not available for this agent".
  "agent_session_stopped",
  "app_home_opened",
  "app_mention",
  "app_uninstalled",
  "assistant_thread_started",
  "message.im",
  "tokens_revoked",
] as const;

const https = z.url({ protocol: /^https$/ });

/** The manifest fields this service uses; every object is strict. */
export const manifestSchema = z.strictObject({
  _metadata: z.strictObject({ major_version: z.literal(2) }),
  display_information: z.strictObject({
    name: z.string().min(1).max(35),
    description: z.string().min(1).max(140),
    background_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  features: z.strictObject({
    app_home: z.strictObject({
      home_tab_enabled: z.boolean(),
      messages_tab_enabled: z.boolean(),
      messages_tab_read_only_enabled: z.boolean(),
    }),
    assistant_view: z.strictObject({
      assistant_description: z.string().min(1).max(200),
    }),
    bot_user: z.strictObject({
      display_name: z.string().min(1).max(80),
      always_online: z.boolean(),
    }),
  }),
  oauth_config: z.strictObject({
    redirect_urls: z.array(https).min(1),
    scopes: z.strictObject({ bot: z.array(z.string()).min(1) }),
  }),
  settings: z.strictObject({
    event_subscriptions: z.strictObject({
      request_url: https,
      bot_events: z.array(z.string()).min(1),
    }),
    interactivity: z.strictObject({
      is_enabled: z.boolean(),
      request_url: https,
    }),
    org_deploy_enabled: z.boolean(),
    socket_mode_enabled: z.boolean(),
    token_rotation_enabled: z.boolean(),
  }),
});

export type Manifest = z.infer<typeof manifestSchema>;

export function render(template: string, values: Environment): string {
  const output = template
    .replaceAll("{{BASE_URL}}", values.baseUrl)
    .replaceAll("{{DISPLAY_SUFFIX}}", values.suffix)
    .replaceAll("{{SOCKET_MODE}}", String(values.socket))
    .replaceAll("{{TOKEN_ROTATION}}", String(values.tokenRotation));
  const left = /{{[^}]+}}/.exec(output);
  if (left) throw new Error(`Unresolved placeholder ${left[0]}.`);
  return output;
}

function same(actual: readonly string[], expected: readonly string[]) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

/**
 * Parses a manifest and holds it to the schema and to what the environment
 * must request. Throws with every problem found.
 */
export function validate(text: string, name: EnvironmentName): Manifest {
  const values: Environment = ENVIRONMENTS[name];
  const parsed: unknown = parse(text, { uniqueKeys: true, strict: true });
  const result = manifestSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `${name} manifest is not valid: ${z.prettifyError(result.error)}`,
    );
  const manifest = result.data;
  const problems: string[] = [];
  if (!same(manifest.oauth_config.scopes.bot, MANIFEST_BOT_SCOPES))
    problems.push(
      `bot scopes are ${manifest.oauth_config.scopes.bot.join(", ")}, not ${MANIFEST_BOT_SCOPES.join(", ")}`,
    );
  if (
    !same(manifest.settings.event_subscriptions.bot_events, MANIFEST_BOT_EVENTS)
  )
    problems.push(
      `bot events are ${manifest.settings.event_subscriptions.bot_events.join(", ")}, not ${MANIFEST_BOT_EVENTS.join(", ")}`,
    );
  if (manifest.settings.socket_mode_enabled !== values.socket)
    problems.push(`socket_mode_enabled must be ${values.socket}`);
  if (manifest.settings.token_rotation_enabled !== values.tokenRotation)
    problems.push(`token_rotation_enabled must be ${values.tokenRotation}`);
  if (manifest.settings.org_deploy_enabled)
    problems.push("org_deploy_enabled must be false");
  if (!manifest.settings.interactivity.is_enabled)
    problems.push("interactivity must be enabled");
  const events = `${values.baseUrl}/slack/events`;
  if (manifest.settings.event_subscriptions.request_url !== events)
    problems.push(`the events request_url must be ${events}`);
  if (manifest.settings.interactivity.request_url !== events)
    problems.push(`the interactivity request_url must be ${events}`);
  const callback = `${values.baseUrl}/slack/oauth/callback`;
  if (!same(manifest.oauth_config.redirect_urls, [callback]))
    problems.push(`redirect_urls must be exactly ${callback}`);
  const display = `Datalayer${values.suffix}`;
  if (manifest.display_information.name !== display)
    problems.push(`display name must be ${display}`);
  if (manifest.features.bot_user.display_name !== display)
    problems.push(`bot display name must be ${display}`);
  if (problems.length)
    throw new Error(`${name} manifest: ${problems.join("; ")}.`);
  return manifest;
}

/** Renders and validates every environment's manifest from the template. */
export async function renderAll(
  root: URL,
): Promise<Record<EnvironmentName, string>> {
  const template = await readFile(
    new URL("app-manifest.template.yaml", root),
    "utf8",
  );
  const rendered = {} as Record<EnvironmentName, string>;
  for (const name of ENVIRONMENT_NAMES) {
    const output = render(template, ENVIRONMENTS[name]);
    validate(output, name);
    rendered[name] = output;
  }
  return rendered;
}

/**
 * The drift check: each committed manifest must be byte for byte what the
 * template renders (the manifests are excluded from prettier), and valid on
 * its own. Returns the problems found.
 */
export async function drift(root: URL): Promise<string[]> {
  const rendered = await renderAll(root);
  const problems: string[] = [];
  for (const name of ENVIRONMENT_NAMES) {
    const path = `manifests/${name}.yaml`;
    const committed = await readFile(new URL(path, root), "utf8");
    if (committed !== rendered[name])
      problems.push(
        `${path} differs from the template: run npm run manifest:render.`,
      );
    try {
      validate(committed, name);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  return problems;
}
