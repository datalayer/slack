import { readFileSync } from "node:fs";

/**
 * The SBOM CI writes (S-502): a CycloneDX document of the
 * production dependencies, which must name each of package.json's
 * `dependencies` at the exact version installed. Run after
 * `cyclonedx-npm --omit dev --output-file sbom.cdx.json`.
 */
const [file = "sbom.cdx.json"] = process.argv.slice(2);
const bom = JSON.parse(readFileSync(file, "utf8"));
const { dependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
if (bom.bomFormat !== "CycloneDX")
  throw new Error(`${file} is not a CycloneDX document.`);
const purls = new Set(
  (bom.components ?? []).map((component) => component.purl ?? ""),
);
const missing = Object.entries(dependencies)
  .map(([name, version]) => `pkg:npm/${name.replace("@", "%40")}@${version}`)
  .filter((purl) => !purls.has(purl));
if (missing.length > 0)
  throw new Error(`The SBOM does not name ${missing.join(", ")}.`);
console.log(
  `${file}: CycloneDX ${bom.specVersion}, ${purls.size} components, every production dependency named.`,
);
