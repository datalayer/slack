import { readdir, readFile } from "node:fs/promises";

import pg from "pg";

// Apply every migration in order; each is idempotent (IF NOT EXISTS). Run by
// the image as a job before the service starts (`node scripts/migrate.mjs`).
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required to migrate.");
  process.exit(1);
}
const database = new pg.Pool({
  application_name: "datalayer-slack-migrate",
  connectionString: url,
  max: 1,
});
const folder = new URL("../migrations/", import.meta.url);
try {
  const files = (await readdir(folder))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files)
    await database.query(await readFile(new URL(name, folder), "utf8"));
  console.info(`Applied ${files.length} Slack database migrations.`);
} finally {
  await database.end();
}
