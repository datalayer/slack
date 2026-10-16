import { describe, expect, it } from "vitest";

import { createBoltApp } from "../src/bolt.js";
import { readConfig } from "../src/config.js";
import { OPEN_ACTION, THREAD_MENU_ACTION } from "../src/presentation.js";
import {
  RateLimitedError,
  retryingSlackPort,
  SlackRateLimiter,
} from "../src/rate-limit.js";
import { STREAM_LIMITS, STREAM_REST, TurnRenderer } from "../src/render.js";
import {
  FakeClock,
  FakeSlack,
  platformError,
  promptOf,
  rateLimited,
} from "./support/fakes.js";

const OPEN = "https://datalayer.ai/hosts/open?code=abc";

function streamed(slack: FakeSlack, clock = new FakeClock()) {
  const limiter = new SlackRateLimiter(clock);
  const renderer = new TurnRenderer(slack, limiter, promptOf(), {
    clock,
    openUrl: OPEN,
    recipientUserId: "U1",
  });
  return { clock, limiter, renderer };
}

describe("a streamed answer (S-206, the review of 16 October 2026)", () => {
  it("stops with blocks that do not repeat the streamed answer", async () => {
    const slack = new FakeSlack({ streaming: true });
    const { renderer } = streamed(slack);
    await renderer.begin();
    await renderer.apply({
      kind: "text",
      text: "Option B is safer.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nSee [the notes](https://datalayer.ai/notes).",
    });
    await renderer.apply({ kind: "completion" });
    await renderer.finish();
    const appended = slack
      .of("chat.appendStream")
      .map((call) => call.markdown)
      .join("");
    expect(appended).toContain("Option B is safer.");
    const stop = slack.of("chat.stopStream");
    expect(stop).toHaveLength(1);
    const blocks = JSON.stringify(stop[0]?.message?.blocks);
    // The words and the table were streamed: not appended a second time.
    expect(blocks).not.toContain("Option B is safer.");
    expect(blocks).not.toContain("```A  B");
    // What the stream did not carry is there: sources and the actions.
    expect(blocks).toContain("Sources: <https://datalayer.ai/notes|the notes>");
    expect(blocks).toContain(OPEN_ACTION);
    expect(blocks).toContain(THREAD_MENU_ACTION);
  });

  it("bounds every append and the whole stream, saying once that the rest is in Datalayer", async () => {
    const slack = new FakeSlack({ streaming: true });
    const { clock, renderer } = streamed(slack);
    await renderer.begin();
    // 60,000 characters in ten bursts of 6,000.
    for (let burst = 0; burst < 10; burst += 1) {
      clock.advance(2_000);
      await renderer.apply({ kind: "text", text: "x".repeat(6_000) });
    }
    await renderer.apply({ kind: "completion" });
    await renderer.finish();
    const appends = slack.of("chat.appendStream").map((call) => call.markdown);
    for (const chunk of appends)
      expect(chunk?.length).toBeLessThanOrEqual(STREAM_LIMITS.chunk);
    const whole = appends.join("");
    expect(whole.length).toBe(STREAM_LIMITS.total + STREAM_REST.length);
    expect(whole.endsWith(STREAM_REST)).toBe(true);
    expect(whole.split(STREAM_REST)).toHaveLength(2);
    // The stop still carries Open in Datalayer, where the rest is.
    expect(
      JSON.stringify(slack.of("chat.stopStream")[0]?.message?.blocks),
    ).toContain(OPEN_ACTION);
  });

  it("splits one large burst into appends of at most the chunk", async () => {
    const slack = new FakeSlack({ streaming: true });
    const { renderer } = streamed(slack);
    await renderer.begin();
    await renderer.apply({ kind: "text", text: "y".repeat(30_000) });
    await renderer.apply({ kind: "completion" });
    await renderer.finish();
    const appends = slack.of("chat.appendStream").map((call) => call.markdown);
    expect(appends.map((chunk) => chunk?.length)).toEqual([
      12_000, 12_000, 6_000,
    ]);
  });

  it("falls back to the bounded placeholder when Slack refuses to stream", async () => {
    const slack = new FakeSlack({ streaming: true });
    slack.fail("chat.startStream", platformError("feature_not_enabled"));
    const { renderer } = streamed(slack);
    await renderer.begin();
    expect(renderer.streamRefused).toBe("feature_not_enabled");
    await renderer.apply({ kind: "text", text: "Option B." });
    await renderer.apply({ kind: "completion" });
    await renderer.finish();
    expect(slack.of("chat.postMessage")).toHaveLength(1);
    expect(slack.of("chat.appendStream")).toHaveLength(0);
    expect(slack.of("chat.stopStream")).toHaveLength(0);
    const final = slack.of("chat.update").at(-1)?.message;
    // The placeholder path keeps its plain-text fallback.
    expect(final?.text).toBe("Option B.");
  });

  it("does not hide anything but Slack's own refusal behind the fallback", async () => {
    const slack = new FakeSlack({ streaming: true });
    slack.fail("chat.startStream", new Error("socket hang up"));
    const { renderer } = streamed(slack);
    await expect(renderer.begin()).rejects.toThrow("socket hang up");
    expect(slack.of("chat.postMessage")).toHaveLength(0);
  });
});

describe("every other Slack call waits out a 429 (S-206)", () => {
  it("retries a private word after Slack's Retry-After, without pacing it", async () => {
    const clock = new FakeClock();
    const limiter = new SlackRateLimiter(clock);
    const slack = new FakeSlack();
    slack.fail("private", rateLimited(4));
    const port = retryingSlackPort(slack, limiter);
    const key = promptOf();
    const before = clock.now();
    await port.postPrivate(key, "U1", { text: "Link your account" });
    expect(clock.now() - before).toBe(4_000);
    expect(slack.of("private")).toHaveLength(1);
    // Not paced: a second word right after waits nothing.
    const after = clock.now();
    await port.postPrivate(key, "U1", { text: "again" });
    expect(clock.now()).toBe(after);
  });

  it("gives up with a typed error after repeated 429s, and passes other errors through", async () => {
    const limiter = new SlackRateLimiter(new FakeClock(), 1);
    const slack = new FakeSlack();
    slack.fail("chat.postMessage", rateLimited(1), rateLimited(1));
    const port = retryingSlackPort(slack, limiter);
    await expect(
      port.postThread(promptOf(), { text: "card" }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    slack.fail("chat.update", platformError("message_not_found"));
    await expect(
      port.updateMessage(promptOf(), "1.0", { text: "card" }),
    ).rejects.toThrow("message_not_found");
  });

  it("builds the Bolt app's Web client to reject rate-limited calls, not absorb them", () => {
    const app = createBoltApp(
      readConfig({
        NODE_ENV: "test",
        SLACK_CLIENT_ID: "1.2",
        SLACK_CLIENT_SECRET: "client-secret",
        SLACK_REDIRECT_URI: "https://slack.example/slack/oauth/callback",
        SLACK_SIGNING_SECRET: "signing-secret",
        SLACK_STATE_SECRET: "s".repeat(32),
      }),
    );
    const client = app.client as unknown as { rejectRateLimitedCalls: boolean };
    expect(client.rejectRateLimitedCalls).toBe(true);
  });
});
