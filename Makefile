.PHONY: check dev-socket image push

# The image's tag: bump it for every push, never overwrite a pushed tag.
# 0.1.0 pushed 16 October 2026 from 997ad41 (plans/SLACK.md A-17, S-101).
VERSION ?= 0.1.0
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
