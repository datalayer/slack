import { DELIVERY_PATH } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { z } from "zod";

const optionalSecret = z.string().min(1).optional();

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATALAYER_SLACK_TRANSPORT: z.enum(["http", "socket"]).default("http"),
    DATALAYER_SLACK_STORE: z.enum(["memory", "solr"]).default("memory"),
    /**
     * What this process does: `ingress` serves Slack's
     * signed requests and persists them, `worker` works the durable queue
     * and reads the outbox, `all` both (one process: development, tests).
     * Production scales two ingress replicas and the workers apart.
     */
    DATALAYER_SLACK_ROLE: z.enum(["all", "ingress", "worker"]).default("all"),
    /**
     * The service's Solr collection (`slack`), on the cluster's SolrCloud:
     * its base URL (`.../solr`) and the platform's Solr user.
     */
    DATALAYER_SOLR_URL: z
      .url()
      .refine((url) => url.replace(/\/+$/, "").endsWith("/solr"), {
        message: "DATALAYER_SOLR_URL is Solr's base URL, ending in /solr.",
      })
      .optional(),
    DATALAYER_SOLR_USERNAME: optionalSecret,
    DATALAYER_SOLR_PASSWORD: optionalSecret,
    DATALAYER_SLACK_SOLR_COLLECTION: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .default("slack"),
    DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY: optionalSecret,
    DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY_VERSION: z.coerce
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
     * the origin of `DATALAYER_SLACK_REDIRECT_URI`. Without one, the outbox is read.
     */
    DATALAYER_SLACK_PUBLIC_URL: z.url().optional(),
    /** How often the outbox is read, in seconds; 0 reads it never. */
    DATALAYER_DELIVERY_POLL_SECONDS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(30),
    /** Questions an hour (S-404): per person, workspace, organization, application. */
    DATALAYER_SLACK_QUOTA_USER: z.coerce.number().int().positive().default(60),
    DATALAYER_SLACK_QUOTA_WORKSPACE: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    DATALAYER_SLACK_QUOTA_ORGANIZATION: z.coerce
      .number()
      .int()
      .positive()
      .default(2_000),
    DATALAYER_SLACK_QUOTA_APPLICATION: z.coerce
      .number()
      .int()
      .positive()
      .default(600),
    /**
     * Stream answers with chat.startStream when available (S-206): on, a
     * workspace whose plan or settings refuse streaming gets the bounded
     * placeholder instead (`TurnRenderer.begin`); off, never streamed.
     */
    DATALAYER_SLACK_STREAMING: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /**
     * Optional thread context (S-401, ADR 0003): off unless turned on here,
     * and then only where an administrator chose it and the optional
     * manifest's history scope was granted (`src/thread-context.ts`).
     */
    DATALAYER_SLACK_THREAD_CONTEXT: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /** quiet: one status line while a turn works; noisy: every tool it used, listed (S-308). */
    DATALAYER_SLACK_EVENTS: z.enum(["quiet", "noisy"]).default("quiet"),
    /**
     * Where spans are exported (S-101): the plane's OTEL collector, OTLP/HTTP
     * JSON (`…/v1/traces`), with the platform's OTEL key as a Bearer. Without
     * both, spans are log lines only.
     */
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.url().optional(),
    DATALAYER_OTEL_API_KEY: optionalSecret,
    DATALAYER_DEV_PRINCIPAL_ID: optionalSecret,
    DATALAYER_DEV_SLACK_USER_ID: optionalSecret,
    DATALAYER_SLACK_APP_ID: optionalSecret,
    DATALAYER_SLACK_SIGNING_SECRET: optionalSecret,
    DATALAYER_SLACK_BOT_TOKEN: optionalSecret,
    DATALAYER_SLACK_BOT_USER_ID: optionalSecret,
    DATALAYER_SLACK_TEAM_ID: optionalSecret,
    DATALAYER_SLACK_APP_TOKEN: optionalSecret,
    DATALAYER_SLACK_CLIENT_ID: optionalSecret,
    DATALAYER_SLACK_CLIENT_SECRET: optionalSecret,
    DATALAYER_SLACK_STATE_SECRET: optionalSecret,
    DATALAYER_SLACK_REDIRECT_URI: z.url().optional(),
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
    if (
      value.DATALAYER_SLACK_STATE_SECRET &&
      value.DATALAYER_SLACK_STATE_SECRET.length < 32
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_SLACK_STATE_SECRET"],
        message:
          "DATALAYER_SLACK_STATE_SECRET must contain at least 32 characters.",
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
      value.DATALAYER_SLACK_STORE !== "solr"
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_SLACK_ROLE"],
        message:
          "Ingress and workers apart share a durable queue: they need the Solr store.",
      });
    }
    for (const name of [
      "DATALAYER_SOLR_URL",
      "DATALAYER_SOLR_USERNAME",
      "DATALAYER_SOLR_PASSWORD",
    ] as const)
      if (value.DATALAYER_SLACK_STORE === "solr" && !value[name])
        context.addIssue({
          code: "custom",
          path: [name],
          message: `Solr storage requires ${name}.`,
        });
    if (
      value.DATALAYER_SLACK_STORE === "solr" &&
      !value.DATALAYER_SLACK_APP_ID
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_SLACK_APP_ID"],
        message: "Solr storage requires DATALAYER_SLACK_APP_ID.",
      });
    }
    if (
      value.DATALAYER_SLACK_STORE === "solr" &&
      !value.DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY"],
        message: "Solr storage requires DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY.",
      });
    }
    if (
      value.DATALAYER_SLACK_TRANSPORT === "socket" &&
      !value.DATALAYER_SLACK_APP_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_SLACK_APP_TOKEN"],
        message: "Socket Mode requires DATALAYER_SLACK_APP_TOKEN.",
      });
    }
    if (
      value.DATALAYER_SLACK_TRANSPORT === "http" &&
      !value.DATALAYER_SLACK_SIGNING_SECRET
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_SLACK_SIGNING_SECRET"],
        message: "HTTP transport requires DATALAYER_SLACK_SIGNING_SECRET.",
      });
    }
    if (
      value.NODE_ENV === "production" &&
      (!value.DATALAYER_SLACK_CLIENT_ID ||
        !value.DATALAYER_SLACK_CLIENT_SECRET ||
        !value.DATALAYER_SLACK_STATE_SECRET ||
        !value.DATALAYER_SLACK_REDIRECT_URI ||
        !value.DATALAYER_SLACK_APP_ID)
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_SLACK_CLIENT_ID"],
        message:
          "Production requires Slack app, client, state, and redirect configuration for OAuth distribution.",
      });
    }
  });

export type Config = z.infer<typeof schema>;

/** Where Datalayer pushes an installation's deliveries, when this service has a public origin. */
export function deliveryUrlOf(
  config: Pick<
    Config,
    "DATALAYER_SLACK_PUBLIC_URL" | "DATALAYER_SLACK_REDIRECT_URI"
  >,
  hostUid: string,
): string | undefined {
  const base =
    config.DATALAYER_SLACK_PUBLIC_URL ?? config.DATALAYER_SLACK_REDIRECT_URI;
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
