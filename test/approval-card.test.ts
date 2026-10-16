import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  APPROVE_ACTION,
  approvalCard,
  buttonValueOf,
  confirmModal,
  DECLINE_ACTION,
  decidedCard,
  NOTE_BLOCK,
  REVIEW_ACTION,
  SLACK_TEXT_PER_BLOCK,
} from "../src/approval-card.js";
import {
  presentationSchema,
  type ApprovalPresentation,
} from "../src/host-contracts.js";

const contracts = JSON.parse(
  readFileSync(new URL("./contracts/contracts.json", import.meta.url), "utf8"),
) as { presentation: { example: unknown } };

const example = presentationSchema.parse(contracts.presentation.example);
const context = {
  appName: "Desk",
  deploymentUid: "dep-1",
  reviewUrl: "https://datalayer.ai/tool-approvals",
};

const texts = (card: { blocks: unknown[] }) => JSON.stringify(card.blocks);
const actionIds = (card: { blocks: unknown[] }) =>
  (
    card.blocks as Array<{
      elements?: Array<{ action_id: string }>;
      type: string;
    }>
  )
    .filter((block) => block.type === "actions")
    .flatMap((block) => (block.elements ?? []).map((e) => e.action_id));

type Shown = { text?: { text: string; type: string }; type: string };

describe("The approval card", () => {
  it("shows the complete action from the server's presentation and offers the decision", () => {
    const card = approvalCard(example, context);
    expect(card.offersDecision).toBe(true);
    expect(card.text).toBe("Desk wants to send something: send_email");
    for (const field of example.fields) {
      expect(texts(card)).toContain(field.label);
      expect(texts(card)).toContain(field.value);
    }
    expect(actionIds(card)).toEqual([
      APPROVE_ACTION,
      DECLINE_ACTION,
      REVIEW_ACTION,
    ]);
    const approve = card.blocks.at(-1) as {
      elements: Array<{ value?: string }>;
    };
    expect(buttonValueOf(approve.elements[0]?.value)).toEqual({
      a: "ap-1",
      d: example.digest,
      p: "dep-1",
    });
  });

  it("continues a long value in the next block, never cutting it", () => {
    const body = "x".repeat(SLACK_TEXT_PER_BLOCK * 2 + 17);
    const long: ApprovalPresentation = {
      ...example,
      arguments: { ...example.arguments, body },
      fields: [{ name: "body", label: "Body", value: body }],
    };
    const card = approvalCard(long, context);
    const blocks = card.blocks as unknown as Shown[];
    const shown = blocks
      .filter(
        (block) =>
          block.type === "section" && block.text?.type === "plain_text",
      )
      .map((block) => block.text?.text ?? "")
      .join("");
    // Every value whole, the body continued over blocks, never cut.
    expect(shown).toContain(body);
    expect(shown).toContain("release@example.com");
    for (const block of blocks)
      if (block.text)
        expect(block.text.text.length).toBeLessThanOrEqual(
          SLACK_TEXT_PER_BLOCK,
        );
    expect(card.offersDecision).toBe(true);
  });

  it("offers only Review in Datalayer when it cannot be shown whole in Slack", () => {
    const huge: ApprovalPresentation = {
      ...example,
      arguments: { ...example.arguments, body: "y".repeat(2900 * 60) },
      fields: [{ name: "body", label: "Body", value: "y".repeat(2900 * 60) }],
    };
    const card = approvalCard(huge, context);
    expect(card.offersDecision).toBe(false);
    expect(actionIds(card)).toEqual([REVIEW_ACTION]);
    expect(texts(card)).toContain("too long to show whole in Slack");
    expect(texts(card)).not.toContain("y".repeat(100));
  });

  it("offers only Review in Datalayer when the server says a host may not decide", () => {
    const card = approvalCard(
      {
        ...example,
        action_class: "delete",
        host_may_decide: false,
        reasons: ["A delete is decided in Datalayer."],
        secret_fields: ["/token"],
      },
      context,
    );
    expect(card.offersDecision).toBe(false);
    expect(actionIds(card)).toEqual([REVIEW_ACTION]);
    expect(texts(card)).toContain("A delete is decided in Datalayer.");
    expect(texts(card)).toContain("Withheld from Slack: /token");
  });

  it("shows the outcome without buttons once decided", () => {
    const approved = decidedCard({
      decidedBySlackUserId: "U0ALICE",
      reviewUrl: context.reviewUrl,
      status: "approved",
      toolName: "send_email",
    });
    expect(approved.text).toBe("Approved by <@U0ALICE>: send_email");
    expect(JSON.stringify(approved.blocks)).not.toContain("button");
    expect(
      decidedCard({ reviewUrl: "", status: "rejected", toolName: "t" }).text,
    ).toBe("Declined in Datalayer: t");
    expect(
      decidedCard({ reviewUrl: "", status: "expired", toolName: "t" }).text,
    ).toBe("Expired: t");
  });

  it("confirms in a modal, with a reason only for a decline", () => {
    const metadata = {
      a: "ap-1",
      app: "A1",
      approve: false,
      d: example.digest,
      p: "dep-1",
      team: "T1",
    };
    const decline = confirmModal(metadata, "send_email");
    expect(JSON.parse(decline.private_metadata ?? "")).toEqual(metadata);
    expect(JSON.stringify(decline.blocks)).toContain(NOTE_BLOCK);
    expect(
      JSON.stringify(
        confirmModal({ ...metadata, approve: true }, "send_email").blocks,
      ),
    ).not.toContain(NOTE_BLOCK);
  });

  it("refuses a button value that is not one of ours", () => {
    expect(() =>
      buttonValueOf('{"a":"ap-1","d":"short","p":"dep-1"}'),
    ).toThrow();
    expect(() => buttonValueOf("not json")).toThrow();
  });
});
