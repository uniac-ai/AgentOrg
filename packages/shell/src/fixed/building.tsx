// The stack being built in the Create window. It lasts as long as the window is open.
import { createContext, useContext, useRef, useState } from "react";
import { api, useLoad } from "../data.ts";
import {
  type Catalog,
  type CatalogBase,
  type CatalogUnit,
  type Draft,
  type DraftUnit,
  draftFrom,
  pickName,
  type StackProblem,
  type Template,
  toTemplate,
} from "./stack.ts";
import { useAgents } from "./watch.tsx";

/** How long the Create window takes to change size: its `duration-300`. */
const WINDOW_MS = 300;
const EMPTY: Catalog = { bases: [], units: [], templates: [] };

function readCatalog(): Promise<Catalog> {
  return Promise.all([
    api.call<Pick<Catalog, "bases" | "units">>("agents", "units"),
    api.call<Pick<Catalog, "templates">>("agents", "templates"),
  ]).then(([units, templates]) => ({ ...units, ...templates }));
}

function useBuildingState() {
  // Saving a template raises no event: `version` reads them again.
  const [version, setVersion] = useState(0);
  const catalog = useLoad(readCatalog, ["actors"], [version]).value ?? EMPTY;
  const reread = () => setVersion((was) => was + 1);
  const { list } = useAgents();
  const [draft, setDraft] = useState<Draft>();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Draft["mode"]>("agent");
  /** The panel is closing: the stack stays drawn until the window has shrunk around it. */
  const [collapsing, setCollapsing] = useState(false);
  const collapse = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = () => {
    clearTimeout(collapse.current);
    setCollapsing(false);
  };
  const keys = useRef(0);
  const nextKey = () => ++keys.current;

  /** Any change makes what was found wrong with the stack out of date. */
  const change = (next: (was: Draft) => Partial<Draft>) =>
    setDraft((was) => (was ? { ...was, ...next(was), problems: [] } : was));
  const changeUnit = (key: number, next: (was: DraftUnit) => Partial<DraftUnit>) =>
    change((was) => ({ units: was.units.map((u) => (u.key === key ? { ...u, ...next(u) } : u)) }));

  return {
    catalog,
    draft,
    open,
    mode,
    /** A stack is showing, and staying. */
    expanded: !!draft && !collapsing,
    show() {
      settle();
      setDraft(undefined);
      setMode("agent");
      setOpen(true);
    },
    hide: () => setOpen(false),
    /** Once the window has gone: whatever was in it goes too. */
    clear() {
      settle();
      setDraft(undefined);
      setMode("agent");
    },
    /** The chosen row, chosen again: the panel closes, at the pace the window moves. */
    unselect() {
      setCollapsing(true);
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      collapse.current = setTimeout(
        () => {
          setDraft(undefined);
          setCollapsing(false);
        },
        still ? 0 : WINDOW_MS,
      );
    },
    /** A template, or nothing, fills the panel. Choosing again keeps what was typed for an agent. */
    start(template?: Template, mode: Draft["mode"] = "agent") {
      settle();
      setMode(mode);
      const next = draftFrom(template, catalog, mode, nextKey);
      const offered = pickName(list.map((agent) => agent.name));
      setDraft((was) => ({
        ...next,
        ...(mode === "agent" ? { suggested: was?.suggested || offered } : {}),
        ...(mode === "agent" && was ? { name: was.name, purpose: was.purpose } : {}),
      }));
      setOpen(true);
    },
    setText: (text: Partial<Pick<Draft, "name" | "purpose">>) => change(() => text),
    setBase: (base: CatalogBase) => change(() => ({ base, answers: {} })),
    setAnswer: (id: string, value: string) =>
      change((was) => ({ answers: { ...was.answers, [id]: value } })),
    /** On the end of the stack, or just above the unit that needs it. */
    addUnit(unit: CatalogUnit, before?: number) {
      const entry = {
        key: nextKey(),
        unit,
        id: unit.id,
        values: {},
        secrets: {},
        added: true as const,
      };
      change((was) => {
        const at = before === undefined ? -1 : was.units.findIndex((u) => u.key === before);
        if (at === -1) return { units: [...was.units, entry] };
        return { units: [...was.units.slice(0, at), entry, ...was.units.slice(at)] };
      });
    },
    removeUnit: (key: number) =>
      change((was) => ({ units: was.units.filter((u) => u.key !== key) })),
    setValue: (key: number, id: string, value: DraftUnit["values"][string]) =>
      changeUnit(key, (u) => ({ values: { ...u.values, [id]: value } })),
    setSecret: (key: number, id: string, value: string) =>
      changeUnit(key, (u) => ({ secrets: { ...u.secrets, [id]: value } })),
    saveTemplate: (title: string, description: string) =>
      api
        .call(
          "agents",
          "saveTemplate",
          toTemplate(
            draft as Draft,
            title,
            description,
            catalog.templates.map((t) => t.id),
          ),
        )
        .then(reread),
    removeTemplate: (id: string) => api.call("agents", "removeTemplate", { id }).then(reread),
    /** Reads the units again. True if a unit in the stack changed: it's then drawn as it now is. */
    async refreshUnits() {
      const { units } = await api.call<Pick<Catalog, "units">>("agents", "units");
      const freshOf = (u: DraftUnit) =>
        units.find((c) => c.provider === u.unit?.provider && c.id === u.id);
      const stale = draft?.units.some((u) => {
        const fresh = freshOf(u);
        return fresh && JSON.stringify(fresh) !== JSON.stringify(u.unit);
      });
      if (!stale) return false;
      reread();
      change((was) => ({ units: was.units.map((u) => ({ ...u, unit: freshOf(u) ?? u.unit })) }));
      return true;
    },
    setProblems: (problems: StackProblem[]) =>
      setDraft((was) => (was ? { ...was, problems } : was)),
  };
}

type Building = ReturnType<typeof useBuildingState>;
const Context = createContext<Building | null>(null);

export function BuildingProvider({ children }: { children: React.ReactNode }) {
  const state = useBuildingState();
  return <Context.Provider value={state}>{children}</Context.Provider>;
}

export const useBuilding = () => useContext(Context) as Building;
