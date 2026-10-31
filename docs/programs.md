# Running applications and connecting programs

[setup.md](setup.md) owns service and project setup. `agentorg-server` and `agentorg-mcp`
also run directly as independent processes; `agentorg` makes individual CLI calls.

## Home and addresses

| Variable | Default and purpose |
|---|---|
| `AGENTORG_HOME` | `~/.local/share/agentorg`, holding the database and credentials, readable only by its owner. |
| `AGENTORG_PORT` | `8740`, the core's port on 127.0.0.1. |
| `AGENTORG_URL` | `http://127.0.0.1:<core port>`, where clients find the core. |
| `AGENTORG_ACTOR_ID` | The existing Actor identity to use with `AGENTORG_CREDENTIAL`. |
| `AGENTORG_CREDENTIAL` | The credential for `AGENTORG_ACTOR_ID`; set both to select an Actor explicitly. |

The default home's service is `agentorg-server`. An alternate home adds
its path's hash to the service name. Pinned launchers retain the home and addresses and run with
only `/usr/bin:/bin` on PATH.

## Actor credentials and the CLI

Every actor has a random credential; the core stores only its hash. The first server start creates
root and writes its identity to `<home>/root-actor` and credential to `<home>/root-credential`.
Removing the credential file rotates the credential on the next start. A file holding a different
credential makes startup fail.

`actor_create` returns a credential once. MCP adapters keep credentials they create in
`<home>/actors/<id>` for sessions to attach, without showing them to the model. CLI creation
prints the credential and keeps no session copy. A program connects with that Actor's id and credential; a
session attaches through its MCP adapter or creates a position under root on first attachment.

The actor CLI uses `AGENTORG_ACTOR_ID` and `AGENTORG_CREDENTIAL` together when set, otherwise the
local root's identity and credential files. Its identity is independent of an MCP session's
attachment. Creation makes a direct report of the caller:

```sh
agentorg actor create --name builds --purpose "Run the nightly builds"
agentorg team
agentorg activity
agentorg interfaces
agentorg call team --json '{"depth":2}'
```

`interfaces` returns `{tools: [...]}` from the core: each explicit Hub Tool has a stable `id`, a
`name`, and `interfaces` containing local descriptors and `call` aliases. Use that alias with
generic `call`, which prints `done {value}` or `refused {code, message}`. The generated convenience commands
continue to print their completed value.

`actor_create` can also request execution from an enrolled, connected Provider:

```sh
agentorg actor create --name builds --purpose "Run the nightly builds" --execution '{"providerId":"example","config":{}}'
```

`execution` is optional; when supplied, `providerId` and the JSON object `config` are required.
Use `{}` when the Provider needs no configuration. The command first creates the Actor, then asks
the Provider to create its implementation. Its result retains `actor` and `credential`, adding
`execution: {providerId, status, error?}`. Status is `ready`, `failed` or `unknown`; an error contains
`code` and `message`. Provider failure or uncertainty leaves the Actor and credential valid.
`ready` reports a successful Provider reply independently of the Actor's connection or MCP state.
Hub makes one creation request and does not replay it automatically after timeout or disconnect.

## Human client

[OrgActor-Human](https://github.com/uniac-ai/OrgActor-Human) owns the browser application,
its HTTP API and configuration. It connects to the Hub through the public Actor library
described below. Its repository owns installation, configuration and service management.

## Program clients

A program opens one bidirectional JSON-RPC 2.0 WebSocket at
`ws://127.0.0.1:8740/connection` and establishes its existing Actor identity:

```text
connection.connect({actorId, credential?}) -> {connectionId}
```

The handshake admits identity only; it creates no Actor and returns no service catalog.
Credentials are required under the default policy. A supplied invalid credential always fails.
Hub MCP initializes separately on that same socket. Every open Actor receives only the explicit
Hub Tools composed from feature modules. Each MCP entry carries `_meta["agentorg/tool"]` with
`id`, `name`, local `interface`, `one_way` and `long_running`, from which the Actor library
reconstructs its nested Tool catalog. Multiple admitted caller connections coexist.

The core refuses an `Origin` header, so this endpoint is for local processes. Human applications,
agent adapters and programs use the same Actor contract. Node programs use `connectClient` from
`@agentorg/cli/actor` with `actorId`, `credential` and `url` to list and call Hub Tools and reconnect
after a drop. Actor identity and Team metadata contain no advertised interfaces or native-session marker.
[design.md](design.md) owns the ports and protocol.

`@agentorg/cli/contract` supplies `BUILTINS`, the existing derived inventory of built-in request
and response schemas, plus public record schemas and the `Answer`, `InterfaceDescriptor` and
`ToolDescriptor` types. For example, `BUILTINS.actor_create.request.parse(input)` validates an
Actor creation request. Record exports such as `Actor`, `Position`, `DirectoryActor`, `Message`, `Work` and `Form` are Zod schemas;
`z.output<typeof Position>` derives a record's TypeScript type. Import the Actor connection API
from `./actor` and these wire contracts from `./contract`.

Work and Forms are shared records with full retained history for every active admitted Actor;
Messages remain private to their sender and recipient. Use `work_list` with `ownerID`,
`requesterID`, `status`, `ownerWithin` and `requesterWithin`, and `form_list` with `workID`,
`requesterID`, `respondentID`, `status`, `requesterWithin`, `respondentWithin`, `awaitingWithin`
and `awaitingActorID` for directed queries. All supplied filters AND before pagination. A query
for another Actor's criteria keeps your authenticated identity and write authority. An empty
recorded Form response counts as answered for `awaitingActorID`.

The Actor library requires `actorId` for `connectClient`. Custom clients must
send `connection.connect` before MCP initialization on `/connection`. Environment-based CLI
setup must supply both `AGENTORG_ACTOR_ID` and `AGENTORG_CREDENTIAL`.

## Provider enrollment

The server administrator enrolls Providers in `<AGENTORG_HOME>/providers.json`, readable only
by its owner (mode 600). The file contains an array of objects with exactly `providerId` and
`credentialHash`; the hash is the hexadecimal SHA-256 digest of the Provider's credential.
The Provider retains the credential privately. Restart the server to load enrollment changes.
An absent file admits no Providers; malformed or publicly readable configuration prevents startup.

A Provider initiates `/connection` and sends
`connection.connect({providerId, credential}) -> {connectionId}`. Its ID must already be enrolled.
The Hub's internal typed client uses `provider.describe({}) -> {configSchema}` and
`provider.createActor({actorId, credential?, config}) -> {actorId}` on this same socket. The latter
credential is the separate Actor bootstrap credential; it is never the Provider credential.
Configuration is a required JSON object, including `{}` when empty. Native execution references
stay with the Provider. Actor identity and organizational state remain in Hub across executor
replacement, and the Actor client establishes its own independent Hub connection.
