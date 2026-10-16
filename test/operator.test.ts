import { describe, expect, it } from "vitest";

import { OPERATOR_ROLE, operatorOf, OperatorRefused } from "../src/operator.js";

const IAM = "https://prod1.datalayer.run";

/** A fake IAM answering `GET /whoami` for one key, and refusing any other. */
function iam(answer: () => Response) {
  const asked: Array<{ authorization?: string; url: string }> = [];
  const fetchImplementation = (async (
    input: string | URL,
    init?: RequestInit,
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    asked.push({ authorization: headers.authorization, url: String(input) });
    return headers.authorization === "Bearer dla_operator"
      ? answer()
      : Response.json({ detail: "Not authenticated" }, { status: 401 });
  }) as typeof fetch;
  return { asked, fetchImplementation };
}

const person = (roles: string[]) => () =>
  Response.json({
    success: true,
    profile: {
      uid: "01JV1VE1T5VG22Z05F6EFBMW8E",
      handle_s: "eric",
      roles_ss: roles,
    },
  });

describe("The operator of dead jobs, checked at Datalayer (S-405)", () => {
  it("is the person their own key is, when they hold the platform role", async () => {
    const { asked, fetchImplementation } = iam(
      person(["platform_member", OPERATOR_ROLE]),
    );
    await expect(
      operatorOf(`${IAM}/`, " dla_operator ", fetchImplementation),
    ).resolves.toBe("01JV1VE1T5VG22Z05F6EFBMW8E");
    expect(asked).toEqual([
      { authorization: "Bearer dla_operator", url: `${IAM}/api/iam/v1/whoami` },
    ]);
  });

  it("refuses a person without the platform role", async () => {
    const { fetchImplementation } = iam(person(["platform_member"]));
    await expect(
      operatorOf(IAM, "dla_operator", fetchImplementation),
    ).rejects.toThrow(`needs the ${OPERATOR_ROLE} role`);
  });

  it("refuses a key IAM does not accept, a principal's token and no key at all", async () => {
    const principal = iam(() =>
      Response.json({
        success: true,
        message: "The token is a principal's, not a person's.",
        principal: { uid: "01APP", app_uid: "app-1" },
      }),
    );
    await expect(
      operatorOf(IAM, "dla_someone_else", principal.fetchImplementation),
    ).rejects.toThrow("IAM did not accept the operator's key (401).");
    await expect(
      operatorOf(IAM, "dla_operator", principal.fetchImplementation),
    ).rejects.toThrow("The key is not a person's");
    await expect(
      operatorOf(IAM, "  ", principal.fetchImplementation),
    ).rejects.toBeInstanceOf(OperatorRefused);
    // No key: IAM is not even asked.
    expect(principal.asked).toHaveLength(2);
  });
});
