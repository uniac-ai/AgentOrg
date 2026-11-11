// A computer's files, over its `files@1` surface: walk the workspace's folders, open a file, bring
// one in, take one out. Nothing here deletes or renames. Each request is answered by its id; a
// file's bytes come as one binary message right after the answer that says what they are.
import { ArrowLeftIcon, DownloadIcon, FileIcon, FolderIcon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import { age } from "./chat-parts.tsx";
import type { ViewerProps } from "./computer.tsx";
import { REFRESH_MS, useEvery } from "./data.ts";
import { useLive } from "./live-socket.ts";

/** The most of a file one request reads or writes, which is the most the surface takes. */
const PART = 1_048_576;

interface Entry {
  name: string;
  kind: "file" | "folder" | "link";
  size: number;
  modifiedAt: string;
}
/** What the surface answers, by the id of what was asked; `bytes` are a read's. */
type Answer =
  | { type: "entries"; entries: Entry[] }
  | { type: "data"; size: number; modifiedAt: string; bytes: ArrayBuffer }
  | { type: "written" }
  | { type: "refused"; message: string };

const sized = (bytes: number) =>
  bytes < 1000
    ? `${bytes} B`
    : bytes < 1e6
      ? `${(bytes / 1000).toFixed(1)} KB`
      : `${(bytes / 1e6).toFixed(1)} MB`;
const under = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

export function FilesView({ target, corner }: ViewerProps) {
  const operate = target.mode === "operate";
  const tick = useEvery(REFRESH_MS);
  /** The folder shown, from the workspace: empty for the workspace itself. */
  const [folder, setFolder] = useState("");
  /** A folder's entries, with the folder they are of: rows are only ever those of the one shown. */
  const [listed, setListed] = useState<{ folder: string; entries: Entry[] }>();
  /** The file that is open, with its words once they are read. */
  const [file, setFile] = useState<{ path: string; text?: string }>();
  const [sent, setSent] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const asked = useRef(new Map<string, (answer: Answer) => void>());
  /** The answer whose bytes are the next binary message. */
  const coming = useRef<(bytes: ArrayBuffer) => void>(undefined);
  const count = useRef(0);
  const live = useLive(target, (frame) => {
    if (typeof frame !== "string") {
      coming.current?.(frame);
      coming.current = undefined;
      return;
    }
    const answer = JSON.parse(frame) as Answer & { id: string };
    const done = asked.current.get(answer.id);
    asked.current.delete(answer.id);
    if (answer.type === "data") coming.current = (bytes) => done?.({ ...answer, bytes });
    else done?.(answer);
  });
  const open = live.state.phase === "open";
  const closed = live.state.phase === "closed";
  // A socket that closed answers nothing more: what was asked of it is told so, and it is opened
  // again as often as what has no event is read again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is this socket's own.
  useEffect(() => {
    if (!closed) return;
    for (const done of asked.current.values()) done({ type: "refused", message: "" });
    asked.current.clear();
    coming.current = undefined;
    const timer = setTimeout(live.again, REFRESH_MS);
    return () => clearTimeout(timer);
  }, [closed]);
  /** Sends a request under an id of its own, with its bytes right after it if it has any. */
  const post = (request: Record<string, unknown>, bytes?: ArrayBuffer) => {
    const id = String(++count.current);
    live.send(JSON.stringify({ ...request, id }));
    if (bytes) live.send(bytes);
    return id;
  };
  /** Sends a request and answers with what the surface says of it: nothing, while it is closed. */
  const ask = (request: Record<string, unknown>, bytes?: ArrayBuffer) =>
    new Promise<Answer>((done) =>
      open ? asked.current.set(post(request, bytes), done) : done({ type: "refused", message: "" }),
    );

  // The folder is read when it is shown, after something is brought in, and again as often as
  // what has no event is read again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ask` is this socket's own.
  useEffect(() => {
    if (!open) return;
    let current = true;
    void ask({ type: "list", ...(folder ? { path: folder } : {}) }).then((answer) => {
      if (current)
        setListed(answer.type === "entries" ? { folder, entries: answer.entries } : undefined);
    });
    return () => {
      current = false;
    };
  }, [open, folder, tick, sent]);

  const show = async (path: string) => {
    setFile({ path });
    const answer = await ask({ type: "read", path, offset: 0, length: PART });
    if (answer.type !== "data") return;
    // What isn't text has no words to show. A longer file's first part may end inside a letter.
    let text = "";
    try {
      const more = answer.size > answer.bytes.byteLength;
      text = new TextDecoder("utf-8", { fatal: true }).decode(answer.bytes, { stream: more });
    } catch {}
    setFile((was) => (was?.path === path ? { path, text } : was));
  };
  /**
   * The whole file, read a part at a time, handed to the person to keep. One that can't be read
   * whole, or that changes on the way, isn't handed over in part.
   */
  const save = async (path: string) => {
    const parts: ArrayBuffer[] = [];
    let stamp: string | undefined;
    for (let offset = 0, size = 1; offset < size; ) {
      const answer = await ask({ type: "read", path, offset, length: PART });
      if (answer.type !== "data" || (stamp ?? answer.modifiedAt) !== answer.modifiedAt) return;
      if (answer.bytes.byteLength === 0) break;
      parts.push(answer.bytes);
      offset += answer.bytes.byteLength;
      ({ size, modifiedAt: stamp } = answer);
    }
    const link = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob(parts)),
      download: path.split("/").at(-1),
    });
    link.click();
    URL.revokeObjectURL(link.href);
  };
  /**
   * Each file chosen goes into the folder shown, a part at a time, each part read only when it is
   * its turn. The last part puts the file there and is answered; a part that is refused is
   * answered too, and ends that file.
   */
  const bring = async (chosen: File[]) => {
    for (const one of chosen) {
      const path = under(folder, one.name);
      const sent: string[] = [];
      let refused = false;
      for (let offset = 0, last = false; !last && !refused; offset += PART) {
        const part = await one.slice(offset, offset + PART).arrayBuffer();
        last = offset + PART >= one.size;
        const request = { type: "write", path, offset, length: part.byteLength, last };
        if (last) await ask(request, part);
        else {
          const id = post(request, part);
          sent.push(id);
          asked.current.set(id, () => {
            refused = true;
          });
        }
      }
      for (const id of sent) asked.current.delete(id);
    }
    setSent((was) => was + 1);
  };
  const up = () =>
    file ? setFile(undefined) : setFolder(folder.split("/").slice(0, -1).join("/"));
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col text-[15px] leading-[1.5]">
      {/* The first row: which files. */}
      <div className="flex h-11 shrink-0 items-center gap-1 pr-1.5 pl-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div role="tablist" aria-label="Which files" className="flex gap-1">
            <button
              type="button"
              role="tab"
              aria-selected
              className="h-8 min-w-0 shrink truncate rounded-lg bg-[var(--selected)] px-3 text-[13px] font-medium text-foreground"
              onClick={() => setFile(undefined)}
            >
              All
            </button>
          </div>
        </div>
        {corner}
      </div>
      {/* The second row: where it is, with the way up, and what can be brought in or taken out. */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Up"
          disabled={!file && !folder}
          onClick={up}
        >
          <ArrowLeftIcon />
        </Button>
        {/* biome-ignore lint/a11y/useSemanticElements: one value with its name, not a set of fields. */}
        <span
          role="group"
          aria-label="Folder"
          className="ml-1 flex h-8 min-w-0 flex-1 items-center truncate rounded-full bg-[var(--raised)] px-3.5 font-mono text-xs outline-none"
        >
          {file ? file.path : folder}
        </span>
        {file ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-1"
            aria-label="Download"
            onClick={() => void save(file.path)}
          >
            <DownloadIcon />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-1"
            aria-label="Upload"
            disabled={!operate}
            onClick={() => picker.current?.click()}
          >
            <UploadIcon />
          </Button>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="Files to upload"
          onChange={(event) => {
            // Taken out of the box before it is emptied, so the same file can be chosen again.
            void bring([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </div>
      <div className="no-bar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {file ? (
          <pre className="mt-1 rounded-lg bg-[var(--raised)] px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {file.text ?? ""}
          </pre>
        ) : (
          <ul aria-label="Files">
            {(listed?.folder === folder ? listed.entries : []).map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  onClick={() =>
                    entry.kind === "folder"
                      ? setFolder(under(folder, entry.name))
                      : void show(under(folder, entry.name))
                  }
                  className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-[var(--hover)]"
                >
                  {entry.kind === "folder" ? (
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.name}</span>
                  {entry.kind === "folder" ? (
                    <span className="w-[130px] shrink-0" />
                  ) : (
                    <>
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {sized(entry.size)}
                      </span>
                      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {age(entry.modifiedAt)}
                      </span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
