import {
  hostMayDecide,
  hostSessionOf,
  HostRefusedError,
  lastAnswer,
  receiveDelivery,
  type DatalayerHostClient,
  type DeliveryJob,
  type DeliverySink,
  type HostDelivery,
  type HostExchange,
  type HostKeyCredentials,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { z } from "zod";

import {
  approvalCard,
  decidedCard,
  waitingLine,
  type ConfirmMetadata,
} from "./approval-card.js";
import type {
  SlackInstallation,
  SlackInstallationKey,
  ThreadKey,
} from "./domain.js";
import {
  openValueOf,
  safeHttpsUrl,
  SLACK_MEMBER_ID,
  TurnPresentation,
  type OpenValue,
} from "./presentation.js";
import type { SlackMessage, SlackPort } from "./slack-port.js";
import type { SlackStore } from "./store.js";

/**
 * Where a delivery belongs in Slack: the target the adapter gave when it
 * mapped the session to its thread (`PUT /apps/hosts/sessions/{uid}`), handed
 * back verbatim with every delivery. `userId` is the Slack user the session's
 * host token speaks for: the one an approval waits on.
 */
export const targetSchema = z.object({
  appId: z.string().min(1),
  channelId: z.string().min(1),
  enterpriseId: z.string().optional(),
  teamId: z.string().min(1),
  threadTs: z.string().min(1),
  userId: z.string().min(1),
});
export type DeliveryTarget = z.infer<typeof targetSchema>;

/** The Slack store, as the shared deliveries read it. */
export function deliverySinkOf(store: SlackStore): DeliverySink {
  return {
    boundHosts: async () =>
      (await store.listBoundInstallations()).flatMap((one) =>
        one.datalayerHostKey && one.datalayerHostUid
          ? [{ hostKey: one.datalayerHostKey, hostUid: one.datalayerHostUid }]
          : [],
      ),
    deliverySecretOf: async (hostUid) =>
      (await store.getInstallationByHostUid(hostUid))?.deliverySecret,
    hostKeyOf: async (hostUid) =>
      (await store.getInstallationByHostUid(hostUid))?.datalayerHostKey,
  };
}

/** A direct message's channel: an approval there is shown in the thread itself. */
const isDirect = (channelId: string): boolean => channelId.startsWith("D");

/** The URL button of a fresh *Open in Datalayer* link: Slack sends its click, acknowledged. */
export const OPEN_LINK_ACTION = "datalayer_open_link";

/** What a press of *Open in Datalayer* came to (S-306). */
export type OpenOutcome = "opened" | "not-yours" | "not-here" | "refused";

/** What a press that made no link says, privately, to whoever pressed. */
export const OPEN_WORDS = {
  notHere:
    "This conversation is no longer in this thread. Open the application in Datalayer, where its conversations are kept.",
  notYours: (owner?: string) =>
    `This is ${owner ? `<@${owner}>'s` : "another person's"} conversation: only they can open it in Datalayer. Mention @Datalayer to start your own.`,
  refused: (detail: string) => `Datalayer did not make the link: ${detail}`,
} as const;

/** What a decision from Slack came to, said privately to the person who pressed. */
export type DecisionOutcome =
  | "decided"
  | "changed"
  | "already-decided"
  | "not-yours"
  | "not-here"
  | "not-linked";

/**
 * Datalayer's deliveries to this host (S-301 to S-304):
 * an approval asked in a session mapped to a Slack thread becomes a
 * card — in the thread of a direct message, or privately to its person with
 * only a waiting line in a channel thread; a decision taken anywhere updates
 * every card of it; a finished turn finishes the thread's status. Each
 * delivery is handled once (claimed by its uid), then acknowledged.
 */
export class DeliveryHandler {
  constructor(
    readonly store: SlackStore,
    readonly client: DatalayerHostClient,
    readonly credentials: HostKeyCredentials<ThreadKey>,
    readonly slack: SlackPort,
    readonly webUrl: string,
    readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  get reviewUrl(): string {
    return `${this.webUrl.replace(/\/+$/, "")}/tool-approvals`;
  }

  /** Handle one delivery of an installation once, then acknowledge it at Datalayer. */
  async receive(job: DeliveryJob): Promise<void> {
    await receiveDelivery(job, {
      claims: this.store,
      client: this.client,
      handle: async (delivery) => {
        const installation = await this.store.getInstallationByHostUid(
          job.hostUid,
        );
        if (installation) await this.handle(installation, delivery);
      },
      sink: deliverySinkOf(this.store),
    });
  }

  async handle(
    installation: SlackInstallation,
    delivery: HostDelivery,
  ): Promise<void> {
    const target = targetSchema.safeParse(delivery.payload.target);
    // A target this adapter did not give, or another workspace's: nothing to show.
    if (
      !target.success ||
      target.data.appId !== installation.appId ||
      target.data.teamId !== installation.teamId ||
      (target.data.enterpriseId ?? undefined) !== installation.enterpriseId
    )
      return;
    switch (delivery.event) {
      case "approval.requested":
        return this.#requested(installation, target.data, delivery.payload);
      case "approval.decided":
        return this.#decided(installation, delivery.payload);
      case "turn.completed":
        return this.#completed(installation, target.data, delivery.payload);
    }
  }

  async #session(
    installation: SlackInstallation,
    externalUserId: string,
    deploymentUid: string,
  ) {
    if (!installation.datalayerHostKey)
      throw new Error("The installation holds no host key.");
    return this.credentials.exchangeFor({
      deploymentUid,
      externalUserId,
      hostKey: installation.datalayerHostKey,
    });
  }

  async #requested(
    installation: SlackInstallation,
    target: DeliveryTarget,
    payload: { approval_id: string; deployment_uid: string; tool_name: string },
  ): Promise<void> {
    if (
      (await this.store.getApprovalCards(installation, payload.approval_id))
        .length > 0
    )
      return;
    const exchanged = await this.#session(
      installation,
      target.userId,
      payload.deployment_uid,
    );
    const presentation = await this.client.presentation(
      exchanged.access_token,
      payload.approval_id,
    );
    // *Review in Datalayer* opens this very approval, for its person, once (S-305).
    const opened = await this.client.handoff(
      exchanged.access_token,
      "approval",
      payload.approval_id,
    );
    const card = approvalCard(presentation, {
      appName: exchanged.deployment.app_name,
      deploymentUid: payload.deployment_uid,
      reviewUrl: `${this.webUrl.replace(/\/+$/, "")}${opened.path}`,
    });
    const common = {
      appId: installation.appId,
      approvalId: payload.approval_id,
      deploymentUid: payload.deployment_uid,
      enterpriseId: installation.enterpriseId,
      slackUserId: target.userId,
      teamId: installation.teamId,
      toolName: presentation.tool_name,
    };
    const thread = {
      appId: installation.appId,
      channelId: target.channelId,
      enterpriseId: installation.enterpriseId,
      teamId: installation.teamId,
      threadTs: target.threadTs,
    };
    if (isDirect(target.channelId)) {
      const ts = await this.slack.postThread(thread, card);
      await this.store.putApprovalCard({
        ...common,
        channelId: target.channelId,
        kind: "card",
        messageTs: ts,
        threadTs: target.threadTs,
      });
      return;
    }
    // A channel: the arguments go to their person only (S-303).
    const direct = await this.slack.postDirect(
      installation,
      target.userId,
      card,
    );
    await this.store.putApprovalCard({
      ...common,
      channelId: direct.channelId,
      kind: "card",
      messageTs: direct.ts,
    });
    const waiting = await this.slack.postThread(
      thread,
      waitingLine(target.userId, presentation.tool_name),
    );
    await this.store.putApprovalCard({
      ...common,
      channelId: target.channelId,
      kind: "waiting",
      messageTs: waiting,
      threadTs: target.threadTs,
    });
  }

  async #decided(
    installation: SlackInstallation,
    payload: { approval_id: string; status: string },
  ): Promise<void> {
    await this.#finishCards(installation, payload.approval_id, payload.status);
  }

  /** Every card of an approval, decided: its outcome and no buttons. */
  async #finishCards(
    key: SlackInstallationKey,
    approvalId: string,
    status: string,
    decidedBySlackUserId?: string,
  ): Promise<void> {
    for (const card of await this.store.getApprovalCards(key, approvalId)) {
      const by = decidedBySlackUserId ?? card.decidedBySlackUserId;
      if (decidedBySlackUserId)
        await this.store.putApprovalCard({ ...card, decidedBySlackUserId });
      await this.slack.updateMessage(
        {
          ...key,
          channelId: card.channelId,
          threadTs: card.threadTs ?? card.messageTs,
        },
        card.messageTs,
        decidedCard({
          decidedBySlackUserId: by,
          reviewUrl: this.reviewUrl,
          status,
          toolName: card.toolName,
        }),
      );
    }
  }

  async #completed(
    installation: SlackInstallation,
    target: DeliveryTarget,
    payload: { deployment_uid: string; session_uid: string },
  ): Promise<void> {
    const thread = {
      appId: installation.appId,
      channelId: target.channelId,
      enterpriseId: installation.enterpriseId,
      teamId: installation.teamId,
      threadTs: target.threadTs,
    };
    const binding = await this.store.getThread(thread);
    if (!binding?.pendingMessageTs || binding.sessionId !== payload.session_uid)
      return; // its answer was already shown as it streamed
    const exchanged = await this.#session(
      installation,
      target.userId,
      payload.deployment_uid,
    );
    const host = hostSessionOf(exchanged);
    const text = await lastAnswer(
      this.fetchImplementation,
      host,
      payload.session_uid,
    );
    // Shown as a streamed turn's answer is, with its *Open in Datalayer*:
    // each press mints its own one-use handoff for this person (S-306).
    const answer = new TurnPresentation();
    answer.apply({
      kind: "completion",
      text: text || "Finished in Datalayer.",
    });
    await this.slack.updateMessage(
      thread,
      binding.pendingMessageTs,
      answer.message(openValueOf(payload.session_uid, target.userId), {
        direct: isDirect(thread.channelId),
        threadMenu: true,
      }),
    );
    await this.store.putThread({
      ...binding,
      pendingMessageTs: undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * *Open in Datalayer* pressed (S-306): a one-use handoff minted for this
   * press, as the person who pressed (their own host token), only when they
   * are the person whose conversation it is; said privately — an ephemeral
   * message in a channel, a reply in their direct message — as a link button.
   */
  async open(
    thread: ThreadKey,
    value: OpenValue,
    slackUserId: string,
  ): Promise<OpenOutcome> {
    const say = async (message: SlackMessage): Promise<void> => {
      if (isDirect(thread.channelId))
        await this.slack.postThread(thread, message);
      else await this.slack.postPrivate(thread, slackUserId, message);
    };
    const owner = SLACK_MEMBER_ID.test(value.u) ? value.u : undefined;
    if (slackUserId !== value.u) {
      await say({ text: OPEN_WORDS.notYours(owner) });
      return "not-yours";
    }
    const installation = await this.store.getInstallation(thread);
    const binding = [
      await this.store.getThread(thread),
      ...(await this.store.getArchivedThreads(thread)),
    ].find((one) => one?.sessionId === value.s);
    if (!installation?.datalayerHostKey || !binding) {
      await say({ text: OPEN_WORDS.notHere });
      return "not-here";
    }
    let exchanged: HostExchange;
    try {
      exchanged = await this.#session(
        installation,
        slackUserId,
        binding.applicationId,
      );
    } catch (error) {
      if (!(error instanceof HostRefusedError) || error.status >= 500)
        throw error;
      await say({ text: OPEN_WORDS.refused(error.detail) });
      return "refused";
    }
    // Datalayer's word on who pressed: the session's own person, or no link.
    if (exchanged.principal_uid !== binding.openedByPrincipalId) {
      await say({ text: OPEN_WORDS.notYours(owner) });
      return "not-yours";
    }
    const opened = await this.client.handoff(
      exchanged.access_token,
      "session",
      value.s,
    );
    const url = safeHttpsUrl(
      `${this.webUrl.replace(/\/+$/, "")}${opened.path}`,
    );
    if (!url) throw new Error("The handoff's address is not an HTTPS address.");
    const minutes = Math.max(1, Math.round(opened.expiresIn / 60));
    const words = `A new link to this conversation, for you only: it opens once, within ${minutes} minute${minutes === 1 ? "" : "s"}. Press *Open in Datalayer* again for another.`;
    await say({
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: words } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: OPEN_LINK_ACTION,
              style: "primary",
              text: { type: "plain_text", text: "Open in Datalayer" },
              url,
            },
          ],
        },
      ],
      text: words,
    });
    return "opened";
  }

  /**
   * A decision confirmed in Slack (S-304): the approval read again as the
   * person who pressed — exchanged for their own host token, so a click by
   * anyone else decides nothing — and decided only when it is still the very
   * presentation the card showed, pending, and one a host may decide.
   */
  async decide(input: {
    metadata: ConfirmMetadata;
    note?: string;
    slackUserId: string;
  }): Promise<DecisionOutcome> {
    const key: SlackInstallationKey = {
      appId: input.metadata.app,
      enterpriseId: input.metadata.ent,
      teamId: input.metadata.team,
    };
    const installation = await this.store.getInstallation(key);
    if (!installation?.datalayerHostKey || installation.status !== "active")
      return "not-here";
    const cards = await this.store.getApprovalCards(key, input.metadata.a);
    if (cards.length === 0) return "not-here";
    let token: string;
    try {
      token = (
        await this.#session(installation, input.slackUserId, input.metadata.p)
      ).access_token;
    } catch {
      return "not-linked";
    }
    let presentation;
    try {
      presentation = await this.client.presentation(token, input.metadata.a);
    } catch (error) {
      if (error instanceof HostRefusedError && error.status === 404)
        return "not-yours";
      throw error;
    }
    if (presentation.status !== "pending") {
      await this.#finishCards(key, input.metadata.a, presentation.status);
      return "already-decided";
    }
    if (
      presentation.digest !== input.metadata.d ||
      !hostMayDecide(presentation)
    )
      return "changed";
    try {
      const decided = await this.client.decide(token, input.metadata.a, {
        approve: input.metadata.approve,
        digest: input.metadata.d,
        note: input.note,
      });
      await this.#finishCards(
        key,
        input.metadata.a,
        decided.status,
        input.slackUserId,
      );
      return "decided";
    } catch (error) {
      if (error instanceof HostRefusedError) {
        if (error.status === 404) return "not-yours";
        if (error.status === 409) return "changed";
        if (error.status === 403) return "changed";
      }
      throw error;
    }
  }
}

/** What the person who pressed is told privately, when their decision was not taken. */
export const DECISION_WORDS: Record<
  Exclude<DecisionOutcome, "decided">,
  string
> = {
  "already-decided": "This approval was already decided: the card shows how.",
  changed:
    "This approval is no longer the one the card showed: review it in Datalayer.",
  "not-here": "This approval is no longer shown here: review it in Datalayer.",
  "not-linked":
    "Connect your Datalayer account from @Datalayer's Home before deciding from Slack.",
  "not-yours": "Only the person this approval waits on decides it.",
};
