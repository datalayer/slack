import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const forbidden = [
  "@jupyter/",
  "@jupyterlab/",
  "@lumino/",
  "@datalayer/jupyter-",
  "react-dom",
];

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

const candidates = (await files("src")).filter((path) =>
  [".ts", ".tsx"].includes(extname(path)),
);
const violations = [];
for (const path of candidates) {
  const source = await readFile(path, "utf8");
  for (const name of forbidden)
    if (source.includes(name)) violations.push(`${path}: ${name}`);
}
if (violations.length) {
  console.error(`Forbidden server imports:\n${violations.join("\n")}`);
  process.exitCode = 1;
}
