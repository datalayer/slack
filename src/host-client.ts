import { z } from "zod";

import {
  bindSchema,
  decisionSchema,
  deliveryOfOutbox,
  HOST_KEY_HEADER,
  linkCodeSchema,
  linkStateSchema,
  presentationSchema,
  webhookSchema,
  type ApprovalPresentation,
  type HostDelivery,
} from "./host-contracts.js";

/** What ai-agents refused, with its status and its sentence. */
export class HostRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly what: string,
  ) {
    super(`${what} (${status}): ${detail}`);
  }
}

export type BoundHost = Readonly<{
  defaultDeployment?: string;
  hostKey: string;
  hostUid: string;
  name?: string;
}>;

/**
 * The generic host routes of ai-agents (plans/SLACK.md §4.3) the adapter
 * calls besides the credential exchange: as the installation, with its key in
 * `X-Datalayer-Host-Key`, or as a person, with the host token the exchange
 * answered. Nothing here is Slack's: any host speaks them.
 */
export class DatalayerHostClient {
  constructor(
    readonly apiUrl: string,
    readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  #url(path: string): string {
    return `${this.apiUrl}/api/ai-agents/v1${path}`;
  }

  async #call<T>(
    what: string,
    path: string,
    init: { body?: unknown; hostKey?: string; method?: string; token?: string },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.hostKey) headers[HOST_KEY_HEADER] = init.hostKey;
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const response = await this.fetchImplementation(this.#url(path), {
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers,
      method: init.method ?? "GET",
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok || body.success === false)
      throw new HostRefusedError(
        response.status,
        typeof body.detail === "string" ? body.detail : "refused",
        what,
      );
    return schema.parse(body);
  }

  /** Bind the installation its owner set up, with the code their browser carried (§3.1). */
  async bind(input: {
    code: string;
    externalId: string;
    name?: string;
  }): Promise<BoundHost> {
    const bound = await this.#call(
      "Datalayer did not bind the installation",
      "/apps/hosts/bind",
      {
        body: {
          code: input.code,
          external_id: input.externalId,
          name: input.name ?? "",
        },
        method: "POST",
      },
      bindSchema,
    );
    return {
      defaultDeployment: bound.host.default_deployment || undefined,
      hostKey: bound.host_key,
      hostUid: bound.host.uid,
      name: bound.host.name,
    };
  }

  /** The installation was uninstalled from Slack: it ends at Datalayer (revocation). */
  async uninstalled(hostKey: string): Promise<void> {
    await this.#call(
      "Datalayer did not end the installation",
      "/apps/hosts/self",
      { hostKey, method: "DELETE" },
      z.unknown(),
    );
  }

  /** A one-use code a Slack user redeems, signed in to Datalayer, to link their account. */
  async linkCode(
    hostKey: string,
    externalUserId: string,
    externalUserName = "",
  ): Promise<{ code: string; expiresIn: number }> {
    const answered = await this.#call(
      "Datalayer did not answer a link code",
      "/apps/hosts/self/link-codes",
      {
        body: {
          external_user_id: externalUserId,
          external_user_name: externalUserName,
        },
        hostKey,
        method: "POST",
      },
      linkCodeSchema,
    );
    return { code: answered.code, expiresIn: answered.expires_in };
  }

  /** Whether a Slack user is linked, and to which principal. */
  async linkState(
    hostKey: string,
    externalUserId: string,
  ): Promise<{ linked: boolean; principalUid?: string }> {
    const state = await this.#call(
      "Datalayer did not say whether the account is linked",
      `/apps/hosts/self/links/${encodeURIComponent(externalUserId)}`,
      { hostKey },
      linkStateSchema,
    );
    return { linked: state.linked, principalUid: state.principal_uid };
  }

  /** Where deliveries are pushed: answered the secret they are signed with, once. */
  async setWebhook(
    hostKey: string,
    url: string,
  ): Promise<{ signingSecret: string; version: number }> {
    const hook = await this.#call(
      "Datalayer did not register the delivery address",
      "/apps/hosts/self/delivery",
      {
        body: {
          events: ["approval.requested", "approval.decided", "turn.completed"],
          url,
        },
        hostKey,
        method: "PUT",
      },
      webhookSchema,
    );
    return { signingSecret: hook.signing_secret, version: hook.version };
  }

  /** What the installation has not acknowledged, oldest first: pushed or not. */
  async outbox(hostKey: string, limit = 100): Promise<HostDelivery[]> {
    const listed = await this.#call(
      "Datalayer did not answer the outbox",
      `/apps/hosts/self/deliveries?limit=${limit}`,
      { hostKey },
      z.object({ deliveries: z.array(z.unknown()) }),
    );
    return listed.deliveries.map(deliveryOfOutbox);
  }

  async acknowledge(hostKey: string, deliveryUid: string): Promise<void> {
    await this.#call(
      "Datalayer did not take the acknowledgement",
      `/apps/hosts/self/deliveries/${encodeURIComponent(deliveryUid)}/ack`,
      { hostKey, method: "POST" },
      z.unknown(),
    );
  }

  /** How an approval is shown, read as the person it waits on (their host token). */
  async presentation(
    token: string,
    approvalId: string,
  ): Promise<ApprovalPresentation> {
    const answered = await this.#call(
      "Datalayer did not answer the approval",
      `/tool-approvals/${encodeURIComponent(approvalId)}/presentation`,
      { token },
      z.object({ presentation: presentationSchema }),
    );
    return answered.presentation;
  }

  /** Decide an approval as its person, on the very presentation shown (its digest). */
  async decide(
    token: string,
    approvalId: string,
    decision: { approve: boolean; digest: string; note?: string },
  ): Promise<{ status: string }> {
    const answered = await this.#call(
      "Datalayer did not take the decision",
      `/apps/hosts/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
        body: {
          approve: decision.approve,
          digest: decision.digest,
          note: decision.note || null,
        },
        method: "POST",
        token,
      },
      decisionSchema,
    );
    return { status: answered.approval.status };
  }
}
