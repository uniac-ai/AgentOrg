# agentorg-next

AgentOrg as a dynamic system: Actors and widgets are modules in content-addressed packages, connected through named, versioned interfaces. This repository holds the fresh core, starting with the SDK a package author writes against (`@agentorg/sdk`) and the standard interfaces (`@agentorg/interfaces`).

## Packages

- `@agentorg/sdk`: `defineInterface` (with `method` and `event`) for `rpc`, `stream` and `http` interfaces; `defineActor` for host modules and `defineWidget` for view modules, with typed slot and export handles; the errors `NotConnected`, `Refused` and `OutcomeUnknown`; and `createTestContext` (`@agentorg/sdk/testing`), which runs a module without a Hub.
- `@agentorg/interfaces`: the standard interfaces `kv@1` and `ui.view@1`, with `chat@1` and `llm.session@1` as stubs, and the Hub's management interfaces `hub.packages@1`, `hub.actors@1`, `hub.bindings@1`, `hub.exports@1` and `hub.audit@1`.
- `@agentorg/wire`: the channel: yamux streams, length-prefixed JSON frames, stream headers and transports.
- `@agentorg/hub`: the core. Its state, in `node:sqlite` in a private home: Actors, a verified package store, what each Actor takes and offers, bindings, binding requests and an audit trail. A binding is the grant: an Actor may bind a slot to an export when it is the provider, already holds that export, or is bound to the hub's `hub.bindings@1`; otherwise it requests, and the request goes to everyone who could grant it. The router serves it over WebSocket (`listen`), one yamux channel per Actor: a client's first stream is `hello` with its credential, then every `call`, `subscribe`, `open` and `http` stream is resolved through its binding, validated against the interface's JSON Schemas in both directions (ajv, 2020-12), forwarded to the provider with the caller named, and audited. A provider accepts or refuses an `open` or `http` stream with one body before any raw bytes. An Actor offers and withdraws exports at run time on its own channel (`offer`, `withdraw`). The `hub` Actor's five exports are served through the same path.

### Why `ui.view@1` is different

Every interface crosses the wire as schemas, and a module's handles are derived from them, with one exception. `ui.view@1` is a view module's render surface: the view draws into its own frame's DOM, which no message can carry. So its export handle is `implement({ mount(el, { theme, size }), resize?(size) })`, where `el` is the frame's root element, and the frame runtime maps the wire methods `mount`, `resize` and `unmount` onto it. Don't copy this shape for another interface; anything a module offers to others belongs in schemas.

## Building a package

A package's `package.json` names its modules, its own wiring and any seed state:

```json
"agentorg": {
  "modules": { "logic": "src/logic.ts", "panel": "src/panel.ts" },
  "connections": [["panel.board", "logic.board"]],
  "seed": { "logic.store": { "cards": [] } }
}
```

`seed` is optional initial state for state slots, keyed by `"module.slot"`; the build checks each slot exists. It is the only runtime state a package may carry.

`agentorg build [dir]` (from `@agentorg/sdk`; `buildPackage` in `@agentorg/sdk/build`) then:

- bundles each module, with every library it uses, into one ESM file, `dist/<module>.js`, with no imports at run time and no Node built-ins;
- reads each module's definition from its code and writes `agentorg.json`: each module's placement, slots and exports, every interface's JSON Schemas and hash, the package's `connections` and `seed`;
- hashes the tree, `agentorg.json` and `dist/`, as SHA-256 over the canonical list of each file's path and SHA-256, and archives it as `<hash>.agentorg`, a deterministic tar. The tree goes to `agentorg-build/package/` and the archive beside it.

A signature is detached: a file named `agentorg.sig` beside the package, signing the package hash, so it is never inside what it signs. The manifest has no signature field.

The build bundles; it doesn't type-check. Run `tsc --noEmit` on the package first.

`@agentorg/sdk/manifest` reads packages without esbuild, for a Hub or an installer: `verifyArchive(bytes, hash)` checks an archive holds exactly `agentorg.json` and each module's entry, hashes to the expected hash, and has a sound manifest (`checkManifest`: its shape, each interface's recorded hash against its schemas, and its connections). Problems are returned, not thrown.

The examples folder holds the spec's board package; its tests build it.

### Module top levels have no side effects

To read a module's definition, the build runs the module's code in a separate Node process (Node 22.15 or later) under the permission model: it can read only its own scratch folder, write nothing, and start no processes; Node built-ins can't be imported, and the network globals are gone. A definition that takes over 30 seconds to read is stopped. Widget bundles run there too, in Node, not a browser. So a module's top level must only define: no I/O, no timers that do work, no DOM globals such as `document` or `window`. Do that work in `start()`. A top level that tries fails the build with a message naming the module and what it touched.

### Errors

- `NotConnected`: the slot is unbound, or the export was withdrawn.
- `Refused` with code `invalid`: the caller's input broke the interface's schema. Nothing ran.
- `Refused` with code `bad_output`: the provider ran, and its reply or event broke the contract. The call may have had its effect; read state before retrying.
- `Refused` with code `unimplemented`: the export has no handler for that method yet.
- `OutcomeUnknown`: the channel dropped mid-call. Read state before retrying.

### The `agentorg` command name

`@agentorg/sdk`'s bin is named `agentorg`, the same name the current `@agentorg/cli` package uses. With both installed, the one found first on `PATH` wins. The name will be settled before anything is published; in this repository, run the build with `node packages/sdk/dist/src/cli.js build <dir>` or `buildPackage`.
