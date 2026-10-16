import { execFileSync } from "node:child_process";

import {
  forbiddenInInstalled,
  forbiddenInSources,
  installedGraph,
} from "./forbidden-graph.mjs";

// plans/SLACK.md §4.2 and S-005: neither the sources nor the transitive
// production dependency graph may reach Jupyter, Lumino or browser UI. The
// graph is what is installed (`npm ls --omit=dev --all`), lockfile or not.
const sources = await forbiddenInSources("src");
let tree;
try {
  tree = JSON.parse(
    execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
} catch (error) {
  // npm ls exits 1 on a problem it still describes in its JSON.
  const stdout = error?.stdout;
  if (!stdout) {
    console.error("npm ls did not answer: install the dependencies first.");
    process.exit(1);
  }
  tree = JSON.parse(stdout);
}
const graph = forbiddenInInstalled(tree);
if (sources.length || graph.length) {
  if (sources.length)
    console.error(`Forbidden source imports:\n${sources.join("\n")}`);
  if (graph.length)
    console.error(
      `Forbidden packages in the production graph:\n${graph.join("\n")}`,
    );
  process.exitCode = 1;
} else {
  const names = new Set(installedGraph(tree).map((one) => one.name));
  console.info(
    `No forbidden import: ${names.size} production packages checked.`,
  );
}
