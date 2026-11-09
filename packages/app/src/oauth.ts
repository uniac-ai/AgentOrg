// Where ChatGPT sends the browser back after sign-in.
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * How the app's parts reach the Hub: the person's own calls, as `/api` makes them. A call that
 * doesn't reach its provider rejects with an error named `NotConnected`, as `/api` names it.
 */
export interface PersonCalls {
  call(slot: string, method: string, input: unknown): Promise<unknown>;
}

/** What the sign-in tab says, by outcome: `complete`'s refusal code, or `signed_in`. */
const SAYS: Record<string, string> = {
  signed_in: "Signed in to ChatGPT. You can close this tab.",
  denied: "You declined on ChatGPT's page. Start again from AgentOrg when you're ready.",
  expired: "This sign-in expired. Start again from AgentOrg.",
};
const FAILED = "The sign-in didn't work. Start again from AgentOrg.";

/**
 * `/oauth/chatgpt`: where ChatGPT sends the browser back. It hands the whole callback address to
 * the person's `login.complete`, then sends the tab on to `?result=<outcome>`, an address without
 * the sign-in's code, so the code stays out of the tab's address and history; that page says how
 * it went and links back to the shell. The code is never logged or shown, and no page sends a
 * referrer.
 */
export function oauthRoute(person: PersonCalls) {
  return (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (request.method !== "GET") return void response.writeHead(405).end();
    const result = url.searchParams.get("result");
    if (result !== null && [...url.searchParams.keys()].length === 1)
      return page(
        response,
        result === "signed_in" ? 200 : 400,
        Object.hasOwn(SAYS, result) ? (SAYS[result] as string) : FAILED,
      );
    const after = (outcome: string) => {
      response.writeHead(303, {
        Location: `${url.pathname}?result=${encodeURIComponent(outcome)}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end();
    };
    void person.call("login", "complete", { callbackUrl: url.href }).then(
      () => after("signed_in"),
      (error: unknown) => {
        const code = (error as { code?: unknown } | undefined)?.code;
        after(typeof code === "string" && Object.hasOwn(SAYS, code) ? code : "failed");
      },
    );
  };
}

function page(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>AgentOrg</title>` +
      `<style>body{font:15px system-ui,sans-serif;margin:20vh auto;max-width:28rem;padding:0 16px}</style>` +
      `<p>${text}</p><p><a href="/">Back to AgentOrg</a></p>`,
  );
}
