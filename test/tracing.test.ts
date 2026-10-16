import { describe, expect, it } from "vitest";

import { LogTracer } from "@datalayer/agent-runtimes/lib/portable/hosts";

import { SlackAgentService } from "../src/service.js";
import { bothTracers, OtlpTracer } from "../src/tracing.js";
import {
  FakeAgents,
  FakeClock,
  FakeLinks,
  FakeSlack,
  installedStore,
  keptLogger,
  promptOf,
} from "./support/fakes.js";

const ENDPOINT = "https://prod1.datalayer.run/api/otel/v1/otlp/v1/traces";

type Exported = {
  resourceSpans: Array<{
    resource: {
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    };
    scopeSpans: Array<{
      spans: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        attributes: Array<{ key: string; value: Record<string, unknown> }>;
        status: { code: number; message?: string };
      }>;
    }>;
  }>;
};

/** A fake collector: what each export posted, and how it answers. */
function collector(status = 200) {
  const posts: Array<{
    body: Exported;
    headers: Record<string, string>;
    url: string;
  }> = [];
  const fetchImplementation = (async (
    input: string | URL,
    init?: RequestInit,
  ) => {
    posts.push({
      body: JSON.parse(init?.body as string) as Exported,
      headers: (init?.headers ?? {}) as Record<string, string>,
      url: String(input),
    });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetchImplementation, posts };
}

const spansOf = (posts: ReturnType<typeof collector>["posts"]) =>
  posts.flatMap((post) => post.body.resourceSpans[0]!.scopeSpans[0]!.spans);

describe("Spans exported to the plane's collector (S-101)", () => {
  it("posts OTLP JSON with the key, a nested span the child of its job, attributes read at its end", async () => {
    const { fetchImplementation, posts } = collector();
    let clock = 1_792_000_000_000;
    const tracer = new OtlpTracer(ENDPOINT, "otel-key", {
      fetchImplementation,
      now: () => (clock += 5),
    });
    const named: Record<string, string> = { "datalayer.session": "S-1" };
    await tracer.span(
      "slack.job.prompt",
      { "datalayer.slack.installation": "p1" },
      () =>
        tracer.span("slack.turn", named, async () => {
          named["datalayer.turn"] = "run-1"; // learned on the way
        }),
    );
    await tracer.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(ENDPOINT);
    expect(posts[0]?.headers.authorization).toBe("Bearer otel-key");
    expect(posts[0]?.headers["content-type"]).toBe("application/json");
    expect(posts[0]?.body.resourceSpans[0]?.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "datalayer-slack" } },
    ]);
    const [turn, job] = spansOf(posts);
    expect(turn?.name).toBe("slack.turn");
    expect(job?.name).toBe("slack.job.prompt");
    expect(turn?.traceId).toBe(job?.traceId);
    expect(turn?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(turn?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(turn?.parentSpanId).toBe(job?.spanId);
    expect(job?.parentSpanId).toBeUndefined();
    expect(turn?.attributes).toEqual([
      { key: "datalayer.session", value: { stringValue: "S-1" } },
      { key: "datalayer.turn", value: { stringValue: "run-1" } },
    ]);
    expect(BigInt(turn!.endTimeUnixNano)).toBeGreaterThan(
      BigInt(turn!.startTimeUnixNano),
    );
    expect(turn?.status).toEqual({ code: 1 });
  });

  it("marks a span whose work threw, and a refused or broken export never fails the work", async () => {
    const refused = collector(401);
    const kept = keptLogger();
    const tracer = new OtlpTracer(ENDPOINT, "otel-key", {
      fetchImplementation: refused.fetchImplementation,
      logger: kept.logger,
    });
    await expect(
      tracer.span("slack.job.prompt", {}, async () => {
        throw new TypeError("broken");
      }),
    ).rejects.toThrow("broken");
    await tracer.flush();
    expect(spansOf(refused.posts)[0]?.status).toEqual({
      code: 2,
      message: "TypeError",
    });
    expect(kept.lines.join("\n")).toContain("tracing.export_refused");

    const down = new OtlpTracer(ENDPOINT, "otel-key", {
      fetchImplementation: async () => {
        throw new Error("unreachable");
      },
      logger: kept.logger,
    });
    await expect(down.span("slack.turn", {}, async () => 7)).resolves.toBe(7);
    await expect(down.flush()).resolves.toBeUndefined();
    expect(kept.lines.join("\n")).toContain("tracing.export_failed");
  });

  it("sends a full batch at once", async () => {
    const { fetchImplementation, posts } = collector();
    const tracer = new OtlpTracer(ENDPOINT, "otel-key", {
      batch: 2,
      fetchImplementation,
    });
    await tracer.span("a", {}, async () => undefined);
    expect(posts).toHaveLength(0);
    await tracer.span("b", {}, async () => undefined);
    await Promise.resolve();
    expect(spansOf(posts).map((span) => span.name)).toEqual(["a", "b"]);
  });
});

describe("A turn's span carries its session and its run (S-101)", () => {
  it("names the session at once and the run once the stream names it", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const { fetchImplementation, posts } = collector();
    const exported = new OtlpTracer(ENDPOINT, "otel-key", {
      fetchImplementation,
    });
    const logged = keptLogger();
    const service = new SlackAgentService(
      store,
      new FakeAgents(),
      new FakeSlack(),
      "https://datalayer.ai",
      new FakeLinks(),
      {
        clock: new FakeClock(),
        logger: keptLogger().logger,
        tracer: bothTracers(new LogTracer(logged.logger), exported),
      },
    );
    await service.handlePrompt(promptOf(), "B1");
    await exported.flush();
    const turn = spansOf(posts).find((span) => span.name === "slack.turn");
    const attributes = Object.fromEntries(
      (turn?.attributes ?? []).map((one) => [one.key, one.value.stringValue]),
    );
    expect(attributes["datalayer.session"]).toBe("S-0");
    expect(attributes["datalayer.turn"]).toBe("t1");
    // The conversation's ids are pseudonyms, never Slack's own.
    expect(attributes["datalayer.slack.installation"]).toMatch(/^[0-9a-f]+$/);
    expect(JSON.stringify(attributes)).not.toContain("C1");
    // The same span as a log line.
    expect(logged.lines.join("\n")).toContain('"datalayer.turn":"t1"');
  });
});
