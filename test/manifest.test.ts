import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BOT_SCOPES } from "../src/bolt.js";
import {
  drift,
  ENVIRONMENT_NAMES,
  MANIFEST_BOT_EVENTS,
  MANIFEST_BOT_SCOPES,
  render,
  validate,
} from "../scripts/manifest.js";

const root = new URL("../", import.meta.url);
const committed = (name: string) =>
  readFile(new URL(`manifests/${name}.yaml`, root), "utf8");

/** A scratch copy of the template and the manifests, for drift cases. */
const scratches: string[] = [];
async function scratch(): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), "slack-manifest-"));
  scratches.push(dir);
  await cp(
    new URL("app-manifest.template.yaml", root),
    join(dir, "app-manifest.template.yaml"),
  );
  await cp(new URL("manifests", root), join(dir, "manifests"), {
    recursive: true,
  });
  return pathToFileURL(`${dir}/`);
}
afterEach(async () => {
  for (const dir of scratches.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("the manifests as code (S-006, S-107)", () => {
  it("asks OAuth for the same scopes the manifests grant", () => {
    expect([...MANIFEST_BOT_SCOPES]).toEqual(BOT_SCOPES);
  });

  it("adds only the two scopes the user decided to the baseline (S-104, S-209)", () => {
    expect(
      BOT_SCOPES.filter(
        (scope) =>
          !["app_mentions:read", "chat:write", "im:history"].includes(scope),
      ),
    ).toEqual(["assistant:write", "users:read"]);
  });

  it.each(ENVIRONMENT_NAMES)(
    "%s parses to exactly its five scopes, its seven events, the Agent surface and its own URLs",
    async (name) => {
      const manifest = validate(await committed(name), name);
      expect(manifest.oauth_config.scopes).toEqual({
        bot: [...MANIFEST_BOT_SCOPES],
      });
      expect(manifest.settings.event_subscriptions.bot_events).toEqual([
        ...MANIFEST_BOT_EVENTS,
      ]);
      expect(manifest.features.assistant_view.assistant_description).toMatch(
        /suggested prompts/,
      );
      expect(manifest.settings.socket_mode_enabled).toBe(
        name === "development",
      );
      expect(manifest.settings.token_rotation_enabled).toBe(
        name !== "development",
      );
    },
  );

  it("the committed manifests are in step with the template", async () => {
    await expect(drift(root)).resolves.toEqual([]);
  });

  it("fails drift when scopes move out of oauth_config, whitespace aside", async () => {
    const dir = await scratch();
    const path = new URL("manifests/production.yaml", dir);
    const text = await readFile(path, "utf8");
    // Dedent the scopes block to the top level: the same words, another tree.
    const moved = text.replace(
      /\n {2}scopes:\n {4}bot:\n((?: {6}- .+\n)+)/,
      (_all, items: string) =>
        `\nscopes:\n  bot:\n${items.replace(/^ {6}/gm, "    ")}`,
    );
    expect(moved).not.toBe(text);
    await writeFile(path, moved);
    const problems = await drift(dir);
    expect(problems.join("\n")).toContain("differs from the template");
    expect(problems.join("\n")).toMatch(/production manifest is not valid/);
  });

  it("fails drift when token rotation leaves settings", async () => {
    const dir = await scratch();
    const path = new URL("manifests/production.yaml", dir);
    const text = await readFile(path, "utf8");
    await writeFile(
      path,
      text.replace(
        "  token_rotation_enabled: true",
        "token_rotation_enabled: true",
      ),
    );
    const problems = (await drift(dir)).join("\n");
    expect(problems).toContain("differs from the template");
    expect(problems).toContain("token_rotation_enabled");
  });

  it("refuses a template that misnests a key, before writing anything", async () => {
    const template = await readFile(
      new URL("app-manifest.template.yaml", root),
      "utf8",
    );
    const broken = template.replace("  bot_user:", "bot_user:");
    expect(() =>
      validate(
        render(broken, {
          baseUrl: "https://slack.datalayer.run",
          socket: false,
          suffix: "",
          tokenRotation: true,
        }),
        "production",
      ),
    ).toThrow(/not valid/);
  });

  it("refuses malformed YAML, a duplicate key and an unresolved placeholder", () => {
    expect(() => validate("_metadata: [", "production")).toThrow();
    expect(() =>
      validate("_metadata:\n  major_version: 2\n_metadata: {}\n", "production"),
    ).toThrow();
    expect(() =>
      render("name: {{NOPE}}", {
        baseUrl: "https://x",
        socket: false,
        suffix: "",
        tokenRotation: true,
      }),
    ).toThrow(/Unresolved placeholder/);
  });

  it("refuses a broader scope, a user scope and a wrong environment value", async () => {
    const production = await committed("production");
    expect(() =>
      validate(
        production.replace(
          "      - users:read",
          "      - users:read\n      - channels:history",
        ),
        "production",
      ),
    ).toThrow(/bot scopes/);
    expect(() =>
      validate(
        production.replace(
          "    bot:\n",
          "    user:\n      - search:read\n    bot:\n",
        ),
        "production",
      ),
    ).toThrow(/not valid/);
    expect(() =>
      validate(
        production.replace(
          "socket_mode_enabled: false",
          "socket_mode_enabled: true",
        ),
        "production",
      ),
    ).toThrow(/socket_mode_enabled must be false/);
    expect(() => validate(production, "staging")).toThrow(/request_url/);
  });
});
