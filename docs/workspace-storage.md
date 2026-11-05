# Workspace storage and cutover

Hub embeds `@uniac/agentic-workspace` 0.0.1 from source `8b46282f515ee9f69f7bd649b68da46135dbbe41`,
merged as `95ebd39c91c68d7a57aa5ee37853ad29f8d636e5` with tree
`3b6f30cab4edec75db8f3cf076460e2b2808d869`: the flat organization, after the v0.0.1 release. The
committed archive has SHA256 `437e8e6f874c403a856922cfae7dc54fb3554072f7ce567b0a34e7e3ecfb3b05`;
its version string is still 0.0.1, so it is told apart from the v0.0.1 release asset by that hash. It is a clean `git archive`
export of the source, built with `npm ci --engine-strict` and `npm pack` on Node 24.22.1 and
npm 11.19.1, which reproduces the archive byte for byte.
`vendor/workspace.json`, the dependency and lockfile identify the same archive. `npm pack` bundles
the installed package so a separate consumer can install the SDK without a sibling checkout or
registry publication of Workspace. Hub uses public package contracts, clients and persistence;
the package owns its SQLite schema and transactions.

## Files and startup

For `<home>/core.db`, Hub opens `<home>/core.workspace.db` for Messages, and Work with its asks.
On its first open, the package upgrades an earlier `core.workspace.db` in place, in one transaction,
to its storage version 4, and refuses a store newer than itself. From version 3 the step adds
indexed columns and changes no record, and an earlier store's Status tables stay in the file,
unread. The upgrade is one way, so back up the home before the first start: restoring that backup
is the way back.
The private import manifest is `<home>/core.workspace.db.import.json`. Database and manifest files
are private to the home owner. `:memory:` uses two independently owned in-memory databases.
Hub closes both stores after its network listener and clients finish.

Fresh homes start at Hub schema 10. Schema 7 first retires Actor execution records through the
existing schema 8 transaction. Schema 8 then atomically renames `progress`, `questions` and
`messages` to private `legacy_*` tables and creates `workspace_imports`, advancing to schema 9.
Schema 9 makes handles unique among open Actors rather than among siblings: each later open
duplicate, in creation order, takes the first free `<handle>-2`, `<handle>-3` and so on, and one
index of open handles replaces the `one_root` and sibling-handle indexes, advancing to schema 10.
The original rows and fields remain intact, apart from those renamed handles. Other nonzero versions are refused. Every open also
adds the audit's two indexes, of each Actor's writes and of its writes on each record, if they are
missing; they take no schema step, so an earlier build still opens the home.

Historical Messages are imported through the package's public persistence interface. Each preserves
its original ID, sender, recipient, text and timestamp exactly. The sole public history event records
the original send provenance and original time. Unsupported legacy links, reply metadata and read
metadata stay in the private original row. The ledger stores SHA256 of the full original row and
the assigned module cursor. Read/handled audit events also remain private.

Import validates every source before writing. A value requiring trimming or timestamp conversion,
an unknown party, a changed original, a conflicting record, or a missing previously imported record
prevents startup. Operators must resolve the exact source case before proceeding; startup does not
invent replacement data. Legacy progress and Questions remain private history; they do not create
Work, asks, answers or approvals.

The package transaction commits before the Hub import ledger transaction. Restart verifies any
already committed record and its exact single send event before completing the ledger, so a crash
between commits does not append another send. The check compares the stored Message's fields
without its `revision`, `cursor` and `updatedAt`, which the package keeps beside them. The private
manifest is atomically written after both commits and can be rematerialized on restart. Its
`cursor` is the Message's public `seq`. It contains only `{messageID, recipientID, cursor}`
under `messages`, with an explicit historical-baseline label. It is not a processing receipt.

## Coordinated cutover and rollback

1. Stop the Hub and clients using the home at the authorized cutover. Retain a consistent private
   backup of the entire home, launchers, configuration and original runtime before opening it with
   the new code. Rehearse against an owned copy first.
2. Start the new Hub on the retained home. Check identity continuity, both databases, imported
   Messages and the private baseline. A failed startup may have completed one or both database
   commits; restarting the same candidate is the supported recovery path.
3. Coordinate each client's historical delivery baseline before enabling model/native input.
   Imported Message cursors can be treated as historical from the private manifest. Legacy shared
   correspondence cursors have no meaning in the new independent module sequences. A newly attached
   client starting at zero traverses all records currently visible to it.
4. Preserve later writes. Before new writes are accepted, rollback can restore the complete stopped
   pre-cutover home and original runtime together. After accepting new writes, reverting requires a
   deliberate reconciliation; replacing one database or restoring an old snapshot would lose state.

For subsequent backups, stop the Hub and preserve `core.db`, `core.workspace.db`, the private
manifest, retained `legacy_*` tables/ledger, credentials and configuration together. When copying
SQLite files, include any WAL state or use SQLite's consistent backup facility. Keep both stores
from the same stopped instance. Never restore only one database over a running Hub.
