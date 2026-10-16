import { describe, expect, it } from "vitest";

import { SlackAgentService } from "../src/service.js";
import type { SemanticEvent } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { turnIsStale } from "../src/store.js";
import {
  FakeAgents,
  FakeClock,
  FakeLinks,
  FakeSlack,
  installedStore,
  keptLogger,
  promptOf,
} from "./support/fakes.js";

const MINUTE = 60_000;
const realDelay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("a long turn is not a crashed one (S-207, the review of 16 October 2026)", () => {
  it("writes a heartbeat while it answers; a redelivery and a new prompt both wait for it", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const agents = new FakeAgents((request) => ({
      run: { id: "t1" },
      sessionId: request.sessionId ?? "S-0",
      updates: (async function* (): AsyncGenerator<SemanticEvent> {
        yield { kind: "text", text: "Reading the books…" };
        await gate;
        yield { kind: "completion" };
      })(),
    }));
    const slack = new FakeSlack();
    const clock = new FakeClock();
    const { logger } = keptLogger();
    const service = new SlackAgentService(
      store,
      agents,
      slack,
      "https://datalayer.ai",
      new FakeLinks(
        new Map([
          ["U1", "alice"],
          ["U2", "bob"],
        ]),
      ),
      { clock, heartbeatMs: 5, logger },
    );
    const started = clock.now();
    const running = service.handlePrompt(promptOf(), "B1");
    // Twenty minutes of a long tool call: past the five-minute resume
    // window and the fifteen-minute stale window, measured from the start.
    await realDelay(20);
    clock.advance(20 * MINUTE);
    await realDelay(40);
    const turn = await store.getTurn(promptOf());
    expect(turn?.state).toBe("running");
    expect(turn?.startedAt).toBe(new Date(started).toISOString());
    expect(turn?.heartbeatAt).toBe(new Date(clock.now()).toISOString());

    // Slack redelivers the same event: its worker is alive, nothing is posted.
    await service.handlePrompt(promptOf(), "B1");
    expect(slack.of("chat.postMessage")).toHaveLength(1);
    expect(agents.requests).toHaveLength(1);
    // Bob asks in the same thread: still busy, not taken over.
    await service.handlePrompt(
      promptOf({ eventId: "Ev2", text: "<@B1> and now?", userId: "U2" }),
      "B1",
    );
    expect(agents.requests).toHaveLength(1);
    expect(
      slack.of("private").map((call) => call.message?.text ?? ""),
    ).toContainEqual(expect.stringContaining("still answering"));

    release();
    await running;
    expect((await store.getTurn(promptOf()))?.state).toBe("done");
  });

  it("judges a turn stale by its last heartbeat, else by its start", () => {
    const thread = promptOf();
    const at = Date.parse("2026-10-16T08:00:00Z");
    const turn = {
      ...thread,
      eventId: "Ev1",
      startedAt: new Date(at).toISOString(),
      state: "running" as const,
    };
    const later = new Date(at + 20 * MINUTE);
    expect(turnIsStale(turn, later, 15 * MINUTE)).toBe(true);
    expect(
      turnIsStale(
        { ...turn, heartbeatAt: new Date(at + 19 * MINUTE).toISOString() },
        later,
        15 * MINUTE,
      ),
    ).toBe(false);
  });
});
