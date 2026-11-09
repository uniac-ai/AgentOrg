// Carrying a home from an earlier release. Its agents are made again by the agent provider, under
// the same names, with their transcripts and chosen models. Its old Actors are closed, never
// removed. `storage.db` is only ever read, from a private copy, so it stays as it was; `hub.db` is
// copied aside before anything changes it. The plan is written first and kept up to date, so a
// start that stops part way picks up where it left off, and carrying twice makes nothing twice.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HubState, PERSON } from "@agentorg/hub";
import { agentRecord } from "assistant/provider";
import type { PersonCalls } from "./model.js";
import { programDir } from "./programs.js";

/** One earlier agent: `agent` once it is made again, `done` once its record is in. */
export interface CarryEntry {
  old: string;
  name: string;
  agent?: string;
  done?: boolean;
}
export interface CarryPlan {
  agents: CarryEntry[];
  done?: boolean;
}
export interface Carry {
  readonly plan: CarryPlan;
  /** Make each agent again and bring its record in; the plan says how far it got. */
  finish(person: PersonCalls, log: (message: string) => void): Promise<void>;
  /** Delete the private copy of `storage.db`. */
  discard(): void;
}

/** How long the provider has to reach management once first run has connected it. */
const PROVIDER_MS = 15_000;
const PROVIDER_EVERY_MS = 50;
/** The store an agent of an earlier release kept its record in, and the record's keys. */
const AGENT_SLOT = "logic.store";
const RECORD_WHERE = "(key LIKE 'msg/%' OR key = 'settings/model')";
/** The earlier first run's record, which names the assistant builds it made agents from. */
const FIRST_RUN = { consumer: PERSON, slot: "store", key: "app/first-run" };
const ASIDE = ".before-carry";
const SUFFIXES = ["", "-wal", "-shm"];

function savePlan(file: string, plan: CarryPlan) {
  writeFileSync(`${file}.tmp`, JSON.stringify(plan), { mode: 0o600, flush: true });
  renameSync(`${file}.tmp`, file);
}

/**
 * Before the Hub opens: if this home has an earlier release's `storage.db` and hasn't been carried,
 * copy `hub.db` aside, take a private copy of `storage.db`, write the plan and close the old
 * Actors. Nothing is done for a home with nothing to carry.
 */
