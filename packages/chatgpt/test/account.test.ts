import assert from "node:assert/strict";
import test from "node:test";
import { createAccount } from "../src/account.ts";

/** The account alone, with a clock to move, a store in memory and no network. */
function account() {
  let clock = 1_000_000;
  const values = new Map<string, unknown>();
  const created = createAccount({
    fetch: () => Promise.reject(new Error("no network here")),
    store: {
      get: async ({ key }) => (values.has(key) ? { value: values.get(key) as never } : {}),
      set: async ({ key, value }) => {
        values.set(key, value);
        return {};
      },
      delete: async ({ key }) => ({ deleted: values.delete(key) }),
      list: async () => ({ keys: [], next: null }),
    },
    changed() {},
    now: () => clock,
  });
  return {
    account: created,
    advance(ms: number) {
      clock += ms;
    },
  };
}
const REDIRECT = "http://127.0.0.1:4321/oauth/chatgpt";
const stateOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get("state");

test("a started sign-in expires after ten minutes", async () => {
  const { account: a, advance } = account();
  const state = stateOf((await a.start({ redirectUri: REDIRECT })).authorizeUrl);
  advance(10 * 60_000 + 1);
  await assert.rejects(a.complete({ callbackUrl: `${REDIRECT}?code=c&state=${state}` }), {
    code: "expired",
  });
});

test("at most sixteen sign-ins wait, the oldest dropped first", async () => {
  const { account: a } = account();
  const states = [];
  for (let i = 0; i < 17; i++)
    states.push(stateOf((await a.start({ redirectUri: REDIRECT })).authorizeUrl));
  await assert.rejects(a.complete({ callbackUrl: `${REDIRECT}?code=c&state=${states[0]}` }), {
    code: "expired",
  });
  // The newest is still waiting: it gets as far as the network.
  await assert.rejects(
    a.complete({ callbackUrl: `${REDIRECT}?code=c&client_id=oaiapp_x&state=${states[16]}` }),
    {
      code: "unavailable",
    },
  );
});

test("the callback must come back to the redirect, compared as addresses", async () => {
  const { account: a } = account();
  const redirect = "http://127.0.0.1:4321/./oauth/chatgpt";
  const state = stateOf((await a.start({ redirectUri: redirect })).authorizeUrl);
  await assert.rejects(
    a.complete({ callbackUrl: `http://127.0.0.1:4321/oauth/other?code=c&state=${state}` }),
    { code: "invalid" },
  );
  const again = stateOf((await a.start({ redirectUri: redirect })).authorizeUrl);
  await assert.rejects(
    a.complete({ callbackUrl: `${REDIRECT}?code=c&client_id=oaiapp_x&state=${again}` }),
    {
      code: "unavailable",
    },
  );
});
