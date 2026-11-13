import type { KeyedRecords } from "../../src/oauth-store.js";

/**
 * Keyed records in a map, for the stores that only read, keep and change one
 * record at a time (`KeyedRecords`): what they wrote is readable as it was
 * written (`kept`), to check a secret never lands in clear.
 */
export class MapRecords implements KeyedRecords {
  readonly kept = new Map<string, unknown>();

  async get<T>(kind: string, key: string): Promise<T | undefined> {
    return this.kept.get(`${kind}|${key}`) as T | undefined;
  }

  async put<T>(kind: string, key: string, record: T): Promise<void> {
    this.kept.set(`${kind}|${key}`, record);
  }

  async update<T>(
    kind: string,
    key: string,
    change: (
      before: T | undefined,
    ) =>
      | { record: T }
      | undefined
      | null
      | Promise<{ record: T } | undefined | null>,
  ): Promise<T | undefined> {
    const before = this.kept.get(`${kind}|${key}`) as T | undefined;
    const next = await change(before);
    if (next === undefined) return before;
    if (next === null) {
      this.kept.delete(`${kind}|${key}`);
      return undefined;
    }
    this.kept.set(`${kind}|${key}`, next.record);
    return next.record;
  }
}
