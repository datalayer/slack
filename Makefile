.PHONY: check dev-socket image push

# The image's tag: bump it for every push, never overwrite a pushed tag.
# 0.1.0 pushed 16 October 2026 from 997ad41; 0.1.1 from 698b44b (A-17, S-101).
# 0.1.2: SLACK round 2 — streaming bounds and fallback, 429s rejected and retried (S-206); the turn lock on a
#        thread's first turn, heartbeats and lease renewal (S-207); App Home's starters (S-104); Open in
#        Datalayer only through a handoff (S-305); dead letters (S-405); migrations 006–007.
# 0.1.3: on the shared host kit (agent-runtimes 1.5.46 lib/portable/hosts, DISCORD DC-004): one esbuild
#        bundle (dist/index.js, dist/migrate.js, dist/dead-letters.js); the migrate job is `node dist/migrate.js`.
# 0.1.4: on agent-runtimes 1.5.48 (S-302: a host decides mail only); the stream starts empty, tables and
#        replayed text streamed, entity-safe cuts, streaming on by default (S-206); assistant:write and the DM's
#        suggested prompts (S-104); users:read, guests and external people refused (S-209); files opened in the
#        conversation through the handoff (S-306). From 36c2be0 or later.
# 0.1.5: the Stop control for a streamed answer, the stopper named (S-205, S-206; migration 007 stopped_by);
#        every setting named DATALAYER_SLACK_* (the chart since helm 5f9c25f passes only those). From b13d5a5 or later.
# 0.1.6: Open in Datalayer mints a one-use handoff on each press, answer links held to HTTPS (S-306);
#        Datalayer's channel rules read before each prompt, replaced wholesale (S-403); each person's quiet
#        or noisy answers on the Home (S-308, migration 008); the dead-letter operator checked at IAM
#        (S-405, DATALAYER_OPERATOR_KEY); a span per turn with its session and run, exported as OTLP JSON
#        when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and DATALAYER_OTEL_API_KEY are set (S-101); an inbound event's
#        idempotency record (S-004, migration 009) on agent-runtimes 1.5.55's host contracts (bind_session).
#        From abcdb6d or later.
# 0.1.7: the production app's origin slack.datalayer.run (7f1ba31); dead letters behind their own database
#        role, off until the chart's slack.databaseRoles (S-405: migration 010's database_role on the audit,
#        migrations/roles/ applied by `migrate --roles` as slack_owner, the dead-letters bin refusing the
#        service's role). From the S-405 commit or later.
# 0.1.8: Slack's own Stop on a streamed answer (S-206): agent_session_stopped subscribed and handled, the
#        thread's running turn stopped as the presser; a stream Slack ended is written whole by chat.update.
# 0.1.9: a Slack app the person brings (decided 28 October 2026): POST /slack/apps/install from the Ship card
#        (app id, signing secret, bot token; checked with auth.test and bots.info, bound at Datalayer as a
#        custom installation), its events at /slack/apps/<app_id>/events verified with its own secret and
#        handed to a second Bolt app authorized from the store (migration 011, slack_custom_apps).
# 0.1.10: the bind asserts the provider — Datalayer's own app binds as `datalayer`, a custom app as `custom` with
#        its app id (agent-runtimes 1.5.88's portable hosts client; ai-agents 0.0.94 refuses a bind without it).
VERSION ?= 0.1.10
REGISTRY ?= $(DATALAYER_DOCKER_REGISTRY)
EXPORT := $(HOME)/.cache/slack-export-$(shell git rev-parse --short HEAD)

# Built from a clean export of HEAD (git archive), never the working tree.
image:
	@test -n "$(REGISTRY)" || { echo "DATALAYER_DOCKER_REGISTRY is not set." >&2; exit 1; }
	@if docker manifest inspect $(REGISTRY)/slack:$(VERSION) >/dev/null 2>&1; then \
		echo "slack:$(VERSION) is already pushed: bump VERSION." >&2; exit 1; fi
	rm -rf $(EXPORT) && mkdir -p $(EXPORT)
	git archive HEAD | tar -x -C $(EXPORT)
	docker build -t $(REGISTRY)/slack:$(VERSION) $(EXPORT)

push:
	docker push $(REGISTRY)/slack:$(VERSION)
	docker manifest inspect $(REGISTRY)/slack:$(VERSION) >/dev/null

check:
	npm run check

dev-socket:
	@test -n "$$DATALAYER_API_KEY" || { \
		echo "DATALAYER_API_KEY is not set. Export your development API key first." >&2; \
		exit 1; \
	}
	@DATALAYER_DEV_HOST_TOKEN="$$DATALAYER_API_KEY" npm run dev:socket

# Create or update a Slack app from manifests/<env>.yaml:
# rotates the configuration token in the prod1 rc first; on create, the ids and
# secrets go to the rc, and with DEPLOY=1 the app's ids, secrets and public
# origin also go to the r1 rc, which up.sh gives the chart on `p reup datalayer-slack`.
# make slack-app ENV=development | ENV=production DEPLOY=1
slack-app:
	@test -n "$(ENV)" || (echo "ENV=development|staging|production" && exit 1)
	npm run --silent slack-app -- $(ENV) $(if $(DEPLOY),--deploy,)
