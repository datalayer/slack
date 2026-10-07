import { readFile } from "node:fs/promises";

import { readConfig } from "../src/config.js";
import { createDatabase } from "../src/database.js";

const config = readConfig();
if (!config.DATABASE_URL)
  throw new Error("DATABASE_URL is required to migrate.");
const database = createDatabase(config.DATABASE_URL);
try {
  const sql = await readFile(
    new URL("../migrations/001_initial.sql", import.meta.url),
    "utf8",
  );
  await database.query(sql);
  console.info("Applied Slack database migrations.");
} finally {
  await database.end();
}
