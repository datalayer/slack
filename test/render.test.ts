import type { KnownBlock } from "@slack/types";
import { describe, expect, it } from "vitest";

import {
  answeredAskBlocks,
  answerMrkdwn,
  SLACK_LIMITS,
  slackLink,
  STOP_ACTION,
  TurnPresentation,
} from "../src/presentation.js";
import { RateLimitedError, SlackRateLimiter } from "../src/rate-limit.js";
import { PUBLISH_CADENCE_MS, TurnRenderer } from "../src/render.js";
import {
  FakeClock,
  FakeSlack,
  promptOf,
  rateLimited,
} from "./support/fakes.js";

const OPEN = "https://datalayer.ai/loop/session/S1";

function rendererOf(slack: FakeSlack, clock = new FakeClock()) {
  const limiter = new SlackRateLimiter(clock);
  const renderer = new TurnRenderer(slack, limiter, promptOf(), {
    clock,
    openUrl: OPEN,
    recipientUserId: "U1",
  });
  renderer.stopValue = JSON.stringify({ e: "Ev1", r: "t1", s: "S1" });
  renderer.runId = "t1";
  return { clock, limiter, renderer };
}

describe("rendering a turn in Slack (S-206)", () => {
  it("publishes a long token stream with a bounded number of updates, never one per token", async () => {
    const slack = new FakeSlack();
    const { clock, renderer } = rendererOf(slack);
    await renderer.begin();
    // 600 tokens over 30 seconds: one every 50 ms.
    for (let token = 0; token < 600; token += 1) {
      clock.advance(50);
      await renderer.apply({ kind: "text", text: `t${token} ` });
    }
    await renderer.apply({ kind: "completion" });
    await renderer.finish();
    const updates = slack.of("chat.update");
    expect(updates.length).toBeLessThanOrEqual(
      Math.ceil(30_000 / PUBLISH_CADENCE_MS) + 1,
    );
    expect(updates.length).toBeGreaterThan(2);
    expect(slack.of("chat.postMessage")).toHaveLength(1);
    // The final message is whole, and Stop is gone from it.
    const final = updates.at(-1)?.message;
    expect(final?.text).toContain("t599");
    expect(JSON.stringify(final?.blocks)).not.toContain(STOP_ACTION);
  });

  it("shows Stop naming the run while it runs", async () => {
    const slack = new FakeSlack();
    const { clock, renderer } = rendererOf(slack);
    await renderer.begin();
    clock.advance(PUBLISH_CADENCE_MS);
    await renderer.apply({
      kind: "tool",
      id: "c1",
      name: "search",
      status: "running",
    });
    const running = JSON.stringify(
      slack.of("chat.update").at(-1)?.message?.blocks,
    );
    expect(running).toContain(STOP_ACTION);
    expect(running).toContain("Stop run t1");
    expect(running).toContain("Using search");
  });

  it("honours Slack's Retry-After on a 429 and tries again", async () => {
    const slack = new FakeSlack();
    slack.fail("chat.update", rateLimited(7));
    const { clock, limiter, renderer } = rendererOf(slack);
    await renderer.begin();
    const before = clock.now();
    await renderer.apply({ kind: "completion", text: "Done." });
    await renderer.finish();
    expect(clock.now() - before).toBeGreaterThanOrEqual(7_000);
    expect(limiter.waits.some((wait) => wait >= 7_000)).toBe(true);
    expect(slack.of("chat.update").at(-1)?.message?.text).toBe("Done.");
  });

  it("gives up after repeated 429s with a typed error", async () => {
    const limiter = new SlackRateLimiter(new FakeClock(), 2);
    let calls = 0;
    await expect(
      limiter.run("chat.update", "C1", async () => {
        calls += 1;
        throw rateLimited(1);
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toBe(3);
  });

  it("spaces calls of one method to one channel, not across channels", async () => {
    const clock = new FakeClock();
    const limiter = new SlackRateLimiter(clock);
    await limiter.run("chat.update", "C1", async () => undefined);
    await limiter.run("chat.update", "C1", async () => undefined);
    await limiter.run("chat.update", "C2", async () => undefined);
    expect(limiter.waits).toEqual([1_200]);
  });

  it("streams with chat.startStream, appends in batches and stops with the final blocks", async () => {
    const slack = new FakeSlack({ streaming: true });
    const { clock, renderer } = rendererOf(slack);
    await renderer.begin();
    for (let token = 0; token < 100; token += 1) {
      clock.advance(100);
      await renderer.apply({ kind: "text", text: `w${token} ` });
    }
    await renderer.apply({ kind: "completion" });
    await renderer.finish();
    expect(slack.of("chat.startStream")).toHaveLength(1);
    expect(slack.of("chat.startStream")[0]?.userId).toBe("U1");
    const appends = slack.of("chat.appendStream");
    expect(appends.length).toBeLessThanOrEqual(
      Math.ceil(10_000 / PUBLISH_CADENCE_MS) + 1,
    );
    expect(appends.map((one) => one.markdown).join("")).toContain("w99");
    expect(slack.of("chat.stopStream")).toHaveLength(1);
    expect(slack.of("chat.update")).toHaveLength(0);
  });
});

describe("Slack-safe messages (S-206, S-306)", () => {
  it("always carries a plain-text fallback", () => {
    const presentation = new TurnPresentation();
    presentation.apply({
      kind: "tool",
      id: "c1",
      name: "search",
      status: "running",
    });
    expect(presentation.message(OPEN).text).toBe("Using search");
    presentation.apply({ kind: "text", text: "Option *B* is safer." });
    presentation.apply({ kind: "completion" });
    const message = presentation.message(OPEN);
    expect(message.text).toBe("Option *B* is safer.");
    expect(message.text.length).toBeLessThanOrEqual(SLACK_LIMITS.fallbackText);
  });

  it("keeps a huge answer within Slack's block and section limits", () => {
    const presentation = new TurnPresentation();
    presentation.apply({ kind: "text", text: "word ".repeat(60_000) });
    presentation.apply({ kind: "completion" });
    const message = presentation.message(OPEN);
    const blocks = message.blocks as Array<{
      type: string;
      text?: { text: string };
    }>;
    expect(blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.blocks);
    for (const block of blocks)
      if (block.text)
        expect(block.text.text.length).toBeLessThanOrEqual(
          SLACK_LIMITS.sectionText,
        );
    expect(JSON.stringify(blocks)).toContain(
      "The rest of this answer is in Datalayer",
    );
    expect(message.text.length).toBeLessThanOrEqual(SLACK_LIMITS.fallbackText);
    // The actions survive the cut.
    expect(blocks.at(-1)?.type).toBe("actions");
  });

  it("shows a small table whole and a large one as a preview with the rest in Datalayer", () => {
    const small = new TurnPresentation();
    small.apply({ kind: "text", text: "| A | B |\n|---|---|\n| 1 | 2 |" });
    small.apply({ kind: "completion" });
    const shown = JSON.stringify(small.message(OPEN).blocks);
    expect(shown).toContain("```A  B");
    expect(shown).not.toContain("more row");

    const large = new TurnPresentation();
    const rows = Array.from(
      { length: 40 },
      (_, index) => `| r${index} | ${index} |`,
    ).join("\n");
    large.apply({ kind: "text", text: `| Name | N |\n|---|---|\n${rows}` });
    large.apply({ kind: "completion" });
    const preview = JSON.stringify(large.message(OPEN).blocks);
    expect(preview).toContain("r11");
    expect(preview).not.toContain("r12 ");
    expect(preview).toContain("28 more rows");
    expect(preview).toContain("see the whole table in Datalayer");
  });

  it("lists citations as safe HTTPS links and never makes a link of another scheme", () => {
    const presentation = new TurnPresentation();
    presentation.apply({
      kind: "text",
      text: "See [the notes](https://datalayer.ai/notes) and [bad](javascript:alert(1)) and <!channel>.",
    });
    presentation.apply({ kind: "completion" });
    const blocks = JSON.stringify(presentation.message(OPEN).blocks);
    expect(blocks).toContain("Sources: <https://datalayer.ai/notes|the notes>");
    expect(blocks).not.toContain("<javascript:");
    expect(blocks).toContain("&lt;!channel&gt;");
  });

  it("escapes a link's label and refuses credentials in a URL", () => {
    expect(slackLink("https://a.example/x", "a|b>c")).toBe(
      "<https://a.example/x|a¦b&gt;c>",
    );
    expect(slackLink("https://user:pw@a.example/", "x")).toBe("x");
    expect(answerMrkdwn("[x](https://a.example/y?z=<1>)")).toContain(
      "<https://a.example/y?z=%3C1%3E|x>",
    );
  });

  it("asks a choice with buttons and hands a form to Datalayer", () => {
    const choice = new TurnPresentation();
    choice.apply({
      kind: "ask",
      question: { kind: "choice", prompt: "Which?", options: ["A", "B"] },
    });
    const buttons = JSON.stringify(
      choice.message(OPEN, { askValue: "Ev1" }).blocks,
    );
    expect(buttons).toContain("datalayer_ask_choice_0");
    expect(buttons).toContain("datalayer_ask_choice_1");

    const form = new TurnPresentation();
    form.apply({
      kind: "ask",
      question: { kind: "form", prompt: "Your details" },
    });
    const handed = JSON.stringify(
      form.message(OPEN, { askValue: "Ev1" }).blocks,
    );
    expect(handed).toContain("Answer in Datalayer");
    expect(handed).not.toContain("datalayer_ask_choice");
  });
});

describe("questions and the event policy (S-307, S-308)", () => {
  it("asks a text question by reply in a direct message, by mention in a channel", () => {
    const asking = new TurnPresentation();
    asking.apply({
      kind: "ask",
      question: { kind: "text", prompt: "Which quarter?" },
    });
    expect(
      JSON.stringify(asking.message(OPEN, { direct: true }).blocks),
    ).toContain("Reply in this thread to answer.");
    expect(
      JSON.stringify(asking.message(OPEN, { direct: false }).blocks),
    ).toContain("Answer in this thread by mentioning @Datalayer");
    expect(asking.message(OPEN).text).toBe("Which quarter?");
  });

  it("hands a choice of more than five answers to Datalayer", () => {
    const many = new TurnPresentation();
    many.apply({
      kind: "ask",
      question: {
        kind: "choice",
        options: ["1", "2", "3", "4", "5", "6"],
        prompt: "Which?",
      },
    });
    const blocks = JSON.stringify(
      many.message(OPEN, { askValue: "Ev1" }).blocks,
    );
    expect(blocks).not.toContain("datalayer_ask_choice");
    expect(blocks).toContain("Answer in Datalayer");
  });

  it("hands a choice it cannot show whole to Datalayer: no options, a long option, a long value (S-307)", () => {
    for (const options of [[], ["Short", "x".repeat(76)]]) {
      const asking = new TurnPresentation();
      asking.apply({
        kind: "ask",
        question: { kind: "choice", options, prompt: "Which?" },
      });
      const blocks = JSON.stringify(
        asking.message(OPEN, { askValue: "Ev1" }).blocks,
      );
      expect(blocks).not.toContain("datalayer_ask_choice");
      expect(blocks).toContain("Answer in Datalayer");
    }
    const tooLong = new TurnPresentation();
    tooLong.apply({
      kind: "ask",
      question: { kind: "choice", options: ["Yes", "No"], prompt: "Which?" },
    });
    const handed = JSON.stringify(
      tooLong.message(OPEN, { askValue: "E".repeat(1990) }).blocks,
    );
    expect(handed).not.toContain("datalayer_ask_choice");
    expect(handed).toContain("Answer in Datalayer");
  });

  it("replaces an answered choice's buttons by who answered what", () => {
    const asking = new TurnPresentation();
    asking.apply({
      kind: "ask",
      question: { kind: "choice", options: ["A", "B"], prompt: "Which?" },
    });
    const blocks = asking.message(OPEN, { askValue: "Ev1" })
      .blocks as KnownBlock[];
    const answered = JSON.stringify(answeredAskBlocks(blocks, "B", "U2"));
    expect(answered).not.toContain("datalayer_ask_choice");
    expect(answered).toContain("<@U2> answered: B");
    expect(answered).toContain("Which?");
  });

  it("keeps routine tool events to one status line unless the policy is noisy", () => {
    const turn = new TurnPresentation();
    turn.apply({ kind: "tool", id: "c1", name: "search", status: "complete" });
    turn.apply({ kind: "tool", id: "c2", name: "read_file", status: "failed" });
    turn.apply({
      kind: "tool",
      id: "c3",
      name: "summarize",
      status: "running",
    });
    const quiet = JSON.stringify(
      turn.message(OPEN, { events: "quiet" }).blocks,
    );
    expect(quiet).toContain("Using summarize");
    expect(quiet).not.toContain("✓ search");
    const noisy = JSON.stringify(
      turn.message(OPEN, { events: "noisy" }).blocks,
    );
    expect(noisy).toContain("✓ search");
    expect(noisy).toContain("✗ read_file");
    expect(noisy).toContain("⏳ summarize");
  });
});
