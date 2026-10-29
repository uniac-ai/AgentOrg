/** Run an organization operation through the actor library. */

import { connectClient } from "../../actor/index.ts";
import type { BuiltinName } from "../../domain/model/index.ts";
import { readCredential, rootCredentialPath } from "../../home.ts";
import { coreUrl } from "../../network/index.ts";

const note = (text: string) => process.stderr.write(`agentorg: ${text}\n`);

/** Call as the selected credential and print JSON; a refusal writes stderr and exits 1. */
export async function builtinCommand(
  name: BuiltinName,
  request: Record<string, unknown>,
): Promise<number> {
  const credential = readCredential();
  if (!credential) {
    throw new Error(
      `no credential: set AGENTORG_CREDENTIAL, or run \`agentorg-server\`, which writes the root's to ${rootCredentialPath()}`,
    );
  }
  const url = coreUrl();
  const client = await connectClient({ url, credential, name: "agentorg-cli" }).catch((error) => {
    throw new Error(`the core at ${url} did not accept the connection: ${error.message}`);
  });
  try {
    const wait = typeof request.wait === "number" ? request.wait : 0;
    const answer = await client.call(name, request, { timeoutMs: (wait + 30) * 1000 });
    if (answer.state !== "done") {
      note(answer.state === "refused" ? `${answer.code}: ${answer.message}` : answer.state);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(answer.value, null, 2)}\n`);
    return 0;
  } finally {
    await client.close();
  }
}
