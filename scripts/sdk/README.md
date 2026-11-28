# @agentorg/sdk

The contracts of [AgentOrg](https://github.com/uniac-ai/AgentOrg), and the code a provider uses to
join a coordinator and answer them.

## Entry points

- `@agentorg/sdk`: define a contract (`defineInterface`, `method`, `event`), compute its hash
  (`describeInterface`), define an Actor (`defineActor`), and the errors a call can end with.
- `@agentorg/sdk/client`: `connect` joins a coordinator as an Actor, with the slots it uses and
  the exports it answers.
- `@agentorg/sdk/testing`: `createTestContext` runs an Actor without a coordinator, for tests:
  stand-ins bound to its slots, calls to its exports, and what it emitted and logged.
- `@agentorg/sdk/interfaces`: AgentOrg's contracts, such as `unit.provider@1`, `capability@1`,
  `tools@1` and the coordinator's own `hub.*@1`.

## Requirements

- Node 22.15 or later.
- zod, at the one exact version the package depends on. A contract's hash is computed from zod's
  JSON Schema output, so another zod could give the same contract another hash.
- In TypeScript, `lib: dom` or `@types/node`, for the `URL` and `ReadableStream` types zod's and
  the package's declarations use.

## Source

https://github.com/uniac-ai/AgentOrg, MIT licensed.