export function prepareCarry(home: string): Carry | undefined {
  const dir = join(home, "carry");
  const planFile = join(dir, "plan.json");
  const hubFile = join(home, "hub.db");
  const storageFile = join(home, "storage.db");
  let plan = existsSync(planFile)
    ? (JSON.parse(readFileSync(planFile, "utf8")) as CarryPlan)
    : undefined;
  if (plan?.done || !existsSync(hubFile) || !existsSync(storageFile)) return undefined;

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const copyDir = join(dir, "storage");
  const discard = () => rmSync(copyDir, { recursive: true, force: true });
  discard();
  // Taken before the Hub's own code opens it, and kept only once this process holds the home.
  const asideDone = existsSync(`${hubFile}${ASIDE}`);
  const taken: [string, string][] = [];
  if (!asideDone)
    for (const suffix of SUFFIXES)
      if (existsSync(hubFile + suffix)) {
        const temporary = `${hubFile}${ASIDE}.tmp${suffix}`;
        copyFileSync(hubFile + suffix, temporary);
        chmodSync(temporary, 0o600);
        taken.push([temporary, `${hubFile}${ASIDE}${suffix}`]);
      }
  let state: HubState;
  try {
    state = HubState.open(home);
  } catch (error) {
    for (const [temporary] of taken) rmSync(temporary, { force: true });
    throw error;
  }
  try {
    // The main file last: it is what says the copy is whole.
    for (const [temporary, final] of taken.reverse()) renameSync(temporary, final);
    mkdirSync(copyDir, { mode: 0o700 });
    chmodSync(copyDir, 0o700);
    for (const suffix of ["", "-wal"])
      if (existsSync(storageFile + suffix)) {
        const copied = join(copyDir, `storage.db${suffix}`);
        copyFileSync(storageFile + suffix, copied);
        chmodSync(copied, 0o600);
      }
    if (!plan) {
      const db = new DatabaseSync(join(copyDir, "storage.db"));
      let record: { assistant?: unknown; assistants?: unknown } | undefined;
      try {
        const row = db
          .prepare("SELECT value FROM store WHERE consumer = ? AND slot = ? AND key = ?")
          .get(FIRST_RUN.consumer, FIRST_RUN.slot, FIRST_RUN.key) as { value: string } | undefined;
        record = row && JSON.parse(row.value);
      } finally {
        db.close();
      }
      if (!record) {
        // Not a home an earlier release's first run set up: there is nothing to carry.
        discard();
        savePlan(planFile, { agents: [], done: true });
        return undefined;
      }
      const builds = new Set(
        [record.assistant, ...(Array.isArray(record.assistants) ? record.assistants : [])].filter(
          (hash): hash is string => typeof hash === "string",
        ),
      );
      plan = {
        agents: state
          .actors()
          .filter((actor) => actor.state !== "closed" && builds.has(actor.package))
          .map((actor) => ({ old: actor.actorId, name: actor.name })),
      };
      savePlan(planFile, plan);
    }
    // The file holds the plan before anything is closed. Closed here, with no Hub to tell, so
    // nothing runs them and no store goes with them.
    for (const actor of state.actors())
      if (actor.state !== "closed" && actor.package !== "external" && actor.package !== "builtin")
        state.closeActor(PERSON, actor.actorId);
  } catch (error) {
    discard();
    throw error;
  } finally {
    state.close();
  }

  const carried = plan;
  return {
    plan: carried,
    discard,
    async finish(person, log) {
      const call = <T>(slot: string, method: string, input: unknown = {}) =>
        person.call(slot, method, input) as Promise<T>;
      const db = new DatabaseSync(join(copyDir, "storage.db"));
      try {
        const left = carried.agents.filter((entry) => !entry.done);
        const provider = left.length ? await assistantProvider(call) : "";
        for (const entry of left) {
          const agent = entry.agent ?? (await made(call, entry, carried, provider));
          entry.agent = agent;
          savePlan(planFile, carried);
          // Stopped while its record is written, so its engine reads the whole of it.
          await call("agents", "stop", { agent });
          const store = agentRecord(programDir(home, "agents"), agent);
          const rows = db
            .prepare(
              `SELECT key, value FROM store WHERE consumer = ? AND slot = ? AND ${RECORD_WHERE}`,
            )
            .all(entry.old, AGENT_SLOT) as { key: string; value: string }[];
          for (const { key, value } of rows) await store.set({ key, value: JSON.parse(value) });
          await call("agents", "start", { agent });
          entry.done = true;
          savePlan(planFile, carried);
        }
        carried.done = true;
        savePlan(planFile, carried);
        if (left.length)
          log(`First run: carried ${left.length} agent(s) from the earlier release.`);
      } finally {
        db.close();
      }
    },
  };
}

type Call = <T>(slot: string, method: string, input?: unknown) => Promise<T>;

/** The provider offering Assistant, once management can see it. */
async function assistantProvider(call: Call): Promise<string> {
  const until = Date.now() + PROVIDER_MS;
  for (;;) {
    const { creatables } = await call<{ creatables: { provider: string; id: string }[] }>(
      "agents",
      "creatable",
    );
    const found = creatables.find((one) => one.id === "assistant");
    if (found) return found.provider;
    if (Date.now() > until) throw new Error("The agent provider didn't reach management in time.");
    await new Promise((done) => setTimeout(done, PROVIDER_EVERY_MS));
  }
}

/**
 * The entry's new agent: one of that name no other entry holds, made by a run that stopped before
 * it could write the plan, or a new one.
 */
async function made(call: Call, entry: CarryEntry, plan: CarryPlan, provider: string) {
  const used = new Set(plan.agents.map((one) => one.agent));
  const { agents } = await call<{ agents: { agent: string; name: string }[] }>("agents", "list");
  const earlier = agents.find((one) => one.name === entry.name && !used.has(one.agent));
  if (earlier) return earlier.agent;
  const { agent } = await call<{ agent: string }>("agents", "create", {
    provider,
    creatable: "assistant",
    name: entry.name,
    answers: {},
  });
  return agent;
}
