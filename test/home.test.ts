import { describe, expect, it } from "vitest";

import {
  CONNECT_ACTION,
  DOCS_ACTION,
  EVENTS_ACTION,
  HOME_WORDS,
  homeView,
  SUPPORT_ACTION,
  UNLINK_ACTION,
} from "../src/home.js";
import { StoreLinks } from "../src/host-installations.js";
import { MemorySlackStore } from "../src/store.js";

const key = { appId: "A1", teamId: "T1" } as const;

async function storeWithApplications(): Promise<MemorySlackStore> {
  const store = new MemorySlackStore();
  await store.setDefaultApplication(key, "dep-1");
  const allowance = {
    ...key,
    configuredBy: "owner",
    updatedAt: new Date(0).toISOString(),
  };
  await store.putAllowances(key, [
    {
      ...allowance,
      applicationId: "dep-1",
      channelPolicy: "channels",
      enabled: true,
      isDefault: true,
      name: "Launch Review",
    },
    {
      ...allowance,
      applicationId: "dep-2",
      channelPolicy: "direct-only",
      enabled: true,
      isDefault: false,
      name: "Desk <b>",
    },
    {
      ...allowance,
      applicationId: "dep-3",
      channelPolicy: "channels",
      enabled: false,
      isDefault: false,
      name: "Paused One",
    },
  ]);
  return store;
}

const linked = {
  connectUrlOf: async () => undefined,
  linkOf: async () => ({ principalId: "alice" }),
  unlink: async () => true,
};

describe("App Home (S-104)", () => {
  it("explains an unlinked account without exposing applications", async () => {
    const store = new MemorySlackStore();
    const view = await homeView(store, key, "U1", "https://datalayer.ai");
    expect(JSON.stringify(view)).toContain("Not connected");
    expect(JSON.stringify(view)).toContain("/docs/slack");
    expect(JSON.stringify(view)).toContain(
      "does not read ambient channel history",
    );
  });

  it("offers Connect your Datalayer account with a fresh link when unlinked", async () => {
    const view = await homeView(
      new MemorySlackStore(),
      key,
      "U1",
      "https://datalayer.ai",
      {
        connectUrlOf: async () => "https://datalayer.ai/hosts/link?code=dlhc_x",
        linkOf: async () => undefined,
      },
    );
    const text = JSON.stringify(view);
    expect(text).toContain(HOME_WORDS.connect);
    expect(text).toContain(CONNECT_ACTION);
    expect(text).toContain("https://datalayer.ai/hosts/link?code=dlhc_x");
    expect(text).toContain("works once, for ten minutes");
    expect(text).not.toContain(UNLINK_ACTION);
  });

  it("says a workspace never bound to Datalayer is not connected yet", async () => {
    const view = await homeView(
      new MemorySlackStore(),
      key,
      "U1",
      "https://datalayer.ai",
    );
    expect(JSON.stringify(view)).toContain("Ship tab");
    expect(JSON.stringify(view)).not.toContain(CONNECT_ACTION);
  });

  it("shows a linked person the permitted applications, the default, Unlink, the guide, help and the privacy line", async () => {
    const store = await storeWithApplications();
    const view = await homeView(
      store,
      key,
      "U1",
      "https://datalayer.ai/",
      linked,
      {
        limit: 50,
        used: 7,
        window: "day",
      },
    );
    const text = JSON.stringify(view);
    expect(text).toContain("Connected");
    expect(text).toContain("*Default application*\\nLaunch Review");
    expect(text).toContain("Applications you can ask from Slack");
    expect(text).toContain("• Launch Review (default)");
    expect(text).toContain("• Desk &lt;b&gt; — direct messages only");
    expect(text).not.toContain("Paused One");
    expect(text).toContain(UNLINK_ACTION);
    expect(text).toContain("Unlink your account?");
    expect(text).toContain(DOCS_ACTION);
    expect(text).toContain("https://datalayer.ai/docs/slack");
    expect(text).toContain(SUPPORT_ACTION);
    expect(text).toContain("https://datalayer.ai/docs/slack#troubleshooting");
    expect(text).toContain("Slack data is not used to train models");
    expect(text).toContain("You asked 7 of 50 questions this day.");
    expect(text).not.toContain(CONNECT_ACTION);
  });

  it("offers Unlink only where links can be ended", async () => {
    const store = new MemorySlackStore();
    await store.putUserLink({
      ...key,
      datalayerPrincipalId: "P1",
      linkedAt: new Date(0).toISOString(),
      slackUserId: "U1",
      status: "active",
    });
    const view = await homeView(
      store,
      key,
      "U1",
      "https://datalayer.ai",
      new StoreLinks(store),
    );
    expect(JSON.stringify(view)).toContain(UNLINK_ACTION);
    await new StoreLinks(store).unlink(key, "U1");
    const after = await homeView(
      store,
      key,
      "U1",
      "https://datalayer.ai",
      new StoreLinks(store),
    );
    expect(JSON.stringify(after)).toContain("Not connected");
  });
});

