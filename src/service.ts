import type { AgentClient } from "./agent-client.js";
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

    const link = await this.store.getUserLink(installationKey, prompt.userId);
    if (!link || link.status !== "active") {
      await this.slack.postPrivate(installationKey, prompt.userId, {
        text: `Connect your Datalayer account before asking @Datalayer: ${this.webUrl}/docs/slack#install-and-connect`,
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
      principalId: link.datalayerPrincipalId,
      prompt: text,
      provenance: prompt,
      sessionId: existing?.sessionId,
    });
    await this.store.putThread({
      applicationId,
      appId: prompt.appId,
      channelId: prompt.channelId,
      enterpriseId: prompt.enterpriseId,
      openedByPrincipalId: link.datalayerPrincipalId,
      sessionId: turn.sessionId,
      teamId: prompt.teamId,
      threadTs: prompt.threadTs,
      updatedAt: new Date().toISOString(),
    });

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
