/** Run an organization operation through the actor library. */

import { type Actor, connectClient } from "../../actor/index.ts";
import { readCredential, rootCredentialPath } from "../../home.ts";
import { coreUrl } from "../../network/index.ts";

const note = (text: string) => process.stderr.write(`agentorg: ${text}\n`);

/** Run through the selected actor's client and close the connection when finished. */
async function asActor(run: (client: Actor) => Promise<number>): Promise<number> {
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
    return await run(client);
  } finally {
    await client.close();
  }
}

/** List the selected actor's current capabilities, including routed interfaces. */
export function interfacesCommand(): Promise<number> {
  return asActor(async (client) => {
    process.stdout.write(`${JSON.stringify({ interfaces: await client.available() }, null, 2)}\n`);
    return 0;
  });
}

/** Generic calls print the whole answer; built-in conveniences print the completed value. */
export function callCommand(
  name: string,
  request: Record<string, unknown>,
  resultOnly = false,
): Promise<number> {
  return asActor(async (client) => {
    const wait = typeof request.wait === "number" ? request.wait : 0;
    const answer = await client.call(name, request, { timeoutMs: Math.max(60, wait + 30) * 1000 });
    if (resultOnly && answer.state !== "done") {
      note(answer.state === "refused" ? `${answer.code}: ${answer.message}` : answer.state);
      return 1;
    }
    process.stdout.write(
      `${JSON.stringify(resultOnly && answer.state === "done" ? answer.value : answer, null, 2)}\n`,
    );
    return answer.state === "done" || answer.state === "pending" ? 0 : 1;
  });
}
