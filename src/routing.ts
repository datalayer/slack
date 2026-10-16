import {
  resolveApplication,
  usableAllowances,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type { KnownBlock } from "@slack/types";

import type {
  AppAllowance,
  IncomingPrompt,
  SlackInstallationKey,
  ThreadBinding,
  ThreadKey,
} from "./domain.js";
import type { AccountLinks } from "./host-installations.js";
import { escapeSlack, slackLink } from "./presentation.js";
import type { SlackMessage, SlackPort } from "./slack-port.js";
import type { SlackStore } from "./store.js";

/** The application selector's action: one application chosen for the thread. */
export const SELECT_APPLICATION_ACTION = "datalayer_select_application";

/**
 * A selector option's value: the application, the held prompt's event, and
 * for *Use another application* the thread switched (`c`, `t`).
 */
export type SelectorValue = Readonly<{
  app: string;
  ev: string;
  sw?: boolean;
  c?: string;
  t?: string;
}>;

/** Why a turn did not start: each with its own private repair. */
export type Refusal =
  | "not-installed"
  | "external"
  | "guest"
  | "deactivated"
  | "not-linked"
  | "channel-denied"
  | "not-allowed"
  | "direct-only"
  | "no-application"
  | "no-access";

export type Resolved = Readonly<{
  principalId: string;
  applicationId: string;
  /** The thread's binding when the thread already has a session. */
  binding?: ThreadBinding;
  visibility: "channel" | "direct";
}>;

export type Resolution =
  | Readonly<{ ok: true; resolved: Resolved }>
  | Readonly<{ ok: false; refusal: Refusal; message?: SlackMessage }>;

const visibilityOf = (
  prompt: Pick<IncomingPrompt, "channelId">,
): "channel" | "direct" =>
  prompt.channelId.startsWith("D") ? "direct" : "channel";

/**
 * Resolve a Slack message to the person and application its turn runs as
 * (S-202): active installation → not a shared channel →
 * linked person → application (the thread's own, else an explicit choice,
 * else the channel's, else the workspace default) → the application allowed
 * here and in this kind of conversation. Datalayer's exchange then checks
 * the person may open it, at every turn; nothing here authorizes alone.
 */
export class TurnRouting {
  constructor(
    readonly store: SlackStore,
    readonly links: AccountLinks,
    readonly webUrl: string,
    /** Who a member is (`users.info`): guests and external people are refused (S-209). */
    readonly members: Pick<SlackPort, "memberOf">,
  ) {}

  async resolve(prompt: IncomingPrompt): Promise<Resolution> {
    const key: SlackInstallationKey = {
      appId: prompt.appId,
      enterpriseId: prompt.enterpriseId,
      teamId: prompt.teamId,
    };
    const installation = await this.store.getInstallation(key);
    if (!installation || installation.status !== "active")
      return { ok: false, refusal: "not-installed" };

    // Slack Connect and people of another workspace: identity is ambiguous,
    // so v1 fails closed.
    if (
      prompt.isExtShared ||
      // In an Enterprise Grid organization, a member of another of its
      // workspaces has another home team: users.info's enterprise id decides.
      (prompt.userTeamId &&
        prompt.userTeamId !== prompt.teamId &&
        prompt.enterpriseId === undefined)
    )
      return {
        ok: false,
        refusal: "external",
        message: {
          text: `@Datalayer does not answer in Slack Connect or shared channels yet. Ask it in a direct message or a channel of your own workspace. ${this.#docs("limits-and-availability")}`,
        },
      };

    // Guests (single- and multi-channel) and people of another organization
    // are refused by default (S-209, decided by the user 16 October 2026),
    // before anything is offered to them, a link included.
    const member = await this.members.memberOf(key, prompt.userId);
    // Deactivated in Slack: nothing is said, and the service unlinks (S-103).
    if (member.deactivated) return { ok: false, refusal: "deactivated" };
    if (member.external)
      return {
        ok: false,
        refusal: "external",
        message: {
          text: `@Datalayer does not answer people of another organization yet. ${this.#docs("limits-and-availability")}`,
        },
      };
    if (member.guest)
      return {
        ok: false,
        refusal: "guest",
        message: {
          text: `@Datalayer does not answer guests of this workspace yet. ${this.#docs("limits-and-availability")}`,
        },
      };

    const link = await this.links.linkOf(key, prompt.userId);
    if (!link) {
      const connect = await this.links.connectUrlOf(key, prompt.userId);
      return {
        ok: false,
        refusal: "not-linked",
        message: {
          text: connect
            ? `Connect your Datalayer account before asking @Datalayer: <${connect}|Connect your Datalayer account> (the link works once, for ten minutes). How it works: ${this.webUrl}/docs/slack#install-and-connect`
            : `Connect your Datalayer account before asking @Datalayer: ${this.webUrl}/docs/slack#install-and-connect`,
        },
      };
    }

    const visibility = visibilityOf(prompt);
    const allowances = await this.store.getAllowances(key);
    const binding = await this.store.getThread(prompt);
    // The shared order (DISCORD DC-004): the thread's own (switching is
    // explicit, S-208), the choice, the next session's, the channel's, the
    // workspace default; then allowed here and in this kind of conversation.
    const resolution = await resolveApplication({
      allowances,
      channel: () => this.store.getChannelBinding(key, prompt.channelId),
      defaultApplication: () => this.store.getDefaultApplication(key),
      explicit: prompt.applicationId,
      next: () => this.store.getNextApplication(prompt),
      threadApplication: binding?.applicationId,
      visibility,
    });
    if (!resolution.ok)
      switch (resolution.refusal) {
        case "channel-denied":
          return {
            ok: false,
            refusal: "channel-denied",
            message: {
              text: `@Datalayer is turned off in this channel by your Datalayer administrator. Ask it in a direct message instead. ${this.#docs("administration")}`,
            },
          };
        case "no-application":
          return {
            ok: false,
            refusal: "no-application",
            message: this.selector(allowances, prompt),
          };
        case "not-allowed":
          return {
            ok: false,
            refusal: "not-allowed",
            message: {
              text: `That application is no longer available from Slack in this workspace. ${this.#docs("administration")}`,
            },
          };
        case "direct-only":
          return {
            ok: false,
            refusal: "direct-only",
            message: {
              text: `${escapeSlack(resolution.allowance?.name ?? "This application")} answers only in a direct message with @Datalayer. Open @Datalayer's Messages tab and ask there.`,
            },
          };
      }
    const applicationId = resolution.applicationId;

    return {
      ok: true,
      resolved: {
        applicationId,
        binding,
        principalId: link.principalId,
        visibility,
      },
    };
  }

  /** The private selector over the applications the installation allows (S-208). */
  selector(
    allowances: readonly AppAllowance[],
    prompt: Pick<IncomingPrompt, "channelId" | "eventId">,
    /**
     * *Use another application* (S-208): the thread switched, carried in each
     * option's value. The selector is sent privately (an ephemeral or a direct
     * message), whose press names no thread of its own.
     */
    switching?: Pick<ThreadKey, "channelId" | "threadTs">,
  ): SlackMessage {
    const usable = usableAllowances(allowances, visibilityOf(prompt));
    if (usable.length === 0)
      return {
        text: `No application is available from Slack here yet. Ask a Datalayer owner to choose one from the application's Ship tab. ${this.#docs("administration")}`,
      };
    const blocks: KnownBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: switching
            ? "Which application should answer next in this thread? A new session opens; the earlier one stays in Datalayer."
            : "Which application should answer in this thread?",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "static_select",
            action_id: SELECT_APPLICATION_ACTION,
            placeholder: { type: "plain_text", text: "Choose an application" },
            options: usable.slice(0, 100).map((one) => ({
              text: {
                type: "plain_text" as const,
                text: one.name.slice(0, 75),
              },
              value: JSON.stringify(
                switching
                  ? {
                      app: one.applicationId,
                      ev: "",
                      sw: true,
                      c: switching.channelId,
                      t: switching.threadTs,
                    }
                  : { app: one.applicationId, ev: prompt.eventId },
              ),
            })),
          },
        ],
      },
    ];
    return {
      blocks,
      text: "Choose the application that answers in this thread.",
    };
  }

  /**
   * The thread a pressed *Use another application* option switches: the one
   * its value names, in the channel it was pressed in. Anything else names no
   * thread, and the switch is refused.
   */
  static switchedThread(
    key: SlackInstallationKey,
    value: SelectorValue,
    pressedChannelId: string | undefined,
  ): ThreadKey | undefined {
    if (!value.sw || !value.c || !value.t) return undefined;
    if (pressedChannelId && pressedChannelId !== value.c) return undefined;
    return { ...key, channelId: value.c, threadTs: value.t };
  }

  #docs(anchor: string): string {
    return slackLink(`${this.webUrl}/docs/slack#${anchor}`, "Read the guide");
  }
}
