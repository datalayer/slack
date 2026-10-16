import type { KnownBlock, ModalView } from "@slack/types";

import {
  hostMayDecide,
  renderApproval,
  type ApprovalPresentation,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

/** Slack's limits a card is measured against: a value is shown whole or not offered. */
export const SLACK_BLOCKS_PER_MESSAGE = 50;
export const SLACK_TEXT_PER_BLOCK = 3000;
/** Room kept for the card's own blocks around the values. */
const CARD_OWN_BLOCKS = 6;
const CHUNK = 2900;

export const APPROVE_ACTION = "datalayer_approval_approve";
export const DECLINE_ACTION = "datalayer_approval_decline";
export const REVIEW_ACTION = "datalayer_approval_review";
export const CONFIRM_VIEW = "datalayer_approval_confirm";
export const NOTE_BLOCK = "datalayer_approval_note";
export const NOTE_ACTION = "note";

/** What a decision button carries: the approval, the digest shown, its deployment. */
export type ApprovalButtonValue = Readonly<{
  a: string;
  d: string;
  p: string;
}>;

/** What the confirmation modal carries back on submit (`private_metadata`). */
export type ConfirmMetadata = ApprovalButtonValue &
  Readonly<{
    app: string;
    approve: boolean;
    ent?: string;
    team: string;
  }>;

export type ApprovalCardMessage = Readonly<{
  blocks: KnownBlock[];
  /** Whether it offers Approve and Decline: only a whole, decidable action. */
  offersDecision: boolean;
  text: string;
}>;

const plain = (text: string) => ({ type: "plain_text" as const, text });

/** Escape what Slack's mrkdwn would read as markup in text that is not ours. */
export function mrkdwnEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A value cut into blocks of Slack's size, each whole: nothing is dropped. */
export function chunksOf(value: string): string[] {
  if (!value) return ["(empty)"];
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += CHUNK)
    chunks.push(value.slice(start, start + CHUNK));
  return chunks;
}

/** What is shown of an action: its display-safe fields, else its complete arguments. */
export function shownFields(
  presentation: ApprovalPresentation,
): Array<{ label: string; value: string }> {
  if (presentation.fields.length > 0)
    return presentation.fields.map(({ label, value }) => ({ label, value }));
  const keys = Object.keys(presentation.arguments);
  return keys.length === 0
    ? []
    : [
        {
          label: "Arguments",
          value: JSON.stringify(presentation.arguments, null, 2),
        },
      ];
}

const ACTION_WORDS: Record<ApprovalPresentation["action_class"], string> = {
  delete: "delete something",
  execute: "run something",
  financial: "move money",
  publish: "publish something",
  read: "read something",
  send: "send something",
  unknown: "use a tool",
  write: "change something",
};

/**
 * An approval as a Block Kit card (plans/SLACK.md §3.4, S-302): who asks,
 * what, and every material value whole — a value longer than a block is
 * continued in the next, never cut. *Approve* and *Decline* are offered only
 * when the server says a host may decide it (`hostMayDecide`) and every
 * value fits a Slack message; otherwise the card says why and offers only
 * *Review in Datalayer*.
 */
