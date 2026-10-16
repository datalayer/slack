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
VERSION ?= 0.1.5
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
# secrets go to the rc, and with SECRET=namespace/name the signing and client
# secrets also go to that Secret (kubectl's current context).
# make slack-app ENV=development | ENV=staging SECRET=datalayer-api/datalayer-slack-env
slack-app:
	@test -n "$(ENV)" || (echo "ENV=development|staging|production" && exit 1)
	npm run --silent slack-app -- $(ENV) $(if $(SECRET),--k8s-secret $(SECRET),)
