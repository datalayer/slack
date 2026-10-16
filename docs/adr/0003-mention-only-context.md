# ADR 0003: Mention-only context by default, thread context optional and off

- **Status:** accepted on 7 October 2026 (plan §2.1, §6.3). Recorded on
  16 October 2026 (S-002).

## Context

Some Slack agents read the surrounding channel or thread. That is useful, but
it changes the data boundary: an organization's Slack history would flow into
model prompts and Datalayer records, under retention rules the workspace
did not choose.

## Decision

1. **Baseline:** the service receives only the triggering `app_mention` or
   Messages-tab `message.im`, and the messages it posted itself. The bot scopes
   are exactly `app_mentions:read`, `chat:write` and `im:history`. There is no
   `chat:write.public`, no user scope, no `channels:history` and no
   `files:*`. `test/operations.test.ts` holds this.
2. **Optional thread context** (S-401, S-402) is a separate manifest variant
   with granular history scopes and a reauthorization. A workspace admin turns
   it on (`DATALAYER_SLACK_THREAD_CONTEXT`, off by default). When on, it calls
   only `conversations.replies` for the invoked thread, shows _Using N messages
   from this thread_ with an inspect action, keeps provenance, and enforces
   retention.
3. **Slack Connect and shared channels fail closed** in v1.

## Rejected alternatives

- **Context on by default.** It would read messages that nobody addressed to
  Datalayer. Slack's guidelines and the plan's rule 1 ("the mention is an
  invocation, not surveillance") forbid it.
- **`search:read` or bulk history ingestion.** These are disproportionate, and
  they cannot be scoped to the thread that was invoked.
- **Fetching context with a user token.** That would be impersonation through
  user tokens, which the plan rules out.

## Consequences

- Answers can miss surrounding context. The answer says so when it matters,
  and the docs page explains it.
- Channel message edits are not delivered under the baseline scopes (no
  `channels:history`), so S-209 handles edits only in direct messages.
- Turning on thread context is a reauthorization that admins see. It never
  happens silently in an update.
