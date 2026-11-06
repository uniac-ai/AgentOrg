import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

export const LoginState = z.enum(["signed_out", "signed_in", "ineligible"]);
/** Who is signed in, for people to read. Never a credential. */
export const Account = z.object({
  email: z.string().max(320).optional(),
  plan: z.string().max(64).optional(),
});

const LOOPBACK = String.raw`^http://127\.0\.0\.1:[1-9][0-9]{0,4}/[A-Za-z0-9._~%/-]+`;
/** A loopback redirect on 127.0.0.1, which an OAuth provider sends the browser back to. */
const LoopbackUrl = z
  .string()
  .max(2048)
  .regex(new RegExp(`${LOOPBACK}$`), "must be http://127.0.0.1:<port>/<path>");
/** That redirect, as the browser arrives at it: with the provider's query. */
const CallbackUrl = z
  .string()
  .max(8192)
  .regex(new RegExp(String.raw`${LOOPBACK}(\?\S*)?$`), "must be the loopback redirect");

/**
 * `account.login@1`: signing in to an outside account. The provider's consent page is the
 * provider's own; this interface starts the sign-in, completes it from the address the browser
 * was sent back to, and reports the state, so a person or a program can drive it. Credentials
 * never cross it.
 *
 * `complete` is refused `expired` (no such sign-in was started, or it timed out), `denied` (the
 * person declined), `failed` (the provider refused it) or `unavailable` (it couldn't be reached).
 */
export const accountLogin = defineInterface({
  name: "account.login",
  major: 1,
  kind: "rpc",
  methods: {
    status: method({
      input: z.object({}),
      output: z.object({ state: LoginState, account: Account.optional() }),
    }),
    /** The address of the provider's sign-in page, which sends the browser back to `redirectUri`. */
    start: method({
      input: z.object({ redirectUri: LoopbackUrl }),
      output: z.object({
        authorizeUrl: z
          .string()
          .max(8192)
          .regex(/^https:\/\/\S+$/),
      }),
    }),
    /** Finish a sign-in with the full address the browser was sent back to. */
    complete: method({
      input: z.object({ callbackUrl: CallbackUrl }),
      output: z.object({ account: Account }),
    }),
    /** Sign out. `revoked` is false when the provider didn't confirm the sign-in was revoked. */
    logout: method({ input: z.object({}), output: z.object({ revoked: z.boolean() }) }),
  },
  events: {
    changed: event(z.object({ state: LoginState })),
  },
});
