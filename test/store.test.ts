import { describe, expect, it } from "vitest";

import { MemorySlackStore } from "../src/store.js";

const installation = { appId: "A1", teamId: "T1" } as const;

describe("MemorySlackStore", () => {
  it("claims an event once", async () => {
    const store = new MemorySlackStore();
    await expect(store.claimEvent("Ev1")).resolves.toBe(true);
    await expect(store.claimEvent("Ev1")).resolves.toBe(false);
  });

  it("isolates user links by installation", async () => {
    const store = new MemorySlackStore();
    await store.putUserLink({
      ...installation,
      datalayerPrincipalId: "P1",
      linkedAt: new Date(0).toISOString(),
      slackUserId: "U1",
      status: "active",
    });
    await expect(store.getUserLink(installation, "U1")).resolves.toMatchObject({
      datalayerPrincipalId: "P1",
    });
    await expect(
      store.getUserLink({ appId: "A1", teamId: "T2" }, "U1"),
    ).resolves.toBeUndefined();
  });
});
