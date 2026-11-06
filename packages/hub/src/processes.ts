import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Duplex as NodeDuplex, type Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Duplex } from "@agentorg/sdk";
import { Refused } from "@agentorg/sdk";
import { appendLogs, type LogLine, outputEntry } from "./logs.js";
import type { ChannelHandle } from "./router.js";
import type { Exit, HubState } from "./state.js";

/** Whether this machine can run host processes now, and if not, why and what to do. */
export interface HostStatus {
  available: boolean;
  reason?: string;
}

export interface ProcessOptions {
  /**
   * The sandbox a host process runs in: the command and arguments put before `node …`. By default,
   * `sandbox-exec` on macOS and `unshare` on Linux; tests may give another (one that fails, say).
   */
  sandbox?: string[];
  /** Heap limit of each process, in MB. */
  memoryMb?: number;
  /** How long a process has to say hello. */
  helloMs?: number;
  /** How long `stop` waits after SIGTERM before SIGKILL. */
  stopMs?: number;
  /** The first restart's delay after a crash; each next one doubles, up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Up this long, a process's next crash starts the backoff over. */
  resetAfterMs?: number;
}

/**
 * No network (DNS included) and no signals to other processes. Files, child processes and workers
 * are closed by Node's permission model inside it.
 */
const MAC_PROFILE = `(version 1)
(allow default)
(deny network*)
(deny mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.dnssd.service"))
(deny signal)
(allow signal (target self))`;

/**
 * Run inside the Linux namespaces, before node: build a root that holds only the command (node),
 * its libraries, the given paths, four devices and a fresh /proc, all read-only; pivot into it,
 * and detach the host's root, so no host path is visible at all. Its arguments: the empty
 * directory to build the root on, the paths to bind, `--`, then the command. It starts with an
 * empty environment, and the command gets one too.
 */
const LINUX_ROOT = `set -e
PATH=/usr/sbin:/usr/bin:/sbin:/bin
root="$1"; shift
mount -t tmpfs -o mode=0755 sandbox "$root"
# One host path into the root, at its own place, read-only; a path already there is skipped.
bind() {
  [ -e "$root$1" ] && return 0
  if [ -d "$1" ]; then mkdir -p "$root$1"; else mkdir -p "$root\${1%/*}"; : > "$root$1"; fi
  mount --bind "$1" "$root$1"
  mount -o remount,bind,ro "$root$1"
}
while [ "$1" != "--" ]; do bind "$1"; shift; done
shift
# The command and what it loads: its loader by its own path, its libraries after "=>".
bind "$1"
ldd "$1" 2>/dev/null | awk '/=>/ && index($3, "/") == 1 {print $3} !/=>/ && index($1, "/") == 1 {print $1}' |
  while IFS= read -r lib; do bind "$lib"; done
for device in null zero random urandom; do bind "/dev/$device"; done
mkdir "$root/proc" "$root/.old"
mount -t proc -o ro proc "$root/proc"
# umount runs once more after the pivot, from the old root, through its own loader and libraries.
umount_bin=$(readlink -f "$(command -v umount)")
umount_loader=$(ldd "$umount_bin" 2>/dev/null | awk '!/=>/ && index($1, "/") == 1 {print $1}')
if [ -n "$umount_loader" ]; then umount_loader=$(readlink -f "$umount_loader"); fi
umount_libs=$(ldd "$umount_bin" 2>/dev/null | awk '/=>/ && index($3, "/") == 1 {print $3}' |
  while IFS= read -r lib; do lib=$(readlink -f "$lib"); printf '/.old%s:' "\${lib%/*}"; done)
# Read-only as a mount (a superblock remount is refused in some kernels' user namespaces).
mount -o remount,bind,ro "$root"
cd "$root"
pivot_root . .old
if [ -n "$umount_loader" ]; then
  "/.old$umount_loader" --library-path "$umount_libs" "/.old$umount_bin" -l /.old
else
  "/.old$umount_bin" -l /.old
fi
cd /
unset PATH PWD OLDPWD SHLVL
# bash (/bin/sh on some distributions) puts SHLVL back on exec unless told to clear everything.
if [ -n "$BASH_VERSION" ]; then exec -c "$@"; fi
exec "$@"`;

/**
 * The sandbox command for a process that may read `paths`: on macOS, sandbox-exec with the
 * profile; on Linux, a user, network, PID and mount namespace (no network or DNS, no other process
 * to signal) with the minimal root above, built on `rootDir`. Root inside the namespace is nobody
 * outside it (--map-root-user: util-linux before 2.38 lacks --map-current-user).
 */
