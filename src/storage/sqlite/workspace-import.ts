/** Historical sends cross the package's public persistence boundary; originals stay private. */
import { createHash, randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { MessageState } from "@uniac/agentic-workspace/contracts";
import type { WorkspaceStore } from "@uniac/agentic-workspace/persistence";
import type { Database } from "./database.ts";

export interface ImportBaseline {
  messageID: string;
  recipientID: string;
  cursor: number;
}

export function importLegacyMessages(
  database: Database,
  workspace: WorkspaceStore,
): ImportBaseline[] {
  const exists =
    database.all("SELECT name FROM sqlite_schema WHERE type='table' AND name='legacy_messages'")
      .length > 0;
  if (!exists) return [];
  const sources = database.all("SELECT * FROM legacy_messages ORDER BY cursor,id").map((source) => {
    const messageID = String(source.id);
    const state = {
      messageID,
      senderID: source.from,
      recipientID: source.to,
      text: source.text,
      createdAt: source.created_at,
    };
    const parsed = MessageState.safeParse(state);
    if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(state)) {
      throw new Error(
        `Legacy message ${messageID}: source fields cannot be preserved by the Message schema`,
      );
    }
    for (const party of [parsed.data.senderID, parsed.data.recipientID]) {
      if (!database.get("actors", party))
        throw new Error(`Legacy message ${messageID}: unknown canonical party`);
    }
    const sourceHash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    const prior = database.all("SELECT * FROM workspace_imports WHERE message_id=?", [
      messageID,
    ])[0];
    if (prior && prior.source_hash !== sourceHash)
      throw new Error(`Legacy message ${messageID}: original source changed`);
    return { state: parsed.data, sourceHash, prior };
  });
  const imported = workspace.transaction(() =>
    sources.map(({ state, sourceHash, prior }) => {
      const expectedEvent = {
        actorID: state.senderID,
        at: state.createdAt,
        action: "sent",
        detail: { recipientID: state.recipientID, text: state.text },
      };
      const existing = workspace.messages.get(state.messageID);
      if (prior && !existing)
        throw new Error(`Legacy message ${state.messageID}: imported record is missing`);
      if (existing) {
        const { revision, cursor, ...data } = existing;
        const events = workspace.messages.history(state.messageID);
        const expectedHistory = [{ ...expectedEvent, revision: 1, cursor }];
        const same = (left: unknown, right: unknown) =>
          JSON.stringify(left) === JSON.stringify(right);
        if (
          revision !== 1 ||
          !same(data, state) ||
          !same(events, expectedHistory) ||
          (prior && prior.workspace_cursor !== cursor)
        ) {
          throw new Error(
            `Legacy message ${state.messageID}: imported record conflicts with original send`,
          );
        }
        return { state, sourceHash, cursor };
      }
      const saved = workspace.messages.save(state.messageID, state, expectedEvent);
      return { state, sourceHash, cursor: saved.cursor };
    }),
  );
  database.transaction(() => {
    for (const { state, sourceHash, cursor } of imported)
      database.run(
        "INSERT INTO workspace_imports(message_id,source_hash,recipient_id,workspace_cursor) VALUES(?,?,?,?) ON CONFLICT(message_id) DO NOTHING",
        [state.messageID, sourceHash, state.recipientID, cursor],
      );
  });
  return imported.map(({ state, cursor }) => ({
    messageID: state.messageID,
    recipientID: state.recipientID,
    cursor,
  }));
}

export function writeImportBaseline(path: string, messages: ImportBaseline[]): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({ purpose: "Historical import baseline; not a processing or delivery receipt", messages }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
