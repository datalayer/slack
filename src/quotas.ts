/**
 * Quotas before costly work (plans/SLACK.md §9, S-404): questions an hour per
 * person, workspace, organization and application, taken atomically before a
 * turn starts at Datalayer. A refusal says which limit and when it resets.
 */

export type QuotaScope = "user" | "workspace" | "organization" | "application";

export type QuotaLimits = Readonly<Record<QuotaScope, number>>;

export const DEFAULT_QUOTAS: QuotaLimits = {
  application: 600,
  organization: 2_000,
  user: 60,
  workspace: 600,
};

export type QuotaEntry = Readonly<{
  scope: QuotaScope;
  key: string;
  limit: number;
}>;

export type QuotaTaken =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; scope: QuotaScope; limit: number; resetsAt: Date }>;

/** The hour a moment falls in: the window counts are kept by. */
export function windowOf(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export function resetOf(now: Date): Date {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/** What each quota counts, for one turn. */
export function quotaEntries(
  limits: QuotaLimits,
  turn: {
    installation: string;
    slackUserId: string;
    applicationId: string;
    organizationId?: string;
  },
): QuotaEntry[] {
  return [
    {
      key: `user:${turn.installation}:${turn.slackUserId}`,
      limit: limits.user,
      scope: "user",
    },
    {
      key: `workspace:${turn.installation}`,
      limit: limits.workspace,
      scope: "workspace",
    },
    ...(turn.organizationId
      ? [
          {
            key: `organization:${turn.organizationId}`,
            limit: limits.organization,
            scope: "organization" as const,
          },
        ]
      : []),
    {
      key: `application:${turn.applicationId}`,
      limit: limits.application,
      scope: "application",
    },
  ];
}

/** Words for a refusal, said privately. */
export function quotaWords(taken: Extract<QuotaTaken, { ok: false }>): string {
  const whose: Record<QuotaScope, string> = {
    application: "this application",
    organization: "your organization",
    user: "you",
    workspace: "this workspace",
  };
  const at = taken.resetsAt.toISOString().slice(11, 16);
  return `@Datalayer has answered ${taken.limit} questions this hour for ${whose[taken.scope]}, its limit. Ask again after ${at} UTC.`;
}
