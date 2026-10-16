import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  APPROVE_ACTION,
  approvalCard,
  REVIEW_ACTION,
} from "../src/approval-card.js";
import {
  presentationSchema,
  renderApproval,
  type ApprovalPresentation,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { CONTRACTS_PATH } from "./support/contracts.js";

const contracts = JSON.parse(readFileSync(CONTRACTS_PATH, "utf8")) as {
  presentation: { example: unknown };
};
const example = presentationSchema.parse(contracts.presentation.example);
const context = {
  appName: "Desk",
  deploymentUid: "dep-1",
  reviewUrl: "https://datalayer.ai/hosts/open?code=dlho_x",
};

const of = (
  overrides: Partial<ApprovalPresentation>,
): ApprovalPresentation => ({ ...example, ...overrides });
const actions = (presentation: ApprovalPresentation) =>
  (
    approvalCard(presentation, context).blocks as Array<{
      type: string;
      elements?: Array<{ action_id: string }>;
    }>
  )
    .filter((block) => block.type === "actions")
    .flatMap((block) =>
      (block.elements ?? []).map((element) => element.action_id),
    );

describe("typed approval renderers (S-302)", () => {
  it("shows a mail whole — every recipient, the subject, the whole body — and lets it be decided", () => {
    const mail = of({
      arguments: {
        bcc: ["audit@example.com"],
        body: "We go with option B.\n\nRegards",
        cc: ["ops@example.com", "pm@example.com"],
        subject: "Launch decision",
        to: "release@example.com",
      },
    });
    const shown = renderApproval(mail);
    expect(shown.renderer).toBe("mail");
    expect(shown.fields).toEqual([
      { label: "To", value: "release@example.com" },
      { label: "Cc", value: "ops@example.com, pm@example.com" },
      { label: "Bcc", value: "audit@example.com" },
      { label: "Subject", value: "Launch decision" },
      { label: "Body", value: "We go with option B.\n\nRegards" },
    ]);
    expect(shown.complete).toBe(true);
    expect(actions(mail)).toContain(APPROVE_ACTION);
  });

  it("sends a mail with attachments, formatted mail, or one missing its parts, to Datalayer", () => {
    for (const args of [
      { ...example.arguments, attachments: ["q3.pdf"] },
      { ...example.arguments, html: "<p>B</p>" },
      { body: "x", to: "a@example.com" },
      { subject: "s", to: "a@example.com" },
    ]) {
      const presentation = of({ arguments: args });
      expect([args, renderApproval(presentation).complete]).toEqual([
        args,
        false,
      ]);
      expect(actions(presentation)).toEqual([REVIEW_ACTION]);
    }
    const attached = approvalCard(
      of({ arguments: { ...example.arguments, attachments: ["q3.pdf"] } }),
      context,
    );
    expect(JSON.stringify(attached.blocks)).toContain("Attachments");
    expect(JSON.stringify(attached.blocks)).toContain("reviewed in Datalayer");
  });

  it("fails closed on an argument the renderer does not know", () => {
    const sneaky = of({
      arguments: { ...example.arguments, forward_to: "attacker@example.com" },
    });
    const shown = renderApproval(sneaky);
    expect(shown.complete).toBe(false);
    expect(shown.reasons.join(" ")).toContain("forward_to");
    expect(actions(sneaky)).toEqual([REVIEW_ACTION]);
  });

  it.each([
    "read",
    "write",
    "delete",
    "publish",
    "financial",
    "execute",
    "unknown",
  ] as const)(
    "keeps a %s action to Datalayer, even when the server would let a host decide",
    (actionClass) => {
      const presentation = of({
        action_class: actionClass,
        tool_name: `${actionClass}_thing`,
      });
      expect(renderApproval(presentation)).toMatchObject({
        complete: false,
        renderer: "datalayer-only",
      });
      expect(actions(presentation)).toEqual([REVIEW_ACTION]);
    },
  );

  it("fails closed for a tool no renderer knows", () => {
    const odd = of({
      action_class: "send",
      arguments: { channel: "#x", text: "hi" },
      tool_name: "post_to_teams",
    });
    expect(renderApproval(odd)).toMatchObject({
      complete: false,
      renderer: "none",
    });
    expect(JSON.stringify(approvalCard(odd, context).blocks)).toContain(
      "no way yet to show post_to_teams whole",
    );
    expect(actions(odd)).toEqual([REVIEW_ACTION]);
  });

  it("decides mail only: a send that is not mail goes to Datalayer (§15, 5)", () => {
    const message = of({ tool_name: "send_message" });
    expect(renderApproval(message).renderer).toBe("none");
    expect(actions(message)).toEqual([REVIEW_ACTION]);
  });
});