function defaultSandbox(rootDir: string, paths: string[]): string[] | undefined {
  if (process.platform === "darwin") return ["sandbox-exec", "-p", MAC_PROFILE];
  if (process.platform === "linux")
    return [
      "unshare",
      "--user",
      "--map-root-user",
      "--net",
      "--pid",
      "--fork",
      "--kill-child",
      "--mount",
      "--propagation",
      "private",
      "/bin/sh",
      "-c",
      LINUX_ROOT,
      "sandbox",
      rootDir,
      ...paths,
      "--",
    ];
  return undefined;
}

/** Why host processes can't start on this machine, said so the person knows what to do. */
function unavailable(detail: string): string {
  const what = detail ? ` (${detail})` : "";
  if (process.platform === "linux")
    return /uid_map|setgroups/i.test(detail)
      ? `Host Actors can't start on this machine: it doesn't let an unprivileged process make the user namespace their sandbox needs${what}. On Ubuntu, AppArmor restricts this; allow it with \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\` (and in /etc/sysctl.d to keep it).`
      : `Host Actors can't start on this machine: their sandbox (unshare, and a minimal root built with mount and pivot_root) didn't run${what}.`;
  if (process.platform === "darwin")
    return `Host Actors can't start on this machine: their sandbox, sandbox-exec, didn't run${what}.`;
  return `Host Actors can't start on this machine: there's no sandbox for host processes on ${process.platform} yet.`;
}

/** Lines one Actor's process may write per window; past them, the rest of the window is dropped. */
const MAX_LINES = 500;
const LINE_WINDOW_MS = 10_000;
/** A line longer than this is cut, and the rest of it dropped. */
const MAX_LINE = 64 * 1024;

/** One running (or restarting) Actor's process. */
interface Entry {
  child?: ChildProcess;
  /** Set by `stop`: the exit that follows isn't a crash, and settles this. */
  stopping?: { done(): void; stopped: Promise<void> };
  /** A restart waiting out its backoff. */
  restart?: NodeJS.Timeout;
  /** Consecutive crashes since the backoff last started over. */
  crashes: number;
  startedAt: number;
  /** Its output's lines in the current window. */
  lines: { start: number; count: number };
}

/**
 * The Hub's host processes: one per running package Actor, spawned under Node's permission model
 * inside the OS sandbox, with an empty environment and the channel on fd 3. A process that exits
 * without `stop` asking is a crash: it is restarted after a backoff while its Actor is `running`.
 */
