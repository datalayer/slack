import { Pool } from "pg";

export function createDatabase(connectionString: string): Pool {
  return new Pool({
    application_name: "datalayer-slack",
    connectionString,
    max: 10,
    statement_timeout: 15_000,
  });
}
