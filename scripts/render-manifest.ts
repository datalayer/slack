import { writeFile } from "node:fs/promises";

import { ENVIRONMENT_NAMES, renderAll } from "./manifest.js";

// Renders app-manifest.template.yaml into manifests/<name>.yaml, refusing a
// manifest that does not validate (scripts/manifest.ts).
const root = new URL("../", import.meta.url);
const rendered = await renderAll(root);
for (const name of ENVIRONMENT_NAMES)
  await writeFile(new URL(`manifests/${name}.yaml`, root), rendered[name]);
console.log(`Rendered ${ENVIRONMENT_NAMES.length} manifests.`);
