import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// @ts-expect-error: a plain ES module script, without types.
import * as graph from "../scripts/forbidden-graph.mjs";

type Lock = { packages: Record<string, unknown> };
const {
  forbiddenInGraph,
  forbiddenInInstalled,
  forbiddenInSources,
  importsOf,
  installedGraph,
  productionGraph,
} = graph as {
  forbiddenInInstalled(tree: unknown): string[];
  installedGraph(tree: unknown): Array<{ name: string; chain: string[] }>;
  forbiddenInGraph(lock: Lock): string[];
  forbiddenInSources(directory: string): Promise<string[]>;
  importsOf(source: string): string[];
  productionGraph(lock: Lock): Array<{ name: string; chain: string[] }>;
};

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Lock;

describe("the forbidden production graph (S-005)", () => {
  it("fails when a forbidden package is reachable through a production dependency", () => {
    expect(forbiddenInGraph(read("./fixtures/lock-with-jupyter.json"))).toEqual(
      [
        "@datalayer/agent-runtimes → @datalayer/jupyter-react",
        "@datalayer/agent-runtimes → @datalayer/jupyter-react → @jupyterlab/services",
        "@datalayer/agent-runtimes → @datalayer/jupyter-react → @lumino/widgets",
      ],
    );
  });

  it("does not count development dependencies", () => {
    const names = productionGraph(
      read("./fixtures/lock-with-jupyter.json"),
    ).map((one) => one.name);
    expect(names).not.toContain("vitest");
    expect(names).not.toContain("react-dom");
  });

  it("fails on an installed graph (npm ls) that reaches a forbidden package", () => {
    expect(
      forbiddenInInstalled(read("./fixtures/npm-ls-with-jupyter.json")),
    ).toEqual([
      "@datalayer/agent-runtimes → @datalayer/jupyter-react",
      "@datalayer/agent-runtimes → @datalayer/jupyter-react → @jupyterlab/services",
      "@datalayer/agent-runtimes → @datalayer/jupyter-react → react-dom",
    ]);
  });

  it("passes on this service's installed production graph", () => {
    const tree = JSON.parse(
      execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as unknown;
    expect(forbiddenInInstalled(tree)).toEqual([]);
    const names = installedGraph(tree).map((one) => one.name);
    expect(names).toContain("@slack/bolt");
    expect(names).not.toContain("vitest");
    // npm ls walks the whole monorepo from a workspace member: 7-9 s.
  }, 60_000);

  it("passes on this service's sources and reads every kind of import", async () => {
    await expect(forbiddenInSources("src")).resolves.toEqual([]);
    expect(
      importsOf(
        'import x from "@lumino/widgets/lib/x";\nimport type { Y } from "react-dom/client";\nexport { z } from "./z.js";\nconst a = await import("@jupyterlab/services");',
      ).sort(),
    ).toEqual(["@jupyterlab/services", "@lumino/widgets", "react-dom"]);
  });
});
