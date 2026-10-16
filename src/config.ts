import { z } from "zod";

import { DELIVERY_PATH } from "./deliveries.js";

const optionalSecret = z.string().min(1).optional();

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATALAYER_SLACK_TRANSPORT: z.enum(["http", "socket"]).default("http"),
    DATALAYER_SLACK_STORE: z.enum(["memory", "postgres"]).default("memory"),
    /**
     * What this process does (plans/SLACK.md §10): `ingress` serves Slack's
     * signed requests and persists them, `worker` works the durable queue
     * and reads the outbox, `all` both (one process: development, tests).
     * Production scales two ingress replicas and the workers apart.
     */
    DATALAYER_SLACK_ROLE: z.enum(["all", "ingress", "worker"]).default("all"),
    DATABASE_URL: optionalSecret,
    SLACK_TOKEN_ENCRYPTION_KEY: optionalSecret,
    SLACK_TOKEN_ENCRYPTION_KEY_VERSION: z.coerce
      .number()
      .int()
      .positive()
      .default(1),
    DATALAYER_API_URL: z.url().default("https://prod1.datalayer.run"),
    DATALAYER_WEB_URL: z.url().default("https://datalayer.ai"),
    DATALAYER_DEFAULT_APP_ID: optionalSecret,
    DATALAYER_DEV_HOST_TOKEN: optionalSecret,
    /**
     * Development only: one host key (`POST /api/ai-agents/v1/apps/hosts/bind`)
     * for a workspace installed without OAuth. Every OAuth installation keeps
     * its own key, bound at install with the Ship card's code.
     */
    DATALAYER_HOST_KEY: optionalSecret,
    /**
     * This service's public HTTPS origin, where Datalayer pushes each
     * installation's deliveries (`/datalayer/deliveries/{host}`); by default
     * the origin of `SLACK_REDIRECT_URI`. Without one, the outbox is read.
     */
    DATALAYER_SLACK_PUBLIC_URL: z.url().optional(),
    /** How often the outbox is read, in seconds; 0 reads it never. */
    DATALAYER_DELIVERY_POLL_SECONDS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(30),
    DATALAYER_DEV_PRINCIPAL_ID: optionalSecret,
    DATALAYER_DEV_SLACK_USER_ID: optionalSecret,
    SLACK_APP_ID: optionalSecret,
    SLACK_SIGNING_SECRET: optionalSecret,
    SLACK_BOT_TOKEN: optionalSecret,
    SLACK_BOT_USER_ID: optionalSecret,
    SLACK_TEAM_ID: optionalSecret,
    SLACK_APP_TOKEN: optionalSecret,
    SLACK_CLIENT_ID: optionalSecret,
    SLACK_CLIENT_SECRET: optionalSecret,
    SLACK_STATE_SECRET: optionalSecret,
    SLACK_REDIRECT_URI: z.url().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === "production" &&
      value.DATALAYER_SLACK_STORE === "memory"
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_SLACK_STORE"],
        message:
          "Production requires a durable installation, binding, and idempotency store.",
      });
    }
    if (value.SLACK_STATE_SECRET && value.SLACK_STATE_SECRET.length < 32) {
      context.addIssue({
        code: "custom",
        path: ["SLACK_STATE_SECRET"],
        message: "SLACK_STATE_SECRET must contain at least 32 characters.",
      });
    }
    if (value.NODE_ENV === "production" && value.DATALAYER_DEV_HOST_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_DEV_HOST_TOKEN"],
        message:
          "A development host token must never be configured in production.",
      });
    }
    if (value.NODE_ENV !== "development" && value.DATALAYER_HOST_KEY) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_HOST_KEY"],
        message:
          "One host key for every workspace is a development shortcut: each installation keeps its own, bound at install.",
      });
    }
    if (
      value.DATALAYER_SLACK_ROLE !== "all" &&
      value.DATALAYER_SLACK_STORE !== "postgres"
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_SLACK_ROLE"],
        message:
          "Ingress and workers apart share a durable queue: they need the PostgreSQL store.",
      });
    }
    if (value.DATALAYER_SLACK_STORE === "postgres" && !value.DATABASE_URL) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "PostgreSQL storage requires DATABASE_URL.",
      });
    }
    if (value.DATALAYER_SLACK_STORE === "postgres" && !value.SLACK_APP_ID) {
      context.addIssue({
        code: "custom",
        path: ["SLACK_APP_ID"],
        message: "PostgreSQL storage requires SLACK_APP_ID.",
      });
    }
    if (
      value.DATALAYER_SLACK_STORE === "postgres" &&
      !value.SLACK_TOKEN_ENCRYPTION_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["SLACK_TOKEN_ENCRYPTION_KEY"],
        message: "PostgreSQL storage requires SLACK_TOKEN_ENCRYPTION_KEY.",
      });
    }
    if (
      value.DATALAYER_SLACK_TRANSPORT === "socket" &&
      !value.SLACK_APP_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        path: ["SLACK_APP_TOKEN"],
        message: "Socket Mode requires SLACK_APP_TOKEN.",
      });
    }
    if (
      value.DATALAYER_SLACK_TRANSPORT === "http" &&
      !value.SLACK_SIGNING_SECRET
    ) {
      context.addIssue({
        code: "custom",
        path: ["SLACK_SIGNING_SECRET"],
        message: "HTTP transport requires SLACK_SIGNING_SECRET.",
      });
    }
    if (
      value.NODE_ENV === "production" &&
      (!value.SLACK_CLIENT_ID ||
        !value.SLACK_CLIENT_SECRET ||
        !value.SLACK_STATE_SECRET ||
        !value.SLACK_REDIRECT_URI ||
        !value.SLACK_APP_ID)
    ) {
      context.addIssue({
        code: "custom",
        path: ["SLACK_CLIENT_ID"],
        message:
          "Production requires Slack app, client, state, and redirect configuration for OAuth distribution.",
      });
    }
  });

export type Config = z.infer<typeof schema>;

/** Where Datalayer pushes an installation's deliveries, when this service has a public origin. */
export function deliveryUrlOf(
  config: Pick<Config, "DATALAYER_SLACK_PUBLIC_URL" | "SLACK_REDIRECT_URI">,
  hostUid: string,
): string | undefined {
  const base = config.DATALAYER_SLACK_PUBLIC_URL ?? config.SLACK_REDIRECT_URI;
  if (!base) return undefined;
  const origin = new URL(base).origin;
  if (!origin.startsWith("https://")) return undefined;
  return `${origin}${DELIVERY_PATH}/${encodeURIComponent(hostUid)}`;
}

export function readConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Config {
  return schema.parse(environment);
}
