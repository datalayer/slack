import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  approvalCard,
  confirmModal,
  decidedCard,
  waitingLine,
} from "../src/approval-card.js";
import { homeView } from "../src/home.js";
import {
  presentationSchema,
  type ApprovalPresentation,
} from "../src/host-contracts.js";
import { TurnPresentation } from "../src/presentation.js";
import { TurnRouting } from "../src/routing.js";
import type { SemanticEvent } from "../src/semantic.js";
import { MemorySlackStore } from "../src/store.js";
import {
  BLOCK_KIT,
  blockKitProblems,
  messageProblems,
  surfaceProblems,
} from "./support/blockkit.js";
import { FakeLinks } from "./support/fakes.js";

/**
 * Block Kit snapshots of every message, modal and App Home @Datalayer
 * builds (plans/SLACK.md §12.1 Rendering, S-406), each held to Slack's
 * limits, with a plain-text fallback on every message and alt text on
 * every image. A change to what Slack shows changes a snapshot here.
 */

const OPEN = "https://datalayer.ai/hosts/open?code=abc";
const WEB = "https://datalayer.ai";
const key = { appId: "A1", teamId: "T1" } as const;

const contracts = JSON.parse(
  readFileSync(new URL("./contracts/contracts.json", import.meta.url), "utf8"),
) as { presentation: { example: unknown } };
const example: ApprovalPresentation = presentationSchema.parse(
  contracts.presentation.example,
);

function turn(...events: SemanticEvent[]): TurnPresentation {
  const presentation = new TurnPresentation();
  for (const event of events) presentation.apply(event);
  return presentation;
}

const answer =
  "Option B is safer.\n\n| Option | Risk |\n|---|---|\n| A | High |\n| B | Low |\n\nSee [the review](https://datalayer.ai/notes).";

const MESSAGES = {
  "a running answer with Stop": turn(
    { kind: "text", text: "Comparing the two options" },
    { id: "c1", kind: "tool", name: "search", status: "running" },
  ).message(OPEN, {
    runId: "t1",
    stopValue: JSON.stringify({ e: "Ev1", r: "t1", s: "S1" }),
  }),
  "a finished answer with a table and sources": turn(
    { kind: "text", text: answer },
    { kind: "completion" },
  ).message(OPEN, { threadMenu: true }),
  "a finished answer in noisy mode": turn(
    { id: "c1", kind: "tool", name: "search", status: "complete" },
    { id: "c2", kind: "tool", name: "read_file", status: "failed" },
    { kind: "text", text: "Done." },
    { kind: "completion" },
  ).message(OPEN, { events: "noisy", threadMenu: true }),
  "a streamed answer's stop blocks": turn(
    { kind: "text", text: answer },
    { kind: "completion" },
  ).message(OPEN, { streamed: true, threadMenu: true }),
  "a failed turn": turn(
    { kind: "text", text: "Starting" },
    { kind: "error", message: "The connection to Datalayer was interrupted." },
  ).message(OPEN, { threadMenu: true }),
  "a stopped turn": turn({ kind: "stop" }).message(OPEN, { threadMenu: true }),
  "a text question in a channel": turn({
    kind: "ask",
    question: { kind: "text", prompt: "Which quarter?" },
  }).message(OPEN, { askValue: "Ev1" }),
  "a text question in a direct message": turn({
    kind: "ask",
    question: { kind: "text", prompt: "Which quarter?" },
  }).message(OPEN, { askValue: "Ev1", direct: true }),
  "a choice question": turn({
    kind: "ask",
    question: { kind: "choice", options: ["Q1", "Q2"], prompt: "Which?" },
  }).message(OPEN, { askValue: "Ev1" }),
  "a form answered in Datalayer": turn({
    kind: "ask",
    question: { kind: "form", prompt: "Fill in the filing" },
  }).message(OPEN, { askValue: "Ev1" }),
  "an approval card that offers the decision": approvalCard(example, {
    appName: "Desk",
    deploymentUid: "dep-1",
    reviewUrl: OPEN,
  }),
  "an approval card reviewed in Datalayer only": approvalCard(
    {
      ...example,
      action_class: "delete",
      host_may_decide: false,
      reasons: ["A delete is decided in Datalayer."],
      secret_fields: ["/token"],
    },
    { appName: "Desk", deploymentUid: "dep-1", reviewUrl: OPEN },
  ),
  "an approved card": decidedCard({
    decidedBySlackUserId: "U1",
    reviewUrl: OPEN,
    status: "approved",
    toolName: "send_email",
  }),
  "an expired card": decidedCard({
    reviewUrl: OPEN,
    status: "expired",
    toolName: "send_email",
  }),
  "the channel's waiting line": waitingLine("U1", "send_email"),
} as const;

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
      name: "Desk",
    },
  ]);
  return store;
}

