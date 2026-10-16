import { readdir, readFile } from "node:fs/promises";

import { applyHostSchema } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { Pool } from "pg";

/**
 * A throwaway Postgres database of one test file's own: a schema of its name,
 * dropped and made again, the shared host tables and every migration
 * applied in it, as `scripts/migrate.ts` does. Test files run in
 * parallel against the one `SLACK_TEST_DATABASE_URL`; in one shared schema, a
 * file's TRUNCATE or queue worker took another file's jobs (CI run
 * 38871996069: a dead job replayed by operations-quotas was gone).
 */
export async function testDatabase(url: string, schema: string): Promise<Pool> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema))
    throw new Error(`Not a schema name: ${schema}`);
  const admin = new Pool({ connectionString: url, max: 1 });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const database = new Pool({
    connectionString: url,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  await applyHostSchema(database, "slack");
  const folder = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(folder))
    .filter((one) => one.endsWith(".sql"))
    .sort())
    await database.query(await readFile(new URL(name, folder), "utf8"));
  return database;
}
