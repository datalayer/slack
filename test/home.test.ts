import { describe, expect, it } from "vitest";

import { homeView } from "../src/home.js";
import { MemorySlackStore } from "../src/store.js";

describe("App Home", () => {
  it("explains an unlinked account without exposing applications", async () => {
    const store = new MemorySlackStore();
    const view = await homeView(
      store,
      { appId: "A1", teamId: "T1" },
      "U1",
      "https://datalayer.ai",
    );
    expect(JSON.stringify(view)).toContain("Not connected");
    expect(JSON.stringify(view)).toContain("/docs/slack");
    expect(JSON.stringify(view)).toContain(
      "does not read ambient channel history",
    );
  });

  it("shows the linked state and configured application", async () => {
    const store = new MemorySlackStore();
    await store.putUserLink({
      appId: "A1",
      datalayerPrincipalId: "P1",
      linkedAt: new Date(0).toISOString(),
      slackUserId: "U1",
      status: "active",
      teamId: "T1",
    });
    await store.setDefaultApplication(
      { appId: "A1", teamId: "T1" },
      "launch-review",
    );
    const view = await homeView(
      store,
      { appId: "A1", teamId: "T1" },
      "U1",
      "https://datalayer.ai",
    );
    expect(JSON.stringify(view)).toContain("Connected");
    expect(JSON.stringify(view)).toContain("launch-review");
  });

  it("offers Connect your Datalayer account with a fresh link when unlinked", async () => {
    const store = new MemorySlackStore();
    const view = await homeView(
      store,
      { appId: "A1", teamId: "T1" },
      "U1",
      "https://datalayer.ai",
      {
        connectUrlOf: async () => "https://datalayer.ai/hosts/link?code=dlhc_x",
        linkOf: async () => undefined,
      },
    );
    const text = JSON.stringify(view);
    expect(text).toContain("Connect your Datalayer account");
    expect(text).toContain("https://datalayer.ai/hosts/link?code=dlhc_x");
    expect(text).toContain("works once, for ten minutes");
  });

  it("says a workspace never bound to Datalayer is not connected yet", async () => {
    const view = await homeView(
      new MemorySlackStore(),
      { appId: "A1", teamId: "T1" },
      "U1",
      "https://datalayer.ai",
    );
    expect(JSON.stringify(view)).toContain("Ship tab");
    expect(JSON.stringify(view)).not.toContain("datalayer_connect_account");
  });
});
