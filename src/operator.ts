import { z } from "zod";

/** The role at Datalayer an operator of dead jobs holds (S-405). */
export const OPERATOR_ROLE = "platform_admin";

/** Who IAM says a key is: a person's profile, with their roles. */
const whoamiSchema = z.object({
  profile: z.object({
    uid: z.string().min(1),
    roles_ss: z.array(z.string()).default([]),
  }),
});

/** Why the operator was not let through, in a sentence. */
export class OperatorRefused extends Error {}

/**
 * The operator of a dead-letter list, replay or payload read (S-405): the
 * person their own Datalayer key is, read from IAM (`GET /whoami`), and only
 * when they hold the platform role. Their uid is what every replay and
 * payload read keeps; a name typed in the environment is never taken for one.
 */
export async function operatorOf(
  iamUrl: string,
  key: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string> {
  if (!key.trim())
    throw new OperatorRefused(
      "DATALAYER_OPERATOR_KEY is required: your own Datalayer key, checked at IAM.",
    );
  const response = await fetchImplementation(
    `${iamUrl.replace(/\/+$/, "")}/api/iam/v1/whoami`,
    { headers: { authorization: `Bearer ${key.trim()}` } },
  );
  if (!response.ok)
    throw new OperatorRefused(
      `IAM did not accept the operator's key (${response.status}).`,
    );
  const said = whoamiSchema.safeParse(await response.json().catch(() => ({})));
  if (!said.success)
    throw new OperatorRefused(
      "The key is not a person's: an operator is a person, with their own key.",
    );
  if (!said.data.profile.roles_ss.includes(OPERATOR_ROLE))
    throw new OperatorRefused(
      `Handling dead jobs needs the ${OPERATOR_ROLE} role at Datalayer.`,
    );
  return said.data.profile.uid;
}
