import { describe, expect, it } from "vitest";

import { assertTrustedStreamUrl } from "../src/agent-client.js";

describe("Datalayer agent client", () => {
  it("accepts an HTTPS stream on the configured Datalayer origin", () => {
    expect(() =>
      assertTrustedStreamUrl(
        "https://prod1.datalayer.run",
        "https://prod1.datalayer.run/api/v1/stream/one",
      ),
    ).not.toThrow();
  });

  it("refuses a stream URL that could exfiltrate the host token", () => {
    expect(() =>
      assertTrustedStreamUrl(
        "https://prod1.datalayer.run",
        "https://attacker.example/collect",
      ),
    ).toThrow(/untrusted stream URL/);
  });
});
