import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import type {
  Logger,
  Tracer,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

type Attributes = Record<string, string | number | boolean>;

/** A span that ended, as it is exported. */
export type EndedSpan = Readonly<{
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  attributes: Attributes;
  /** The error's name when the work threw. */
  error?: string;
}>;

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** Milliseconds since the epoch as OTLP's nanoseconds, a decimal string. */
const nanos = (ms: number): string =>
  (BigInt(Math.round(ms * 1000)) * 1000n).toString();

function valueOf(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number")
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  return { stringValue: value };
}

/** Spans as OTLP/HTTP JSON (`ExportTraceServiceRequest`) for one service. */
export function otlpBody(
  spans: readonly EndedSpan[],
  serviceName: string,
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: serviceName },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: 1,
              startTimeUnixNano: nanos(span.startMs),
              endTimeUnixNano: nanos(span.endMs),
              attributes: Object.entries(span.attributes).map(
                ([key, value]) => ({ key, value: valueOf(value) }),
              ),
              status: span.error
                ? { code: 2, message: span.error }
                : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

/**
 * Spans exported to the plane's OTEL collector (S-101): OTLP/HTTP JSON to
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, with the platform's OTEL key as a
 * Bearer (the public ingest refuses a post without one). A span nested in
 * another is its child, in the same trace. Attributes are read when the span
 * ends, so work may name what it learns on the way (a turn's run). Batched;
 * an export that fails is logged and dropped, and never fails the work.
 */
export class OtlpTracer implements Tracer {
  readonly #current = new AsyncLocalStorage<{
    traceId: string;
    spanId: string;
  }>();
  #pending: EndedSpan[] = [];
  #timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly endpoint: string,
    readonly token: string,
    readonly options: Readonly<{
      fetchImplementation?: typeof fetch;
      logger?: Logger;
      serviceName?: string;
      /** How long an ended span waits for others before it is sent. */
      flushMs?: number;
      /** How many ended spans are sent at once, at most. */
      batch?: number;
      now?: () => number;
    }> = {},
  ) {}

  async span<T>(
    name: string,
    attributes: Attributes,
    work: () => Promise<T>,
  ): Promise<T> {
    const now = this.options.now ?? Date.now;
    const parent = this.#current.getStore();
    const context = { traceId: parent?.traceId ?? hex(16), spanId: hex(8) };
    const startMs = now();
    let error: string | undefined;
    try {
      return await this.#current.run(context, work);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.name : "unknown";
      throw thrown;
    } finally {
      this.#ended({
        ...context,
        parentSpanId: parent?.spanId,
        name,
        startMs,
        endMs: now(),
        attributes: { ...attributes },
        error,
      });
    }
  }

  #ended(span: EndedSpan): void {
    this.#pending.push(span);
    if (this.#pending.length >= (this.options.batch ?? 50)) {
      void this.flush();
      return;
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.flush();
      }, this.options.flushMs ?? 5_000);
      this.#timer.unref?.();
    }
  }

  /** Send what ended; a failure is logged and the spans dropped. */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const spans = this.#pending;
    this.#pending = [];
    if (spans.length === 0) return;
    try {
      const response = await (this.options.fetchImplementation ?? fetch)(
        this.endpoint,
        {
          body: JSON.stringify(
            otlpBody(spans, this.options.serviceName ?? "datalayer-slack"),
          ),
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
      );
      if (!response.ok)
        this.options.logger?.warn("tracing.export_refused", {
          spans: spans.length,
          status: response.status,
        });
    } catch (error) {
      this.options.logger?.warn("tracing.export_failed", {
        error_name: error instanceof Error ? error.name : "unknown",
        spans: spans.length,
      });
    }
  }
}

/** Both tracers on the same work: the log line and the exported span. */
export function bothTracers(first: Tracer, second: Tracer): Tracer {
  return {
    span: (name, attributes, work) =>
      first.span(name, attributes, () => second.span(name, attributes, work)),
  };
}
