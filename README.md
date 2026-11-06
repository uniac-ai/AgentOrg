# agentorg-next

AgentOrg as a dynamic system: Actors and widgets are modules in content-addressed packages, connected through named, versioned interfaces. This repository holds the fresh core, starting with the SDK a package author writes against (`@agentorg/sdk`) and the standard interfaces (`@agentorg/interfaces`).

## Packages

- `@agentorg/sdk`: `defineInterface` (with `method` and `event`) for `rpc`, `stream` and `http` interfaces; `defineActor` for host modules and `defineWidget` for view modules, with typed slot and export handles; the errors `NotConnected`, `Refused` and `OutcomeUnknown`; and `createTestContext` (`@agentorg/sdk/testing`), which runs a module without a Hub.
- `@agentorg/interfaces`: the standard interfaces `kv@1` and `ui.view@1`, with `chat@1` and `llm.session@1` as stubs.

### Why `ui.view@1` is different

Every interface crosses the wire as schemas, and a module's handles are derived from them, with one exception. `ui.view@1` is a view module's render surface: the view draws into its own frame's DOM, which no message can carry. So its export handle is `implement({ mount(el, { theme, size }), resize?(size) })`, where `el` is the frame's root element, and the frame runtime maps the wire methods `mount`, `resize` and `unmount` onto it. Don't copy this shape for another interface; anything a module offers to others belongs in schemas.
