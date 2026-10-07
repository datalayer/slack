import { readdir, readFile } from "node:fs/promises";

import { readConfig } from "../src/config.js";
import { createDatabase } from "../src/database.js";

const config = readConfig();
if (!config.DATABASE_URL)
  throw new Error("DATABASE_URL is required to migrate.");
const database = createDatabase(config.DATABASE_URL);
const folder = new URL("../migrations/", import.meta.url);
try {
  // Every migration, in order; each is idempotent (IF NOT EXISTS).
  const files = (await readdir(folder))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files)
    await database.query(await readFile(new URL(name, folder), "utf8"));
  console.info(`Applied ${files.length} Slack database migrations.`);
} finally {
  await database.end();
}