describe("Block Kit snapshots and limits (S-406)", () => {
  for (const [name, message] of Object.entries(MESSAGES))
    it(`${name}: within Slack's limits, with a plain-text fallback`, () => {
      expect(messageProblems(message)).toEqual([]);
      expect(message).toMatchSnapshot();
    });

  it("the application selector, in a channel and as a switch", async () => {
    const store = await storeWithApplications();
    const routing = new TurnRouting(store, new FakeLinks(), WEB);
    const allowances = await store.getAllowances(key);
    const channel = routing.selector(allowances, {
      channelId: "C1",
      eventId: "Ev1",
    });
    const switching = routing.selector(
      allowances,
      { channelId: "D1", eventId: "Ev1" },
      { channelId: "D1", threadTs: "1.0" },
    );
    for (const message of [channel, switching]) {
      expect(messageProblems(message)).toEqual([]);
      expect(message).toMatchSnapshot();
    }
  });

  it("the confirmation modals", () => {
    const metadata = {
      a: "ap-1",
      app: "A1",
      approve: false,
      d: "sha256:abc",
      p: "dep-1",
      team: "T1",
    };
    for (const modal of [
      confirmModal({ ...metadata, approve: true }, "send_email"),
      confirmModal(metadata, "send_email"),
    ]) {
      expect(surfaceProblems(modal)).toEqual([]);
      expect(modal).toMatchSnapshot();
    }
  });

  it("App Home, connected and not", async () => {
    const store = await storeWithApplications();
    const connected = await homeView(store, key, "U1", WEB, new FakeLinks(), {
      limit: 30,
      used: 3,
      window: "hour",
    });
    const unlinked = await homeView(
      store,
      key,
      "U9",
      WEB,
      new FakeLinks(new Map(), "https://datalayer.ai/hosts/link?code=one"),
    );
    for (const view of [connected, unlinked]) {
      expect(surfaceProblems(view)).toEqual([]);
      expect(view).toMatchSnapshot();
    }
  });
});

describe("the Block Kit check itself (S-406)", () => {
  it("finds what Slack would refuse or a screen reader would miss", () => {
    expect(
      blockKitProblems([
        { type: "image", image_url: "https://datalayer.ai/a.png" },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "x",
              text: { type: "plain_text", text: "y".repeat(76) },
              url: "http://datalayer.ai",
            },
          ],
        },
        { type: "section", text: { type: "mrkdwn", text: "z".repeat(3_001) } },
        { type: "rich_text" },
      ]),
    ).toEqual([
      "block 0 (image): an image without alt text",
      `block 1 (actions): button text over ${BLOCK_KIT.buttonText}`,
      "block 1 (actions): a button url that is not https",
      `block 2 (section): section text over ${BLOCK_KIT.sectionText}`,
      "block 3 (rich_text): a block type Slack may not know",
    ]);
    expect(messageProblems({ blocks: [], text: " " })).toEqual([
      "no plain-text fallback (text) for notifications and screen readers",
    ]);
    expect(
      blockKitProblems(Array.from({ length: 51 }, () => ({ type: "divider" }))),
    ).toEqual(["51 blocks, over 50"]);
  });
});
