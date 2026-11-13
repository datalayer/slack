import { Logger } from "@datalayer/agent-runtimes/lib/portable/hosts";

import { LOG_SALT } from "./observability.js";
import { operatorOf, OperatorRefused } from "./operator.js";
import { solrRecordsOf } from "./resources.js";
import { runDeadLettersCli, SolrDeadLetters } from "./solr/dead-letters.js";
import { SolrWorkQueue } from "./solr/queue.js";

/**
 * `node dist/dead-letters.js list | replay <id> | payload <id> <reason…>`
 * (S-405): the dead jobs of the service's queue in its Solr collection
 * (the service's own settings, `DATALAYER_SOLR_*`), as the operator their
 * own Datalayer key is (DATALAYER_OPERATOR_KEY, checked at IAM,
 * DATALAYER_IAM_URL), who must hold the platform role; their uid is kept
 * with every replay and payload read. A job's id is its uid.
 */
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
const records = solrRecordsOf({
  DATALAYER_SLACK_SOLR_COLLECTION:
    process.env.DATALAYER_SLACK_SOLR_COLLECTION?.trim() || "slack",
  DATALAYER_SOLR_PASSWORD: process.env.DATALAYER_SOLR_PASSWORD,
  DATALAYER_SOLR_URL: process.env.DATALAYER_SOLR_URL,
  DATALAYER_SOLR_USERNAME: process.env.DATALAYER_SOLR_USERNAME,
});
process.exitCode = await runDeadLettersCli(
  new SolrDeadLetters(
    new SolrWorkQueue<unknown>(records),
    "slack",
    new Logger(undefined, undefined, LOG_SALT),
  ),
  process.argv.slice(2),
  operator,
);
