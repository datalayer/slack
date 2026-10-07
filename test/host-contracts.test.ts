import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  deliverySignature,
  DELIVERY_HEADER,
  HOST_KEY_HEADER,
  IDEMPOTENCY_HEADER,
  presentationSchema,
  PRESENTATION_VERSION,
  SIGNATURE_HEADER,
  slackMayDecide,
  TIMESTAMP_HEADER,
  verifyDelivery,
} from "../src/host-contracts.js";

/**
 * The same file ai-agents tests its half against
 * (services/ai-agents/tests/fixtures/hosts/contracts.json): a change on
 * either side that breaks the other fails here or there.
 */
const contracts = JSON.parse(
  readFileSync(new URL("./contracts/contracts.json", import.meta.url), "utf8"),
) as {
  delivery: {
    signing: {
      body: string;
      secret: string;
      signature: string;
      timestamp: number;
    };
  };
  headers: Record<string, string>;
  presentation: { example: unknown; version: number };
};

describe("Datalayer host contracts", () => {
  it("names the headers ai-agents and the session API read", () => {
    expect(contracts.headers).toMatchObject({
      delivery: DELIVERY_HEADER,
      host_key: HOST_KEY_HEADER,
      idempotency_key: IDEMPOTENCY_HEADER,
      signature: SIGNATURE_HEADER,
      timestamp: TIMESTAMP_HEADER,
    });
  });

  it("signs and verifies a delivery as ai-agents does", () => {
    const { body, secret, signature, timestamp } = contracts.delivery.signing;
    expect(deliverySignature(secret, timestamp, body)).toBe(signature);
    const delivery = verifyDelivery({
      nowSeconds: timestamp + 10,
      rawBody: body,
      secret,
      signature,
      timestamp: String(timestamp),
    });
    expect(delivery.event).toBe("approval.requested");
    expect(delivery.payload.target).toEqual({
      channel: "C0",
      thread_ts: "1700000000.000001",
    });
  });

  it("refuses a tampered, foreign or replayed delivery", () => {
    const { body, secret, signature, timestamp } = contracts.delivery.signing;
    const base = {
      nowSeconds: timestamp,
      rawBody: body,
      secret,
      signature,
      timestamp: String(timestamp),
    };
    expect(() =>
      verifyDelivery({ ...base, rawBody: body.replace("ap-1", "ap-2") }),
    ).toThrow(/signature/);
    expect(() => verifyDelivery({ ...base, secret: "another" })).toThrow(
      /signature/,
    );
    expect(() =>
      verifyDelivery({ ...base, nowSeconds: timestamp + 3600 }),
    ).toThrow(/too old/);
  });

  it("offers a decision only when the server says a host may", () => {
    expect(contracts.presentation.version).toBe(PRESENTATION_VERSION);
    const shown = presentationSchema.parse(contracts.presentation.example);
    expect(slackMayDecide(shown)).toBe(true);
    expect(slackMayDecide({ ...shown, host_may_decide: false })).toBe(false);
    expect(slackMayDecide({ ...shown, secret_fields: ["/token"] })).toBe(false);
    expect(slackMayDecide({ ...shown, version: 2 })).toBe(false);
    expect(slackMayDecide({ ...shown, status: "approved" })).toBe(false);
  });
});
