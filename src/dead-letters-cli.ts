import { userInfo } from "node:os";

import { createDatabase } from "./database.js";
import { DeadLetters } from "./dead-letters.js";
import { PostgresWorkQueue } from "./postgres-queue.js";

/**
 * `node lib/dead-letters-cli.js list | replay <id> | payload <id> <reason…>`
 * against DATABASE_URL: metadata and hashes by default (S-405).
 */
const [command, id, ...rest] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const database = createDatabase(url);
const letters = new DeadLetters(
  database,
  new PostgresWorkQueue<unknown>(database),
);
const operator = process.env.DATALAYER_OPERATOR ?? userInfo().username;
try {
  if (command === "list") console.table(await letters.list());
  else if (command === "replay" && id)
    console.info(
      (await letters.replay(id, operator))
        ? `Job ${id} is back to work.`
        : `Job ${id} is not a dead job.`,
    );
  else if (command === "payload" && id)
    console.info(
      JSON.stringify(
        await letters.payload(id, operator, rest.join(" ")),
        null,
        2,
      ),
    );
  else {
    console.error(
      "Usage: dead-letters-cli list | replay <id> | payload <id> <reason>",
    );
    process.exitCode = 1;
  }
} finally {
  await database.end();
}
