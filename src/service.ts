import type { AgentClient } from "./agent-client.js";
import { StoreLinks, type AccountLinks } from "./host-installations.js";
import type {
  IncomingPrompt,
  SlackInstallationKey,
  ThreadKey,
} from "./domain.js";
import type { SlackPort } from "./slack-port.js";
import type { SlackStore } from "./store.js";
import { stripAppMention, TurnPresentation } from "./presentation.js";

export class SlackAgentService {
  constructor(
    readonly store: SlackStore,
    readonly agents: AgentClient,
    readonly slack: SlackPort,
    readonly webUrl: string,
    /** Who is linked, and how one connects: Datalayer's record, through the host key. */
    readonly links: AccountLinks = new StoreLinks(store),
  ) {}

  async handlePrompt(
    prompt: IncomingPrompt,
    botUserId?: string,
  ): Promise<void> {
    if (!(await this.store.claimEvent(prompt.eventId))) return;
    const installationKey: SlackInstallationKey = {
      appId: prompt.appId,
      enterpriseId: prompt.enterpriseId,
      teamId: prompt.teamId,
    };
    const installation = await this.store.getInstallation(installationKey);
    if (!installation || installation.status !== "active") return;

    const link = await this.links.linkOf(installationKey, prompt.userId);
    if (!link) {
      // No session starts before consent (§8): a one-use link to the
      // landing's confirm page, when the workspace is bound to Datalayer.
      const connect = await this.links.connectUrlOf(
        installationKey,
        prompt.userId,
      );
      await this.slack.postPrivate(installationKey, prompt.userId, {
        text: connect
          ? `Connect your Datalayer account before asking @Datalayer: <${connect}|Connect your Datalayer account> (the link works once, for ten minutes). How it works: ${this.webUrl}/docs/slack#install-and-connect`
          : `Connect your Datalayer account before asking @Datalayer: ${this.webUrl}/docs/slack#install-and-connect`,
      });
      return;
    }

    const applicationId =
      await this.store.getDefaultApplication(installationKey);
    if (!applicationId) {
      await this.slack.postPrivate(installationKey, prompt.userId, {
        text: `No default application is available. Ask a Datalayer owner to configure Slack: ${this.webUrl}/docs/slack#administration`,
      });
      return;
    }

    const text = stripAppMention(prompt.text, botUserId);
    if (!text) {
      await this.slack.postPrivate(installationKey, prompt.userId, {
        text: "Add a question after @Datalayer.",
      });
      return;
    }

    const existing = await this.store.getThread(prompt);
    const placeholderTs = await this.slack.postThread(prompt, {
      text: "_Working…_",
    });
    const turn = await this.agents.startTurn({
      applicationId,
      externalEventId: prompt.eventId,
      externalUserId: prompt.userId,
      principalId: link.principalId,
      prompt: text,
      provenance: prompt,
      sessionId: existing?.sessionId,
    });
    const binding = {
      applicationId,
      appId: prompt.appId,
      channelId: prompt.channelId,
      enterpriseId: prompt.enterpriseId,
      openedByPrincipalId: existing?.openedByPrincipalId ?? link.principalId,
      // Until the turn finishes, its status message waits for an answer: a
      // turn paused on an approval is finished by `turn.completed`.
      pendingMessageTs: placeholderTs,
      sessionId: turn.sessionId,
      teamId: prompt.teamId,
      threadTs: prompt.threadTs,
      updatedAt: new Date().toISOString(),
    };
    await this.store.putThread(binding);

    const presentation = new TurnPresentation();
    const openUrl = `${this.webUrl}/loop/session/${encodeURIComponent(turn.sessionId)}`;
    let lastPublishedAt = 0;
    let hasUnpublishedUpdate = false;
    try {
      for await (const update of turn.updates) {
        presentation.apply(update);
        hasUnpublishedUpdate = true;
        const now = Date.now();
        const terminal = update.kind === "complete" || update.kind === "error";
        if (terminal || now - lastPublishedAt >= 750) {
          await this.slack.updateMessage(
            prompt,
            placeholderTs,
            presentation.message(openUrl),
          );
          lastPublishedAt = now;
          hasUnpublishedUpdate = false;
        }
      }
      if (hasUnpublishedUpdate)
        await this.slack.updateMessage(
          prompt,
          placeholderTs,
          presentation.message(openUrl),
        );
      if (presentation.complete)
        await this.store.putThread({
          ...binding,
          pendingMessageTs: undefined,
          updatedAt: new Date().toISOString(),
        });
    } catch {
      presentation.apply({
        kind: "error",
        message: "The connection to Datalayer was interrupted.",
      });
      await this.slack.updateMessage(
        prompt,
        placeholderTs,
        presentation.message(openUrl),
      );
    }
  }
}

export function slackThreadKey(input: {
  appId: string;
  channel: string;
  enterpriseId?: string;
  teamId: string;
  threadTs?: string;
  ts: string;
}): ThreadKey {
  return {
    appId: input.appId,
    channelId: input.channel,
    enterpriseId: input.enterpriseId,
    teamId: input.teamId,
    threadTs: input.threadTs ?? input.ts,
  };
}
