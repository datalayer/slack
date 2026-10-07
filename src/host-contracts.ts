import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * The generic Datalayer host contracts (plans/SLACK.md §4.3), as ai-agents
 * answers them. Slack is one host among others: these shapes are shared with
 * ai-agents through `test/contracts/contracts.json`, which both sides test.
 */

export const HOST_KEY_HEADER = "X-Datalayer-Host-Key";
export const SIGNATURE_HEADER = "X-Datalayer-Signature";
export const TIMESTAMP_HEADER = "X-Datalayer-Timestamp";
export const DELIVERY_HEADER = "X-Datalayer-Delivery";
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** The presentation version this adapter renders; another is reviewed in Datalayer. */
export const PRESENTATION_VERSION = 1;

export const bindSchema = z.object({
  host: z.object({ uid: z.string().min(1), state: z.string() }).loose(),
  host_key: z.string().startsWith("dlhk_"),
});

export const linkCodeSchema = z.object({
  code: z.string().startsWith("dlhc_"),
  expires_in: z.number().int().nonnegative(),
  confirm: z.string(),
});

export const exchangeSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().nonnegative(),
  exp: z.number().int(),
  principal_uid: z.string().min(1),
  host_uid: z.string().min(1),
  deployment: z.object({
    uid: z.string().min(1),
    app_uid: z.string(),
    app_name: z.string(),
    version: z.number().int(),
  }),
  session_api: z.object({ url: z.url(), agent: z.string() }),
  user_token: z.string().optional(),
});
export type HostExchange = z.infer<typeof exchangeSchema>;

const fieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  value: z.string(),
});

export const presentationSchema = z.object({
  version: z.number().int(),
  approval_id: z.string().min(1),
  status: z.string(),
  owner_uid: z.string(),
  tool_name: z.string(),
  action_class: z.enum([
    "read",
    "send",
    "write",
    "execute",
    "publish",
    "delete",
    "financial",
    "unknown",
  ]),
  session_uid: z.string(),
  created_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  fields: z.array(fieldSchema),
  arguments: z.record(z.string(), z.unknown()),
  secret_fields: z.array(z.string()),
  complete: z.boolean(),
  host_may_decide: z.boolean(),
  reasons: z.array(z.string()),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApprovalPresentation = z.infer<typeof presentationSchema>;

export const deliverySchema = z.discriminatedUnion("event", [
  z.object({
    delivery: z.string().min(1),
    event: z.literal("approval.requested"),
    payload: z
      .object({
        approval_id: z.string().min(1),
        tool_name: z.string(),
        presentation: z.string(),
        session_uid: z.string(),
        deployment_uid: z.string(),
        target: z.record(z.string(), z.unknown()),
      })
      .loose(),
  }),
  z.object({
    delivery: z.string().min(1),
    event: z.literal("approval.decided"),
    payload: z
      .object({
        approval_id: z.string().min(1),
        status: z.string(),
        decided_by: z.string(),
        session_uid: z.string(),
        deployment_uid: z.string(),
        target: z.record(z.string(), z.unknown()),
      })
      .loose(),
  }),
  z.object({
    delivery: z.string().min(1),
    event: z.literal("turn.completed"),
    payload: z
      .object({
        record_entry: z.string(),
        session_uid: z.string(),
        deployment_uid: z.string(),
        target: z.record(z.string(), z.unknown()),
      })
      .loose(),
  }),
]);
export type HostDelivery = z.infer<typeof deliverySchema>;

/**
 * Whether Slack may offer Approve and Reject: only what the server says a
 * host may decide, in a version this adapter renders, shown whole. Anything
 * else gets *Review in Datalayer* (§2 rule 6).
 */
export function slackMayDecide(presentation: ApprovalPresentation): boolean {
  return (
    presentation.version === PRESENTATION_VERSION &&
    presentation.host_may_decide &&
    presentation.complete &&
    presentation.secret_fields.length === 0 &&
    presentation.status === "pending"
  );
}

/** `v1=` HMAC-SHA256 of `"<timestamp>.<raw body>"`, as ai-agents signs a push. */
export function deliverySignature(
  secret: string,
  timestamp: number,
  rawBody: string | Buffer,
): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.`);
  mac.update(rawBody);
  return `v1=${mac.digest("hex")}`;
}

/**
 * Verify a pushed delivery before trusting it: its signature in constant
 * time, and a timestamp within five minutes, so a captured push cannot be
 * replayed later.
 */
export function verifyDelivery(input: {
  nowSeconds?: number;
  rawBody: string | Buffer;
  secret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  toleranceSeconds?: number;
}): HostDelivery {
  const stamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(stamp) ||
    Math.abs(now - stamp) > (input.toleranceSeconds ?? 300)
  ) {
    throw new Error("The delivery's timestamp is missing or too old.");
  }
  const expected = Buffer.from(
    deliverySignature(input.secret, stamp, input.rawBody),
  );
  const given = Buffer.from(input.signature ?? "");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new Error("The delivery's signature does not match.");
  }
  return deliverySchema.parse(JSON.parse(input.rawBody.toString()));
}
