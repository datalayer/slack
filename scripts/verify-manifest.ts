import { drift } from "./manifest.js";

// CI's manifest gate (plans/SLACK.md S-107): every committed manifest is
// valid and byte for byte what the template renders.
const problems = await drift(new URL("../", import.meta.url));
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log("Manifests valid and in step with the template.");
