# @agentorg/shell

AgentOrg's frontend: the person's web page for their agents, what each is made of, and their settings.

`npm run build` makes it a folder of static files in `dist`: `index.html`, `app.js`, `app.css`, and `frontend.json`. The JSON file says the release the folder comes with and the contract it speaks: `{ "version": "<the CLI's version>", "contract": 1 }`.

A core serves the folder it is given, with `agentorg --frontend DIR`, or the one `@agentorg/cli` carries. What passes between them is [the frontend contract](../../README.md#the-frontend-contract). Each release keeps the folder as `agentorg-frontend-<version>.tgz`, beside the core. The package isn't published to npm by itself.

`npm test` runs its tests against a stand-in gateway. They need no core.
