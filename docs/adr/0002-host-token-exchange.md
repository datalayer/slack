# ADR 0002: Slack users as Datalayer principals, through the host-token exchange

- **Status:** accepted on 7 October 2026 (services 43a2bb58, slack cf14c74).
  Recorded on 16 October 2026 (S-002).
- **Box:** S-203.

## Context

A Slack bot token speaks for the workspace, not for the person who typed. A
Datalayer session, its rules and its approvals belong to a Datalayer
principal. The adapter has to:

- act as the linked person on every turn;
- hold no bearer token that works for everyone;
- stop working the moment a person unlinks, an owner disconnects or Slack
  uninstalls.

## Decision

1. **An installation is a Datalayer host.** The owner sets it up at ai-agents
   (`POST /apps/hosts`, the Ship → Slack card) with an allowlist of deployments
   and a default. The Bolt app binds it at the end of OAuth with a one-use code
   carried in the signed OAuth `state`. It receives a host key once
   (`dlhk_…`), keeps it encrypted, and ai-agents keeps it hashed.
2. **Each Slack user links their own identity.** App Home requests a one-use
   link code. The person signs in at the landing's `/hosts/link`, reads the
   preview and confirms. ai-agents is the record of who is linked
   (`…/self/links/{user}`). The adapter caches no authorization.
3. **Every turn and decision exchanges credentials.** The adapter sends
   `POST /apps/hosts/self/token` with the host key and the Slack user, and
   receives a fifteen-minute host token. Its `aud` is `datalayer:app:host`,
   `sub` is the person, `azp` is the installation, and it names one
   deployment and its link. If the deployment signs its users, the D-21 user
   token comes with it. Runtimes check the token at `GET /apps/hosts/whoami`.
4. **Revocation is server-side.** An owner's disconnect, an uninstall,
   person or host unlinks, a deployment removed from the allowlist and a
   takedown all end the links and bindings. A host token that rests on them is
   refused at its next door.

## Rejected alternatives

- **Storing a person's Datalayer bearer token in Slack's store.** One
  compromised row would act as the person everywhere, with no audience or
  expiry under the host's control.
- **One workspace secret as a universal user token.** The installation would
  become a super-user, and a stolen key would speak for every person.
- **The D-21 signed user only (ai-agents' first Slack app, e5fcfb9f).** It
  signed the Slack user id as `sub` with the deployment's user secret. The
  deployment saw a Slack id, never a Datalayer principal, so IAM could not
  authorize, and approvals could only be decided by the installer.
- **Trusting `team_id` and `user` from action payloads.** They are
  untrusted input. Only the signed request's ids are used, and the decision
  call re-reads the approval as the person who pressed.

## Consequences

- Every turn costs one exchange round trip. It is not cached across turns, so
  revocation stays immediate.
- A workspace bound before the Ship card existed (development) uses
  `DATALAYER_HOST_KEY`, which configuration refuses outside development.
- Other hosts (VS Code, desktop, an embed's server) use the same routes.
