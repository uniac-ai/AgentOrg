// The stack being built, kept here so that leaving the panel loses nothing. The right side holds
// one panel at a time: the chats, or this.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, useLoad } from "../data.ts";
import { useChats } from "./chats.tsx";
import {
  type Catalog,
  type CatalogBase,
  type CatalogUnit,
  type Draft,
  type DraftUnit,
  draftFrom,
  type StackProblem,
  type Template,
} from "./stack.ts";

const EMPTY: Catalog = { bases: [], units: [], templates: [] };

function readCatalog(): Promise<Catalog> {
  return Promise.all([
    api.call<Pick<Catalog, "bases" | "units">>("agents", "units"),
    api.call<Pick<Catalog, "templates">>("agents", "templates"),
  ]).then(([units, templates]) => ({ ...units, ...templates }));
}

function useBuildingState() {
  const chats = useChats();
  const catalog = useLoad(readCatalog, ["actors"]).value ?? EMPTY;
  const [draft, setDraft] = useState<Draft>();
  const [open, setOpen] = useState(false);
  const keys = useRef(0);
  const nextKey = () => ++keys.current;

  // The chats opening puts this away; the stack stays.
  useEffect(() => {
    if (chats.open) setOpen(false);
  }, [chats.open]);

  const show = () => {
    chats.close();
    setOpen(true);
  };
  /** Any change makes what was found wrong with the stack out of date. */
  const change = (next: (was: Draft) => Partial<Draft>) =>
    setDraft((was) => (was ? { ...was, ...next(was), problems: [] } : was));
  const changeUnit = (key: number, next: (was: DraftUnit) => Partial<DraftUnit>) =>
    change((was) => ({ units: was.units.map((u) => (u.key === key ? { ...u, ...next(u) } : u)) }));

  return {
    catalog,
    draft,
    open: open && !chats.open,
    show,
    hide: () => setOpen(false),
    /** A template, or nothing, opens the stack in the chats' place. */
    start(template?: Template, mode: Draft["mode"] = "agent") {
      setDraft(draftFrom(template, catalog, mode, nextKey));
      show();
    },
    discard() {
      setDraft(undefined);
      setOpen(false);
    },
    setText: (text: Partial<Pick<Draft, "name" | "purpose">>) => change(() => text),
    setBase: (base: CatalogBase) => change(() => ({ base, answers: {} })),
    setAnswer: (id: string, value: string) =>
      change((was) => ({ answers: { ...was.answers, [id]: value } })),
    /** On the end of the stack, or just above the unit that needs it. */
    addUnit(unit: CatalogUnit, before?: number) {
      const entry = { key: nextKey(), unit, id: unit.id, values: {}, secrets: {} };
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
