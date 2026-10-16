import {
  DEFAULT_QUOTAS,
  noTracer,
  usableAllowances,
  userQuotaKey,
  windowOf,
  type DeliveryJob,
  type Tracer,
  type WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { DeliveryHandler } from "./deliveries.js";
import type {
  IncomingPrompt,
  SlackInstallationKey,
  StarterSource,
  ThreadKey,
} from "./domain.js";
import { homeView } from "./home.js";
import { traceAttributes } from "./observability.js";
import type { HostInstallations } from "./host-installations.js";
import { escapeSlack } from "./presentation.js";
import type { SelectorValue } from "./routing.js";
import type { SlackAgentService, StopValue } from "./service.js";

/** What the queue carries: each kind of durable work. */
export type SlackJob =
  | Readonly<{ kind?: "prompt"; botUserId?: string; prompt: IncomingPrompt }>
  | DeliveryJob
  | Readonly<{ kind: "home"; key: SlackInstallationKey; userId: string }>
  | Readonly<{ kind: "edited"; prompt: IncomingPrompt; originalTs: string }>
  | Readonly<{
      kind: "deleted";
      thread: ThreadKey;
      userId?: string;
      deletedTs: string;
    }>
  | Readonly<{ kind: "assistant"; thread: ThreadKey; userId: string }>;

/** How many starters the direct message suggests: Slack shows four. */
export const SUGGESTED_PROMPTS = 4;

/** What App Home says to a guest or a person of another organization (S-209). */
export const NOT_A_MEMBER_HOME =
  "@Datalayer answers only full members of this workspace. Guests and people of another organization cannot use it yet.";

export const SEND_EDITED_ACTION = "datalayer_send_edited";

/**
 * The work behind the acknowledgement (§7.2): each job of the durable queue,
 * and each action once acknowledged. Business rules stay here, outside the
 * Bolt listeners, so fixtures drive them.
 */
export class SlackWorker {
  constructor(
    readonly service: SlackAgentService,
    readonly queue: WorkQueue<SlackJob>,
    readonly parts: Readonly<{
      deliveries?: DeliveryHandler;
      hosts?: HostInstallations;
      publishHome?: (
        key: SlackInstallationKey,
        userId: string,
        view: unknown,
      ) => Promise<void>;
      /** Where App Home reads the default application's starters (S-104). */
      starters?: StarterSource;
      /** One span per job, its ids pseudonymous (§12.2). */
      tracer?: Tracer;
    }> = {},
  ) {}

  get store() {
    return this.service.store;
  }

  async handle(job: SlackJob): Promise<void> {
    const tracer = this.parts.tracer ?? noTracer;
    const kind = "delivery" in job ? "delivery" : (job.kind ?? "prompt");
    const key =
      "delivery" in job
        ? undefined
        : "prompt" in job
          ? job.prompt
          : "key" in job
            ? job.key
            : job.thread;
    await tracer.span(
      `slack.job.${kind}`,
      key ? traceAttributes(key) : {},
      () => this.#handle(job),
    );
  }

  async #handle(job: SlackJob): Promise<void> {
    if ("delivery" in job) {
      await this.parts.deliveries?.receive(job);
      return;
    }
    switch (job.kind) {
      case "home":
        await this.home(job.key, job.userId);
        return;
      case "edited":
        await this.edited(job.prompt, job.originalTs);
        return;
      case "deleted":
        await this.deleted(job.thread, job.deletedTs, job.userId);
        return;
      case "assistant":
        await this.assistant(job.thread, job.userId);
        return;
      default:
        await this.service.handlePrompt(job.prompt, job.botUserId);
    }
  }

  /** Publish a person's Home, the allowlist read from Datalayer first. */
  async home(key: SlackInstallationKey, userId: string): Promise<void> {
    const installation = await this.store.getInstallation(key);
    if (!installation || installation.status !== "active") return;
    // A guest or a person of another organization is offered nothing, not
    // even a link (S-209).
    const member = await this.service.slack.memberOf(key, userId);
    if (member.guest || member.external) {
      await this.parts.publishHome?.(key, userId, {
        type: "home",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: NOT_A_MEMBER_HOME },
          },
        ],
      });
      return;
    }
    await this.parts.hosts?.refreshAllowances(key).catch(() => undefined);
    const limits = this.service.options.quotas ?? DEFAULT_QUOTAS;
    const used = await this.store.quotaUsed(
      userQuotaKey(
        `${key.appId}:${key.enterpriseId ?? "-"}:${key.teamId}`,
        userId,
      ),
      windowOf(new Date()),
    );
    const view = await homeView(
      this.store,
      key,
      userId,
      this.service.webUrl,
      this.service.links,
      { limit: limits.user, used, window: "hour" },
      this.parts.starters,
    );
    await this.parts.publishHome?.(key, userId, view);
  }

  /**
   * A direct-message thread opened in @Datalayer's Agent surface (S-104,
   * `assistant_thread_started`): its suggested prompts are the default
   * application's starters, read as this person. A guest, a person of
   * another organization, someone not connected, or no default usable in a
   * direct message gets none; their first message says why.
   */
  async assistant(thread: ThreadKey, userId: string): Promise<void> {
    const starters = this.parts.starters;
    if (!starters) return;
    const installation = await this.store.getInstallation(thread);
    if (!installation || installation.status !== "active") return;
    const member = await this.service.slack.memberOf(thread, userId);
    if (member.guest || member.external) return;
    if (!(await this.service.links.linkOf(thread, userId))) return;
    const [applicationId, allowances] = await Promise.all([
      this.store.getDefaultApplication(thread),
      this.store.getAllowances(thread),
    ]);
    const allowance = usableAllowances(allowances, "direct").find(
      (one) => one.applicationId === applicationId,
    );
    if (!applicationId || !allowance) return;
    const suggested = await starters
      .startersOf(thread, userId, applicationId)
      .catch((error: unknown) => {
        // App Home says the starters cannot be read; the thread opens without them.
        this.service.logger.warn("assistant.starters_unread", {
          error_name: error instanceof Error ? error.name : "unknown",
        });
        return undefined;
      });
    if (!suggested) return;
    const prompts = suggested.slice(0, SUGGESTED_PROMPTS).map((one) => ({
      message: one.message.slice(0, 2_000),
      title: one.label.slice(0, 75),
    }));
    if (prompts.length === 0) return;
    await this.service.slack.suggestPrompts(
      thread,
      `Try asking ${allowance.name}`.slice(0, 150),
      prompts,
    );
  }

  /**
   * An edited direct message (S-209): what was sent stays sent; the person
   * is offered *Send edited text as a new turn*, which only they can press.
   */
  async edited(prompt: IncomingPrompt, originalTs: string): Promise<void> {
    const installation = await this.store.getInstallation(prompt);
    if (!installation || installation.status !== "active") return;
    await this.store.holdPrompt(prompt);
    await this.service.privately(prompt, prompt.userId, {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "You edited a message @Datalayer already received. Datalayer keeps what was sent; your edit was not sent.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: SEND_EDITED_ACTION,
              text: {
                type: "plain_text",
                text: "Send edited text as a new turn",
              },
              value: JSON.stringify({ ev: prompt.eventId, ts: originalTs }),
            },
          ],
        },
      ],
      text: "Your edit was not sent. Send the edited text as a new turn?",
    });
  }

  /** A deleted direct message (S-209): the record stays in Datalayer; the person is told. */
  async deleted(
    thread: ThreadKey,
    _deletedTs: string,
    userId?: string,
  ): Promise<void> {
    if (!userId) return;
    const installation = await this.store.getInstallation(thread);
    if (!installation || installation.status !== "active") return;
    const binding = await this.store.getThread(thread);
    if (!binding) return;
    await this.service.privately(thread, userId, {
      text: `Deleting a message in Slack does not delete it from Datalayer: the session's record keeps it. To delete it there, see ${this.service.webUrl}/docs/slack#administration`,
    });
  }

  /** *Send edited text as a new turn*: only its person, once. */
  async sendEdited(
    key: SlackInstallationKey,
    value: { ev: string },
    slackUserId: string,
    actionTs: string,
  ): Promise<boolean> {
    const held = await this.store.takeHeldPrompt(key, value.ev, slackUserId);
    if (!held) return false;
    await this.queue.enqueue(
      { prompt: { ...held, eventId: `edit:${value.ev}:${actionTs}` } },
      `edit:${value.ev}`,
    );
    return true;
  }

  /** The selector's choice (S-208): the held prompt runs with that application, for its person only. */
  async selected(
    key: SlackInstallationKey,
    value: SelectorValue,
    slackUserId: string,
    thread?: ThreadKey,
  ): Promise<"started" | "switched" | "refused"> {
    const allowances = await this.store.getAllowances(key);
    if (
      !allowances.some((one) => one.applicationId === value.app && one.enabled)
    )
      return "refused";
    if (value.sw && thread) {
      const switched = await this.switchApplication(
        thread,
        slackUserId,
        value.app,
      );
      return switched ? "switched" : "refused";
    }
    const held = await this.store.takeHeldPrompt(key, value.ev, slackUserId);
    if (!held) return "refused";
    await this.queue.enqueue(
      { prompt: { ...held, applicationId: value.app } },
      `select:${value.ev}`,
    );
    return "started";
  }

  /**
   * *Start over* and *Use another application* (S-208): only a linked person
   * who opened the thread's session; the old binding is archived, never
   * reused, and the next mention opens a new session — the thread's agent
   * never changes silently.
   */
  async startOver(
    thread: ThreadKey,
    slackUserId: string,
    reason = "start-over",
  ): Promise<boolean> {
    const binding = await this.store.getThread(thread);
    if (!binding) return false;
    const link = await this.service.links.linkOf(thread, slackUserId);
    if (!link || link.principalId !== binding.openedByPrincipalId) return false;
    const turn = await this.store.getTurn(thread);
    if (turn?.state === "running") return false;
    await this.store.archiveThread(binding, reason);
    await this.store.deleteThread(thread);
    return true;
  }

  async switchApplication(
    thread: ThreadKey,
    slackUserId: string,
    applicationId: string,
  ): Promise<boolean> {
    if (!(await this.startOver(thread, slackUserId, "another-application")))
      return false;
    await this.store.setNextApplication(thread, applicationId);
    const name =
      (await this.store.getAllowances(thread)).find(
        (one) => one.applicationId === applicationId,
      )?.name ?? applicationId;
    await this.service.slack.postThread(thread, {
      text: `The next @Datalayer message in this thread opens a new session with ${escapeSlack(name)}. The earlier session stays in Datalayer.`,
    });
    return true;
  }

  async stop(
    thread: ThreadKey,
    value: StopValue,
    slackUserId: string,
  ): Promise<void> {
    const outcome = await this.service.stop(thread, value, slackUserId);
    if (outcome === "not-running")
      await this.service.privately(thread, slackUserId, {
        text: "That answer is not running any more.",
      });
    if (outcome === "not-linked")
      await this.service.privately(thread, slackUserId, {
        text: `Connect your Datalayer account to stop an answer: ${this.service.webUrl}/docs/slack#install-and-connect`,
      });
  }

  /** A choice answered from its buttons: sent as the presser's own turn in the thread. */
  /**
   * A choice pressed: the presser's own turn, once per asking event (S-307).
   * Whoever presses first answers; another click, option or person is
   * `false` and sends nothing.
   */
  async answered(
    thread: ThreadKey,
    answer: Readonly<{ option: string; askedBy: string }>,
    slackUserId: string,
  ): Promise<boolean> {
    return this.queue.enqueue(
      {
        prompt: {
          ...thread,
          eventId: `ask:${thread.threadTs}:${answer.askedBy}`,
          text: answer.option,
          userId: slackUserId,
        },
      },
      `ask:${thread.channelId}:${thread.threadTs}:${answer.askedBy}`,
    );
  }

  async unlink(key: SlackInstallationKey, slackUserId: string): Promise<void> {
    const ended = await this.service.links.unlink?.(key, slackUserId);
    this.service.logger.audit("identity.unlinked", {
      installation: `${key.appId}:${key.enterpriseId ?? "-"}:${key.teamId}`,
      reason: ended ? "person" : "not-linked",
      user: slackUserId,
    });
    await this.home(key, slackUserId);
  }
}
