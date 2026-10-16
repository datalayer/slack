import type { IncomingPrompt } from "./domain.js";
import { slackThreadKey } from "./service.js";

/**
 * What one signed Slack Events API envelope means (S-201, S-209),
 * decided without any network call so the listener only
 * persists and acknowledges. The installation comes from the signed body's
 * `api_app_id`, `enterprise_id` and `team_id` — never a query parameter.
 */
export type EventEnvelope = Readonly<{
  api_app_id?: string;
  authorizations?: ReadonlyArray<{ user_id?: string; is_bot?: boolean }>;
  enterprise_id?: string | null;
  event?: Readonly<Record<string, unknown>>;
  event_id?: string;
  is_ext_shared_channel?: boolean;
  team_id?: string | null;
  type?: string;
}>;

export type Ingress =
  | Readonly<{ kind: "prompt"; prompt: IncomingPrompt; botUserId?: string }>
  | Readonly<{
      kind: "edited";
      prompt: IncomingPrompt;
      /** The original message's ts: the one already sent as a turn. */
      originalTs: string;
    }>
  | Readonly<{
      kind: "deleted";
      prompt: Omit<IncomingPrompt, "text" | "userId"> & { userId?: string };
      deletedTs: string;
    }>
  | Readonly<{ kind: "ignore"; reason: IgnoreReason }>;

export type IgnoreReason =
  | "not-an-event"
  | "unsigned-installation"
  | "bot"
  | "self"
  | "unsupported-subtype"
  | "not-direct"
  | "empty"
  | "unsupported-event";

/** Message subtypes that are a person's words: anything else is not a prompt. */
const PROMPT_SUBTYPES = new Set([
  undefined,
  "",
  "thread_broadcast",
  "file_share",
]);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** The app's own bot user, as Slack's authorizations name it. */
export function botUserOf(envelope: EventEnvelope): string | undefined {
  return envelope.authorizations?.find((one) => one.is_bot)?.user_id;
}

export function ingressOf(
  envelope: EventEnvelope,
  configuredBotUserId?: string,
): Ingress {
  const event = envelope.event;
  if (envelope.type !== "event_callback" || !event || !envelope.event_id)
    return { kind: "ignore", reason: "not-an-event" };
  const appId = str(envelope.api_app_id);
  const teamId = str(envelope.team_id);
  if (!appId || !teamId)
    return { kind: "ignore", reason: "unsigned-installation" };
  const botUserId = configuredBotUserId ?? botUserOf(envelope);
  const type = str(event.type);
  const subtype = str(event.subtype);
  const channel = str(event.channel);
  const base = {
    appId,
    enterpriseId: str(envelope.enterprise_id) ?? undefined,
    teamId,
  };

  if (event.bot_id || event.bot_profile || subtype === "bot_message")
    return { kind: "ignore", reason: "bot" };
  if (botUserId && event.user === botUserId)
    return { kind: "ignore", reason: "self" };

  if (type === "message" && event.channel_type === "im" && channel) {
    if (subtype === "message_changed") {
      const changed = (event.message ?? {}) as Record<string, unknown>;
      const previous = (event.previous_message ?? {}) as Record<
        string,
        unknown
      >;
      const user = str(changed.user);
      const text = str(changed.text);
      const ts = str(changed.ts);
      if (changed.bot_id || (botUserId && user === botUserId))
        return { kind: "ignore", reason: "bot" };
      if (!user || !text || !ts) return { kind: "ignore", reason: "empty" };
      if (str(previous.text) === text)
        return { kind: "ignore", reason: "unsupported-subtype" }; // an unfurl, not an edit
      return {
        kind: "edited",
        originalTs: ts,
        prompt: {
          ...slackThreadKey({
            ...base,
            channel,
            threadTs: str(changed.thread_ts),
            ts,
          }),
          eventId: envelope.event_id,
          text,
          userId: user,
          userTeamId: str(changed.user_team),
        },
      };
    }
    if (subtype === "message_deleted") {
      const previous = (event.previous_message ?? {}) as Record<
        string,
        unknown
      >;
      const ts = str(event.deleted_ts) ?? str(previous.ts);
      if (!ts) return { kind: "ignore", reason: "empty" };
      return {
        kind: "deleted",
        deletedTs: ts,
        prompt: {
          ...slackThreadKey({
            ...base,
            channel,
            threadTs: str(previous.thread_ts),
            ts,
          }),
          eventId: envelope.event_id,
          userId: str(previous.user),
        },
      };
    }
    if (!PROMPT_SUBTYPES.has(subtype))
      return { kind: "ignore", reason: "unsupported-subtype" };
    const user = str(event.user);
    const text = str(event.text);
    const ts = str(event.ts);
    if (!user || !text || !ts) return { kind: "ignore", reason: "empty" };
    return {
      kind: "prompt",
      botUserId,
      prompt: {
        ...slackThreadKey({
          ...base,
          channel,
          threadTs: str(event.thread_ts),
          ts,
        }),
        eventId: envelope.event_id,
        isExtShared: envelope.is_ext_shared_channel === true,
        text,
        userId: user,
        userTeamId: str(event.user_team),
      },
    };
  }

  if (type === "message") return { kind: "ignore", reason: "not-direct" };

  if (type === "app_mention" && channel) {
    if (!PROMPT_SUBTYPES.has(subtype))
      return { kind: "ignore", reason: "unsupported-subtype" };
    const user = str(event.user);
    const text = str(event.text);
    const ts = str(event.ts);
    if (!user || !text || !ts) return { kind: "ignore", reason: "empty" };
    return {
      kind: "prompt",
      botUserId,
      prompt: {
        ...slackThreadKey({
          ...base,
          channel,
          threadTs: str(event.thread_ts),
          ts,
        }),
        eventId: envelope.event_id,
        isExtShared: envelope.is_ext_shared_channel === true,
        text,
        userId: user,
        userTeamId: str(event.user_team),
      },
    };
  }

  return { kind: "ignore", reason: "unsupported-event" };
}
