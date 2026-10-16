import { describe, expect, it } from "vitest";

import { ingressOf, type EventEnvelope } from "../src/ingress.js";

const envelope = (
  event: Record<string, unknown>,
  extra: Partial<EventEnvelope> = {},
): EventEnvelope => ({
  api_app_id: "A1",
  authorizations: [{ is_bot: true, user_id: "B1" }],
  event,
  event_id: "Ev1",
  team_id: "T1",
  type: "event_callback",
  ...extra,
});

describe("Slack event normalization (S-201, S-209)", () => {
  it("reads a mention as a prompt in its thread, with its installation from the signed body", () => {
    const ingress = ingressOf(
      envelope({
        channel: "C1",
        text: "<@B1> hi",
        thread_ts: "0.5",
        ts: "1.0",
        type: "app_mention",
        user: "U1",
        user_team: "T1",
      }),
    );
    expect(ingress).toEqual({
      botUserId: "B1",
      kind: "prompt",
      prompt: {
        appId: "A1",
        channelId: "C1",
        enterpriseId: undefined,
        eventId: "Ev1",
        isExtShared: false,
        teamId: "T1",
        text: "<@B1> hi",
        threadTs: "0.5",
        userId: "U1",
        userTeamId: "T1",
      },
    });
  });

  it("starts a thread at the message itself when it is not in one", () => {
    const ingress = ingressOf(
      envelope({
        channel: "D1",
        channel_type: "im",
        text: "hi",
        ts: "2.0",
        type: "message",
        user: "U1",
      }),
    );
    expect(ingress.kind === "prompt" && ingress.prompt.threadTs).toBe("2.0");
  });

  it("marks a shared channel", () => {
    const ingress = ingressOf(
      envelope(
        {
          channel: "C1",
          text: "<@B1> hi",
          ts: "1.0",
          type: "app_mention",
          user: "U1",
        },
        { is_ext_shared_channel: true },
      ),
    );
    expect(ingress.kind === "prompt" && ingress.prompt.isExtShared).toBe(true);
  });

  it.each([
    [
      "a bot",
      {
        bot_id: "Bx",
        channel: "D1",
        channel_type: "im",
        text: "x",
        ts: "1",
        type: "message",
        user: "U2",
      },
      "bot",
    ],
    [
      "a bot message subtype",
      {
        channel: "D1",
        channel_type: "im",
        subtype: "bot_message",
        text: "x",
        ts: "1",
        type: "message",
      },
      "bot",
    ],
    [
      "itself",
      {
        channel: "D1",
        channel_type: "im",
        text: "x",
        ts: "1",
        type: "message",
        user: "B1",
      },
      "self",
    ],
    [
      "a channel join",
      {
        channel: "D1",
        channel_type: "im",
        subtype: "channel_join",
        text: "x",
        ts: "1",
        type: "message",
        user: "U1",
      },
      "unsupported-subtype",
    ],
    [
      "a channel message (no channels:history)",
      {
        channel: "C1",
        channel_type: "channel",
        text: "x",
        ts: "1",
        type: "message",
        user: "U1",
      },
      "not-direct",
    ],
    [
      "an empty message",
      {
        channel: "D1",
        channel_type: "im",
        text: "",
        ts: "1",
        type: "message",
        user: "U1",
      },
      "empty",
    ],
    [
      "a reaction",
      { item: {}, reaction: "+1", type: "reaction_added", user: "U1" },
      "unsupported-event",
    ],
  ])("ignores %s", (_name, event, reason) => {
    expect(ingressOf(envelope(event))).toEqual({ kind: "ignore", reason });
  });

  it("ignores what is not a signed event callback", () => {
    expect(ingressOf({ type: "url_verification" })).toEqual({
      kind: "ignore",
      reason: "not-an-event",
    });
    expect(
      ingressOf({ ...envelope({ type: "app_mention" }), team_id: undefined }),
    ).toEqual({
      kind: "ignore",
      reason: "unsigned-installation",
    });
  });

  it("reads an edited direct message as an edit, never a new prompt", () => {
    const ingress = ingressOf(
      envelope({
        channel: "D1",
        channel_type: "im",
        message: { text: "the new words", ts: "1.0", user: "U1" },
        previous_message: { text: "the old words", ts: "1.0", user: "U1" },
        subtype: "message_changed",
        type: "message",
      }),
    );
    expect(ingress).toMatchObject({
      kind: "edited",
      originalTs: "1.0",
      prompt: { text: "the new words", userId: "U1" },
    });
  });

  it("does not read an unfurl as an edit", () => {
    const ingress = ingressOf(
      envelope({
        channel: "D1",
        channel_type: "im",
        message: { text: "same", ts: "1.0", user: "U1" },
        previous_message: { text: "same", ts: "1.0", user: "U1" },
        subtype: "message_changed",
        type: "message",
      }),
    );
    expect(ingress.kind).toBe("ignore");
  });

  it("reads a deleted direct message as a deletion", () => {
    const ingress = ingressOf(
      envelope({
        channel: "D1",
        channel_type: "im",
        deleted_ts: "1.0",
        previous_message: { text: "x", ts: "1.0", user: "U1" },
        subtype: "message_deleted",
        type: "message",
      }),
    );
    expect(ingress).toMatchObject({
      deletedTs: "1.0",
      kind: "deleted",
      prompt: { userId: "U1" },
    });
  });
});
