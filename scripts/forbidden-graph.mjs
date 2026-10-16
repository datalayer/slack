import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

/**
 * What may never reach the Slack service's production code (plans/SLACK.md
 * §4.2, S-005): Jupyter, JupyterLab, Lumino, Datalayer's Jupyter packages,
 * React DOM and browser-only UI. Checked in the source imports and in the
 * whole transitive production graph of package-lock.json.
 */
export const FORBIDDEN = [
  /^@jupyter\//,
  /^@jupyterlab\//,
  /^@jupyter-widgets\//,
  /^@lumino\//,
  /^@datalayer\/jupyter-/,
  /^react-dom$/,
  /^react$/,
  /^@primer\//,
];

export const isForbidden = (name) =>
  FORBIDDEN.some((pattern) => pattern.test(name));

/** The package name an import specifier names: `@scope/name/deep` → `@scope/name`. */
export function packageOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("node:"))
    return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Every bare import of one source file. */
export function importsOf(source) {
  const found = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\sfrom\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns)
    for (const match of source.matchAll(pattern)) {
      const name = packageOf(match[1]);
      if (name) found.add(name);
    }
  return [...found];
}

/**
 * The production graph of a lockfile (v2/v3 `packages`): from the root's
 * `dependencies` and `optionalDependencies` (never `devDependencies`), each
 * package's own dependencies resolved the way Node resolves them — the
 * nearest `node_modules` up from the dependent. Answers each package reached
 * with the chain that reached it.
 */
export function productionGraph(lock) {
  const packages = lock.packages ?? {};
  const root = packages[""] ?? {};
  const resolve = (from, name) => {
    let base = from;
    while (true) {
      const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return undefined;
      const index = base.lastIndexOf("/node_modules/");
      base = index >= 0 ? base.slice(0, index) : "";
    }
  };
  const reached = new Map();
  const queue = [];
  for (const name of Object.keys({
    ...root.dependencies,
    ...root.optionalDependencies,
  }))
    queue.push({ chain: [name], from: "", name });
  while (queue.length > 0) {
    const { chain, from, name } = queue.shift();
    const path = resolve(from, name);
    if (!path || reached.has(path)) continue;
    reached.set(path, { chain, name });
    const meta = packages[path];
    for (const next of Object.keys({
      ...meta.dependencies,
      ...meta.optionalDependencies,
      ...meta.peerDependencies,
    }))
      if (
        !(meta.peerDependenciesMeta?.[next]?.optional && !resolve(path, next))
      )
        queue.push({ chain: [...chain, next], from: path, name: next });
  }
  return [...reached.values()];
}

/**
 * The production graph as `npm ls --omit=dev --all --json` answers it, from
 * what is installed: what the service runs with, whether a lockfile is kept
 * or not (the monorepo keeps none). Each package with the chain reaching it.
 */
export function installedGraph(tree) {
  const reached = [];
  const seen = new Set();
  const walk = (dependencies, chain) => {
    for (const [name, node] of Object.entries(dependencies ?? {})) {
      const id = `${chain.join(">")}>${name}`;
      if (seen.has(id) || chain.includes(name)) continue;
      seen.add(id);
      reached.push({ chain: [...chain, name], name });
      walk(node?.dependencies, [...chain, name]);
    }
  };
  walk(tree.dependencies, []);
  return reached;
}

/** The forbidden packages an installed graph reaches, each with its chain. */
export function forbiddenInInstalled(tree) {
  return installedGraph(tree)
    .filter((one) => isForbidden(one.name))
    .map((one) => one.chain.join(" → "));
}

/** The forbidden packages a lockfile's production graph reaches, each with its chain. */
export function forbiddenInGraph(lock) {
  return productionGraph(lock)
    .filter((one) => isForbidden(one.name))
    .map((one) => one.chain.join(" → "));
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

/** The forbidden imports of the production sources under `directory`. */
export async function forbiddenInSources(directory = "src") {
  const violations = [];
  for (const path of await files(directory)) {
    if (![".ts", ".tsx", ".js", ".mjs"].includes(extname(path))) continue;
    for (const name of importsOf(await readFile(path, "utf8")))
      if (isForbidden(name)) violations.push(`${path}: ${name}`);
  }
  return violations;
}
