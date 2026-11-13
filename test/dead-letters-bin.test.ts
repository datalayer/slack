import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { textOf } from "../src/solr/client.js";
import { documentOf, type SolrRecords } from "../src/solr/records.js";
import { solrTestUrl, testCollection } from "./support/solr.js";

/**
 * The dead-letters bin (S-405) against a real Solr: the operator checked at
 * IAM (a fake whoami here), the dead jobs of the service's collection listed
 * by metadata, a payload read for a reason and a replay, each kept with the
 * operator's uid; an unknown key refused before anything is read.
 */
const run = promisify(execFile);

type Ran = { status: number; stdout: string; stderr: string };

describe.runIf(Boolean(solrTestUrl))("the dead-letters bin on Solr", () => {
  let records: SolrRecords;
  let iam: Server;
  let iamUrl: string;

  beforeAll(async () => {
    records = await testCollection("test_slack_dead_letters_bin");
    iam = createServer((request, response) => {
      const known =
        request.url === "/api/iam/v1/whoami" &&
        request.headers.authorization === "Bearer operator-key";
      response.writeHead(known ? 200 : 401, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          known
            ? {
                profile: {
                  roles_ss: ["platform_admin"],
                  uid: "operator-grace",
                },
              }
            : {},
        ),
      );
    });
    await new Promise<void>((resolve) => iam.listen(0, "127.0.0.1", resolve));
    iamUrl = `http://127.0.0.1:${(iam.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    await new Promise((resolve) => (iam ? iam.close(resolve) : resolve(null)));
  });

  const bin = async (key: string, ...args: string[]): Promise<Ran> => {
    try {
      const { stdout, stderr } = await run(
        "node",
        ["--import", "tsx", "src/dead-letters-cli.ts", ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DATALAYER_IAM_URL: iamUrl,
            DATALAYER_OPERATOR_KEY: key,
            DATALAYER_SLACK_SOLR_COLLECTION: records.client.collection,
            DATALAYER_SOLR_PASSWORD:
              process.env.DATALAYER_SOLR_TEST_PASSWORD || "no-auth",
            DATALAYER_SOLR_URL: solrTestUrl,
            DATALAYER_SOLR_USERNAME:
              process.env.DATALAYER_SOLR_TEST_USERNAME ?? "solr",
          },
        },
      );
      return { status: 0, stderr, stdout };
    } catch (error) {
      const failed = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        status: typeof failed.code === "number" ? failed.code : 1,
        stderr: failed.stderr ?? "",
        stdout: failed.stdout ?? "",
      };
    }
  };

  it("lists, reads for a reason and replays, as the operator IAM names", async () => {
    const doc = documentOf("job", null, {
      attempts_i: 5,
      available_dt: new Date(),
      kind_s: "prompt",
      last_error_stored: "refused",
      payload_stored: JSON.stringify({
        prompt: { text: "the words of request 920" },
      }),
      state_s: "dead",
    });
    await records.client.add([doc]);
    const dead = textOf(doc.uid);

    const list = await bin("operator-key", "list");
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(dead);
    expect(list.stdout).not.toContain("the words of request");
    const read = await bin(
      "operator-key",
      "payload",
      dead,
      "checking",
      "the",
      "failure",
    );
    expect(read.status).toBe(0);
    expect(read.stdout).toContain("the words of request 920");
    expect((await bin("operator-key", "replay", dead)).stdout).toContain(
      `Job ${dead} is back to work.`,
    );
    expect(await records.find("payload_access", { job_uid_s: dead })).toEqual([
      {
        jobUid: dead,
        operator: "operator-grace",
        reason: "checking the failure",
      },
    ]);
    expect(
      await records.count("job_replay", { operator_s: "operator-grace" }),
    ).toBe(1);

    const refused = await bin("another-key", "list");
    expect(refused.status).toBe(1);
    expect(await records.count("job_replay")).toBe(1);
  }, 60_000);
});
