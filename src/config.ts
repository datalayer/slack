import { z } from "zod";

const optionalSecret = z.string().min(1).optional();

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATALAYER_SLACK_TRANSPORT: z.enum(["http", "socket"]).default("http"),
    DATALAYER_SLACK_STORE: z.enum(["memory"]).default("memory"),
    DATALAYER_API_URL: z.url().default("https://prod1.datalayer.run"),
    DATALAYER_WEB_URL: z.url().default("https://datalayer.ai"),
    DATALAYER_DEFAULT_APP_ID: optionalSecret,
    DATALAYER_DEV_HOST_TOKEN: optionalSecret,
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
    if (value.NODE_ENV === "production" && value.DATALAYER_DEV_HOST_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["DATALAYER_DEV_HOST_TOKEN"],
        message:
          "A development host token must never be configured in production.",
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
  });

export type Config = z.infer<typeof schema>;

export function readConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Config {
  return schema.parse(environment);
}