export class Processes {
  readonly #state: HubState;
  readonly #accept: (channel: Duplex, admitted: { actorId: string }) => ChannelHandle;
  readonly #options: Required<Omit<ProcessOptions, "sandbox">> & { sandbox?: string[] };
  /** Where the Linux sandbox builds each process's root (inside its own mount namespace). */
  readonly #rootDir: string;
  /** The runner, as a real path: Node's permission model matches resolved paths. */
  readonly #runner = realpathSync(
    fileURLToPath(import.meta.resolve("@agentorg/sdk/host/runner.js")),
  );
  readonly #entries = new Map<string, Entry>();
  #status: HostStatus | undefined;
  #closed = false;

  constructor(
    state: HubState,
    accept: (channel: Duplex, admitted: { actorId: string }) => ChannelHandle,
    options: ProcessOptions = {},
  ) {
    this.#state = state;
    this.#accept = accept;
    this.#rootDir = join(realpathSync(state.home), "sandbox-root");
    mkdirSync(this.#rootDir, { recursive: true, mode: 0o700 });
    this.#options = {
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      memoryMb: options.memoryMb ?? 256,
      helloMs: options.helloMs ?? 30_000,
      stopMs: options.stopMs ?? 5_000,
      backoffMs: options.backoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      resetAfterMs: options.resetAfterMs ?? 600_000,
    };
  }

  /** The last probe's answer; none before the first. */
  get status(): HostStatus | undefined {
    return this.#status;
  }

  /**
   * Run the sandbox once, around `node -e 0`, and keep what it says. A change is audited, and once
   * the host is available, Actors recorded as `running` without a process are started.
   */
  /** The sandbox command for a process that may read `paths`; none where there is no sandbox. */
  #sandbox(paths: string[]): string[] | undefined {
    return this.#options.sandbox ?? defaultSandbox(this.#rootDir, paths);
  }

  async probe(): Promise<HostStatus> {
    // The runner is bound as every process's is, so the probe proves the binds work too.
    const sandbox = this.#sandbox([this.#runner]);
    const status: HostStatus = sandbox
      ? await new Promise((resolve) =>
          execFile(
            sandbox[0] as string,
            [...sandbox.slice(1), process.execPath, "-e", "0"],
            { env: {}, timeout: 10_000, killSignal: "SIGKILL" },
            (error, _stdout, stderr) =>
              resolve(
                error
                  ? {
                      available: false,
                      reason: unavailable(
                        error.killed
                          ? "it didn't finish within 10 s"
                          : String(stderr).trim().slice(0, 300) || error.message,
                      ),
                    }
                  : { available: true },
              ),
          ),
        )
      : { available: false, reason: unavailable("") };
    if (this.#closed) return status;
    const changed = this.#status?.available !== status.available;
    this.#status = status;
    if (changed) {
      this.#state.auditHub("host.status", { ...status });
      if (status.available) this.#resume();
    }
    return status;
  }

  /** Start every Actor recorded as `running` that has no process. */
  #resume() {
    for (const actor of this.#state.actors())
      if (
        actor.state === "running" &&
        actor.package !== "external" &&
        actor.package !== "builtin" &&
        !this.#entries.has(actor.actorId)
      )
        this.start(actor.actorId);
  }

  /**
   * Spawn an Actor's process, unless it has one (or one restarting). One still stopping is let go
   * first; then a process is spawned if the Actor is still `running`.
   */
  start(actorId: string): void {
    if (this.#closed) return;
    const current = this.#entries.get(actorId);
    if (current?.stopping) {
      void current.stopping.stopped.then(() => {
        if (this.#isRunning(actorId)) this.start(actorId);
      });
      return;
    }
    if (current) return;
    const entry: Entry = { crashes: 0, startedAt: Date.now(), lines: { start: 0, count: 0 } };
    this.#entries.set(actorId, entry);
    this.#spawn(actorId, entry);
  }

  #isRunning(actorId: string): boolean {
    try {
      return this.#state.actor(actorId).state === "running";
    } catch {
      return false; // The state is closed.
    }
  }

  /**
   * Spawn the process and take its channel. Whatever goes wrong on the way (the sandbox missing,
   * no file descriptors left, the channel refused) ends as an exit, so it is a crash like any
   * other and never a throw.
   */
  #spawn(actorId: string, entry: Entry) {
    entry.restart = undefined;
    entry.startedAt = Date.now();
    let child: ChildProcess | undefined;
    let hello: NodeJS.Timeout | undefined;
    let channel: ChannelHandle | undefined;
    let ended = false;
    const end = (code: number | null, signal: NodeJS.Signals | null) => {
      if (ended) return;
      ended = true;
      clearTimeout(hello);
      channel?.close();
      this.#exited(actorId, entry, { code, signal, at: new Date().toISOString() });
    };
    try {
      const actor = this.#state.actor(actorId);
      const packageDir = realpathSync(join(this.#state.home, "packages", actor.package));
      const node = [
        process.execPath,
        "--permission",
        `--allow-fs-read=${this.#runner}`,
        `--allow-fs-read=${packageDir}/`,
        `--max-old-space-size=${this.#options.memoryMb}`,
        this.#runner,
        packageDir,
        actorId,
      ];
      const sandbox = this.#sandbox([this.#runner, packageDir]);
      if (!sandbox) throw new Error("There is no sandbox here.");
      const [command, ...args] = [...sandbox, ...node] as [string, ...string[]];
      // Its own process group, so stop's signals reach the sandboxed node too.
      const spawned = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: {},
        detached: true,
      });
      child = spawned;
      entry.child = spawned;
      spawned.once("exit", (code, signal) => end(code, signal));
      // A process that never started (no such sandbox, no resources) has no exit to come.
      spawned.once("error", () => {
        if (spawned.pid === undefined) end(null, null);
      });
      if (spawned.pid === undefined) return;
      const pipe = spawned.stdio[3];
      if (!pipe) throw new Error("The process has no channel.");
      this.#capture(actorId, entry, "stdout", spawned.stdout);
      this.#capture(actorId, entry, "stderr", spawned.stderr);
      const accepted = this.#accept(NodeDuplex.toWeb(pipe as NodeDuplex) as unknown as Duplex, {
        actorId,
      });
      channel = accepted;
      // No hello in time is a crash; so is the channel going while the process lives on (unless
      // it is stopping: stop's own grace applies).
      hello = setTimeout(() => this.#kill(spawned, "SIGKILL"), this.#options.helloMs);
      void accepted.admitted.then(() => clearTimeout(hello));
      void accepted.closed.then(() => {
        clearTimeout(hello);
        if (!entry.stopping) this.#kill(spawned, "SIGKILL");
      });
    } catch {
      if (child) this.#kill(child, "SIGKILL");
      else end(null, null);
    }
  }

  #exited(actorId: string, entry: Entry, exit: Exit) {
    const stopping = entry.stopping?.done;
    if (this.#closed) return stopping?.();
    const crashed = !stopping && this.#isRunning(actorId);
    try {
      this.#state.recordExit(actorId, exit, crashed);
    } catch {
      // The state is closed.
    }
    if (!crashed) {
      this.#entries.delete(actorId);
      stopping?.();
      return;
    }
    // Up long enough, the backoff starts over.
    if (Date.now() - entry.startedAt >= this.#options.resetAfterMs) entry.crashes = 0;
    const delay = Math.min(
      this.#options.backoffMs * 2 ** entry.crashes,
      this.#options.maxBackoffMs,
    );
    entry.crashes++;
    entry.child = undefined;
    entry.restart = setTimeout(() => this.#spawn(actorId, entry), delay);
  }

  /** Stop an Actor's process: SIGTERM, then SIGKILL after the grace; a waiting restart is dropped. */
  stop(actorId: string): Promise<void> {
    const entry = this.#entries.get(actorId);
    if (!entry) return Promise.resolve();
    if (entry.stopping) return entry.stopping.stopped;
    if (entry.restart || !entry.child) {
      clearTimeout(entry.restart);
      this.#entries.delete(actorId);
      return Promise.resolve();
    }
    const child = entry.child;
    let done!: () => void;
    const stopped = new Promise<void>((resolve) => {
      done = resolve;
    });
    const kill = setTimeout(() => this.#kill(child, "SIGKILL"), this.#options.stopMs);
    entry.stopping = {
      done: () => {
        clearTimeout(kill);
        done();
      },
      stopped,
    };
    this.#kill(child, "SIGTERM");
    return stopped;
  }

  /** Signal a live process's whole group: the sandbox and the node it runs. */
  #kill(child: ChildProcess, signal: NodeJS.Signals) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  }

  /**
   * A process's output, into its Actor's log, one append per chunk. A line is cut at 64 KiB and
   * the rest of it dropped; past 500 lines in 10 s, the window's remaining lines are dropped, and
   * one entry says so.
   */
  #capture(actorId: string, entry: Entry, stream: "stdout" | "stderr", from: Readable | null) {
    let pending = "";
    /** Inside a line already cut: dropped until its end. */
    let skipping = false;
    const take = (lines: string[]) => {
      if (this.#closed) return;
      const entries: LogLine[] = [];
      const now = Date.now();
      for (const line of lines) {
        if (!line) continue;
        if (now - entry.lines.start > LINE_WINDOW_MS) entry.lines = { start: now, count: 0 };
        const count = ++entry.lines.count;
        if (count <= MAX_LINES) entries.push(outputEntry(stream, line));
        else if (count === MAX_LINES + 1)
          entries.push(
            outputEntry(
              "stdout",
              `The process wrote more than ${MAX_LINES} lines in ${LINE_WINDOW_MS / 1000} s; the rest are dropped for now.`,
            ),
          );
      }
      try {
        appendLogs(this.#state.home, actorId, entries);
      } catch {
        // The disk's trouble: the lines are lost, nothing else.
      }
    };
    from?.setEncoding("utf8");
    from?.on("data", (chunk: string) => {
      let text = chunk;
      if (skipping) {
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        skipping = false;
        text = text.slice(newline + 1);
      }
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > MAX_LINE) {
        lines.push(pending.slice(0, MAX_LINE));
        pending = "";
        skipping = true;
      }
      take(lines);
    });
    from?.on("end", () => take([pending]));
  }

  /** Refused unless host processes can start here: the probe runs again first. */
  async ready(): Promise<void> {
    const status = await this.probe();
    if (!status.available)
      throw new Refused("unsupported", status.reason ?? "Host Actors can't start here.");
  }

  /** The Hub is closing: every process is killed, stops in flight are settled, nothing restarts. */
  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      if (entry.restart) clearTimeout(entry.restart);
      if (entry.child) this.#kill(entry.child, "SIGKILL");
      entry.stopping?.done();
    }
    this.#entries.clear();
  }
}
