import { createRequire } from "node:module";

/**
 * The host contracts fixture, byte-identical to ai-agents'
 * `tests/fixtures/hosts/contracts.json`: read from the shared host kit
 * (`@datalayer/agent-runtimes/lib/portable/hosts`), which owns it since
 * DISCORD DC-004.
 */
export const CONTRACTS_PATH = createRequire(import.meta.url).resolve(
  "@datalayer/agent-runtimes/lib/portable/hosts/contracts.json",
);