describe("App Home's suggestions (S-104)", () => {
  const starters = {
    asked: [] as Array<{ applicationId: string; userId: string }>,
    async startersOf(_key: unknown, userId: string, applicationId: string) {
      this.asked.push({ applicationId, userId });
      return [
        { label: "Compare", message: "Compare the two launch options." },
        { label: "Risks <b>", message: "What are the risks?" },
      ];
    },
  };

  it("suggests the default application's starters, read as this person", async () => {
    starters.asked.length = 0;
    const view = await homeView(
      await storeWithApplications(),
      key,
      "U1",
      "https://datalayer.ai",
      linked,
      undefined,
      starters,
    );
    const text = JSON.stringify(view);
    expect(starters.asked).toEqual([{ applicationId: "dep-1", userId: "U1" }]);
    expect(text).toContain("*Try asking Launch Review*");
    expect(text).toContain("• *Compare*: Compare the two launch options.");
    expect(text).toContain("• *Risks &lt;b&gt;*: What are the risks?");
  });

  it("asks nothing for a person not connected", async () => {
    starters.asked.length = 0;
    const view = await homeView(
      await storeWithApplications(),
      key,
      "U1",
      "https://datalayer.ai",
      {
        connectUrlOf: async () => "https://datalayer.ai/hosts/link?code=one",
        linkOf: async () => undefined,
      },
      undefined,
      starters,
    );
    expect(starters.asked).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(HOME_WORDS.tryAsking);
  });

  it("says so when the starters cannot be read, rather than leaving them out", async () => {
    const view = await homeView(
      await storeWithApplications(),
      key,
      "U1",
      "https://datalayer.ai",
      linked,
      undefined,
      {
        startersOf: async () => {
          throw new Error("Datalayer refused the host credential exchange");
        },
      },
    );
    const text = JSON.stringify(view);
    expect(text).toContain(HOME_WORDS.startersUnread);
    expect(text).not.toContain(HOME_WORDS.tryAsking);
  });

  it("shows at most five, and none when the application has none", async () => {
    const many = await homeView(
      await storeWithApplications(),
      key,
      "U1",
      "https://datalayer.ai",
      linked,
      undefined,
      {
        startersOf: async () =>
          Array.from({ length: 8 }, (_, index) => ({
            label: `S${index}`,
            message: `M${index}`,
          })),
      },
    );
    expect(JSON.stringify(many)).toContain("*S4*");
    expect(JSON.stringify(many)).not.toContain("*S5*");
    const none = await homeView(
      await storeWithApplications(),
      key,
      "U1",
      "https://datalayer.ai",
      linked,
      undefined,
      { startersOf: async () => [] },
    );
    expect(JSON.stringify(none)).not.toContain(HOME_WORDS.tryAsking);
  });
});

describe("How answers show their work, per person (S-308)", () => {
  it("offers a connected person quiet or noisy, the one in force selected", async () => {
    const store = await storeWithApplications();
    for (const events of ["quiet", "noisy"] as const) {
      const view = await homeView(
        store,
        key,
        "U1",
        "https://datalayer.ai",
        linked,
        undefined,
        undefined,
        events,
      );
      const radio = view.blocks
        .flatMap((block) => (block.type === "actions" ? block.elements : []))
        .find(
          (element) =>
            (element as { action_id?: string }).action_id === EVENTS_ACTION,
        ) as
        | {
            initial_option?: { value: string };
            options: Array<{ value: string; text: { text: string } }>;
          }
        | undefined;
      expect(radio?.options.map((one) => one.text.text)).toEqual([
        HOME_WORDS.quiet,
        HOME_WORDS.noisy,
      ]);
      expect(radio?.initial_option?.value).toBe(events);
    }
  });

  it("offers nothing to a person not connected", async () => {
    const store = await storeWithApplications();
    const view = await homeView(
      store,
      key,
      "U9",
      "https://datalayer.ai",
      {
        connectUrlOf: async () => "https://datalayer.ai/hosts/link?code=one",
        linkOf: async () => undefined,
      },
      undefined,
      undefined,
      "quiet",
    );
    expect(JSON.stringify(view.blocks)).not.toContain(EVENTS_ACTION);
  });
});
