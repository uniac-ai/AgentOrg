The first version of `@agentorg/sdk`, under npm's `next` tag: `npm install @agentorg/sdk@next`.

## What it holds

- **AgentOrg's contracts:** its interfaces, and what defines an interface and takes its hash.
- **The client a provider uses** to join an AgentOrg coordinator and answer those contracts.
- **A test stand-in:** a provider's module runs without a coordinator, with fakes bound to its slots.

## Entry points

- `@agentorg/sdk`: defining interfaces and Actors, their errors, and a contract's hash.
- `@agentorg/sdk/client`: joining a coordinator.
- `@agentorg/sdk/testing`: the test stand-in.
- `@agentorg/sdk/interfaces`: AgentOrg's interfaces.

## What it needs

- Node 22.15 or later.
- zod, at the one exact version the package depends on: a contract's hash is taken from its zod schemas, so another zod could give it another hash.
