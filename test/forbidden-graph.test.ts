import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { bundle } from "../scripts/bundle.js";
import { forbiddenInSources } from "../scripts/forbidden-sources.js";

/**
 * What the service runs is one esbuild bundle (DC-004, S-005):
 * its sources and agent-runtimes' `lib/portable`,
 * nothing of Jupyter, React or another package; its dependencies external.
 * Bundled here in memory (`write: false`): analysis, nothing written.
 */
describe("the bundle graph", () => {
  it("bundles the sources and agent-runtimes' lib/portable/hosts only, and passes the gate", async () => {
    const { metafile, violations } = await bundle(false);
    expect(violations).toEqual([]);
    const inputs = Object.keys(metafile.inputs);
    const portable = inputs.filter((one) => one.includes("/lib/portable/"));
    expect(portable.some((one) => one.includes("/lib/portable/hosts/"))).toBe(
      true,
    );
    for (const input of inputs)
      expect(
        input.startsWith("src/") ||
          input.startsWith("scripts/") ||
          /agent-runtimes\/lib\/portable\//.test(input),
        input,
      ).toBe(true);
    // Never the portable entry a phone takes, whose types reach Reactor.
    expect(inputs.some((one) => one.endsWith("/lib/portable/index.js"))).toBe(
      false,
    );
  }, 60_000);

  it("passes on this service's sources", async () => {
    await expect(forbiddenInSources("src")).resolves.toEqual([]);
  });
});

/** What moved to the shared host kit (DC-004): no copy, no shim, left here. */
const MOVED = [
  "slackMayDecide",
  "sseEvents",
  "class DatalayerHostClient",
  "class HttpAgentClient",
  "class HostKeyCredentials",
  "class PostgresWorkQueue",
  "class MemoryWorkQueue",
  "class SecretCipher",
  "class DeadLetters",
  "class DeliveryPoller",
  "function deliveryRoute",
  "function verifyDelivery",
  "function renderApproval",
  "function semanticOf",
  "function answerParts",
  "function quotaEntries",
  "function readiness",
  "function redact",
  "export const presentationSchema",
  "export const SEMANTIC_KINDS",
];

describe("the move to agent-runtimes' src/portable/hosts", () => {
  it("leaves no moved export in this service", async () => {
    for (const name of await readdir("src")) {
      const source = await readFile(`src/${name}`, "utf8");
      for (const moved of MOVED)
        expect(source.includes(moved), `src/${name}: ${moved}`).toBe(false);
    }
  });
});
