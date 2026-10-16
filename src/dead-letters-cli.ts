import {
  deadLetters,
  Logger,
  runDeadLettersCli,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { createDatabase } from "./database.js";
import { LOG_SALT } from "./observability.js";
import { operatorOf, OperatorRefused } from "./operator.js";

/**
 * `node dist/dead-letters.js list | replay <id> | payload <id> <reason…>`
 * against DATABASE_URL (S-405): the shared host kit's dead letters over
 * `slack_jobs`, as the operator their own Datalayer key is
 * (DATALAYER_OPERATOR_KEY, checked at IAM, DATALAYER_IAM_URL), who must hold
 * the platform role; their uid is kept with every replay and payload read.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
let operator: string;
try {
  operator = await operatorOf(
    process.env.DATALAYER_IAM_URL?.trim() || "https://prod1.datalayer.run",
    process.env.DATALAYER_OPERATOR_KEY ?? "",
  );
} catch (error) {
  console.error(
    error instanceof OperatorRefused
      ? error.message
      : `IAM could not be reached to check the operator: ${(error as Error).message}`,
  );
  process.exit(1);
}
const database = createDatabase(url);
try {
  process.exitCode = await runDeadLettersCli(
    deadLetters(database, "slack", new Logger(undefined, undefined, LOG_SALT)),
    process.argv.slice(2),
    operator,
  );
} finally {
  await database.end();
}