export function approvalCard(
  presentation: ApprovalPresentation,
  context: Readonly<{
    appName: string;
    deploymentUid: string;
    reviewUrl: string;
  }>,
): ApprovalCardMessage {
  const app = context.appName || "Your application";
  const headline = `${app} wants to ${ACTION_WORDS[presentation.action_class]}: ${presentation.tool_name}`;
  // The renderer that knows the tool proves every argument is shown (S-302).
  const typed = renderApproval(presentation);
  const shown =
    typed.fields.length > 0 ? typed.fields : shownFields(presentation);
  const valueBlocks: KnownBlock[] = [];
  for (const field of shown) {
    valueBlocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${mrkdwnEscape(field.label)}*` },
    });
    for (const chunk of chunksOf(field.value))
      valueBlocks.push({ type: "section", text: plain(chunk) });
  }
  const fits = valueBlocks.length + CARD_OWN_BLOCKS <= SLACK_BLOCKS_PER_MESSAGE;
  const offersDecision = fits && hostMayDecide(presentation) && typed.complete;
  const why: string[] = [...typed.reasons.map(mrkdwnEscape)];
  if (!fits)
    why.push(
      "It is too long to show whole in Slack: read it whole in Datalayer before deciding.",
    );
  if (presentation.secret_fields.length > 0)
    why.push(
      `Withheld from Slack: ${presentation.secret_fields.map(mrkdwnEscape).join(", ")}.`,
    );
  if (!hostMayDecide(presentation))
    why.push(
      ...(presentation.reasons.length > 0
        ? presentation.reasons.map(mrkdwnEscape)
        : ["It is decided in Datalayer."]),
    );
  const asked = presentation.created_at
    ? `Asked ${presentation.created_at}`
    : "Asked now";
  const blocks: KnownBlock[] = [
    { type: "header", text: plain(headline.slice(0, 150)) },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: mrkdwnEscape(
            `${asked}${presentation.expires_at ? ` · expires ${presentation.expires_at}` : ""} · ${presentation.action_class}`,
          ),
        },
      ],
    },
    ...(fits
      ? valueBlocks
      : [
          {
            type: "section" as const,
            text: plain(
              shown.map((field) => field.label).join(", ") ||
                presentation.tool_name,
            ),
          },
        ]),
  ];
  if (why.length > 0)
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: why.join(" ") }],
    });
  const value: ApprovalButtonValue = {
    a: presentation.approval_id,
    d: presentation.digest,
    p: context.deploymentUid,
  };
  blocks.push({
    type: "actions",
    block_id: `approval:${presentation.approval_id}`,
    elements: [
      ...(offersDecision
        ? [
            {
              type: "button" as const,
              action_id: APPROVE_ACTION,
              style: "primary" as const,
              text: plain("Approve"),
              value: JSON.stringify(value),
            },
            {
              type: "button" as const,
              action_id: DECLINE_ACTION,
              style: "danger" as const,
              text: plain("Decline"),
              value: JSON.stringify(value),
            },
          ]
        : []),
      {
        type: "button" as const,
        action_id: REVIEW_ACTION,
        text: plain("Review in Datalayer"),
        url: context.reviewUrl,
      },
    ],
  });
  return { blocks, offersDecision, text: headline };
}

const OUTCOME_WORDS: Record<string, string> = {
  approved: "Approved",
  expired: "Expired",
  rejected: "Declined",
};

/** A decided card: its outcome, and no buttons on any terminal state (§3.4). */
export function decidedCard(input: {
  decidedBySlackUserId?: string;
  reviewUrl: string;
  status: string;
  toolName: string;
}): { blocks: KnownBlock[]; text: string } {
  const outcome = OUTCOME_WORDS[input.status] ?? "Already decided";
  const by =
    input.decidedBySlackUserId && input.status !== "expired"
      ? ` by <@${input.decidedBySlackUserId}>`
      : input.status === "expired"
        ? ""
        : " in Datalayer";
  const text = `${outcome}${by}: ${mrkdwnEscape(input.toolName)}`;
  return {
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `<${input.reviewUrl}|Open in Datalayer>` },
        ],
      },
    ],
    text,
  };
}

/** What a channel thread shows while its approval is decided privately (§3.4). */
export function waitingLine(
  slackUserId: string,
  toolName: string,
): {
  text: string;
} {
  return {
    text: `Waiting for <@${slackUserId}>'s decision on ${mrkdwnEscape(toolName)}: it was sent to them privately.`,
  };
}

/** The confirmation a decision opens: Approve or Decline, once, as you; a reason for a decline. */
export function confirmModal(
  metadata: ConfirmMetadata,
  toolName: string,
): ModalView {
  const verb = metadata.approve ? "Approve" : "Decline";
  return {
    type: "modal",
    callback_id: CONFIRM_VIEW,
    private_metadata: JSON.stringify(metadata),
    title: plain(`${verb}?`),
    submit: plain(verb),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: metadata.approve
            ? `Approve *${mrkdwnEscape(toolName)}* exactly as the card shows it. It is decided once, as you, and recorded in Datalayer.`
            : `Decline *${mrkdwnEscape(toolName)}*. It is decided once, as you, and recorded in Datalayer.`,
        },
      },
      ...(metadata.approve
        ? []
        : [
            {
              type: "input" as const,
              block_id: NOTE_BLOCK,
              optional: true,
              label: plain("Why (optional)"),
              element: {
                type: "plain_text_input" as const,
                action_id: NOTE_ACTION,
                max_length: 1000,
                multiline: true,
              },
            },
          ]),
    ],
  };
}

/** A button's value, read back; anything else is refused. */
export function buttonValueOf(raw: string | undefined): ApprovalButtonValue {
  const parsed = JSON.parse(raw ?? "") as Partial<ApprovalButtonValue>;
  if (
    typeof parsed.a !== "string" ||
    typeof parsed.p !== "string" ||
    typeof parsed.d !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.d)
  )
    throw new Error("The approval button is not one of ours.");
  return { a: parsed.a, d: parsed.d, p: parsed.p };
}
