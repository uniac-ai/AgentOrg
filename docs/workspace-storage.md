# Workspace storage and cutover

Hub embeds `@uniac/agentic-workspace` 0.4.0 at source `50d278749df452e70dafa8c34541098383dbece1`,
merged as `ffc917100c0d5ec7000ec51a64026aed3805173a` with tree
`4329b8163dab4ee65272ec112749aa9d50370834`.
The committed archive has SHA256
`87f68d391d8a36504b2bfccd2a35b8287478c70082547877658acd5f0b648d2e`.
`vendor/workspace.json`, the dependency and lockfile identify the same archive. `npm pack` bundles
the installed package so a separate consumer can install the SDK without a sibling checkout or
registry publication of Workspace. Hub uses public package contracts, clients and persistence;
the package owns its SQLite schema and transactions.

## Files and startup

For `<home>/core.db`, Hub opens `<home>/core.workspace.db` for Messages, Work and Forms.
The private import manifest is `<home>/core.workspace.db.import.json`. Database and manifest files
are private to the home owner. `:memory:` uses two independently owned in-memory databases.
Hub closes both stores after its network listener and clients finish.

Fresh homes start at Hub schema 9. Schema 7 first retires Actor execution records through the
existing schema 8 transaction. Schema 8 then atomically renames `progress`, `questions` and
`messages` to private `legacy_*` tables and creates `workspace_imports`, advancing to schema 9.
The original rows and fields remain intact. Other nonzero versions are refused.

Historical Messages are imported through the package's public persistence interface. Each preserves
its original ID, sender, recipient, text and timestamp exactly. The sole public history event records
the original send provenance and original time. Unsupported legacy links, reply metadata and read
metadata stay in the private original row. The ledger stores SHA256 of the full original row and
the assigned module cursor. Read/handled audit events also remain private.

Import validates every source before writing. A value requiring trimming or timestamp conversion,
an unknown party, a changed original, a conflicting record, or a missing previously imported record
prevents startup. Operators must resolve the exact source case before proceeding; startup does not
invent replacement data. Legacy progress and Questions remain private history; they do not create
Work, Forms, answers or approvals.

The package transaction commits before the Hub import ledger transaction. Restart verifies any
already committed record and its exact single send event before completing the ledger, so a crash
between commits does not append another send. The private manifest is atomically written after
both commits and can be rematerialized on restart. It contains only `{messageID, recipientID, cursor}`
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
