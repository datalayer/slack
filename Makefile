.PHONY: check dev-socket

check:
	npm run check

dev-socket:
	@test -n "$$DATALAYER_API_KEY" || { \
		echo "DATALAYER_API_KEY is not set. Export your development API key first." >&2; \
		exit 1; \
	}
	@DATALAYER_DEV_HOST_TOKEN="$$DATALAYER_API_KEY" npm run dev:socket
