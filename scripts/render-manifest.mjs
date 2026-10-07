import { readFile, writeFile } from "node:fs/promises";

const environments = {
  development: {
    baseUrl: "https://slack-dev.datalayer.run",
    socket: "true",
    suffix: " Dev",
    tokenRotation: "false",
  },
  staging: {
    baseUrl: "https://slack-staging.datalayer.run",
    socket: "false",
    suffix: " Staging",
    tokenRotation: "true",
  },
  production: {
    baseUrl: "https://slack.datalayer.ai",
    socket: "false",
    suffix: "",
    tokenRotation: "true",
  },
};
const expectedScopes = ["app_mentions:read", "chat:write", "im:history"];

function render(template, values) {
  return template
    .replaceAll("{{BASE_URL}}", values.baseUrl)
    .replaceAll("{{DISPLAY_SUFFIX}}", values.suffix)
    .replaceAll("{{SOCKET_MODE}}", values.socket)
    .replaceAll("{{TOKEN_ROTATION}}", values.tokenRotation);
}

const template = await readFile("app-manifest.template.yaml", "utf8");
for (const [name, values] of Object.entries(environments)) {
  const output = render(template, values);
  if (/{{[^}]+}}/.test(output))
    throw new Error(`Unresolved placeholder in ${name} manifest.`);
  for (const scope of expectedScopes)
    if (!output.includes(`- ${scope}`))
      throw new Error(`${name} misses ${scope}.`);
  for (const broad of [
    "chat:write.public",
    "channels:history",
    "groups:history",
    "search:read",
  ]) {
    if (output.includes(broad))
      throw new Error(`${name} unexpectedly requests ${broad}.`);
  }
  const path = `manifests/${name}.yaml`;
  if (process.argv.includes("--check")) {
    const committed = await readFile(path, "utf8");
    if (normalize(committed) !== normalize(output))
      throw new Error(`${path} differs from the template.`);
  } else {
    await writeFile(path, output);
  }
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}
