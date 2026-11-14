// The stack being built in the Create window. It lasts as long as the window is open.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, useLoad } from "../data.ts";
import {
  type Catalog,
  type CatalogBase,
  type CatalogUnit,
  type Draft,
  type DraftUnit,
  draftFrom,
  type StackProblem,
  type Template,
  toTemplate,
} from "./stack.ts";

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
  const read = useLoad(readCatalog, ["actors"], [version]);
  const catalog = read.value ?? EMPTY;
  const reread = () => setVersion((was) => was + 1);
  const [held, setDraft] = useState<Draft>();
  const [open, setOpen] = useState(false);
  // An empty stack started before the bases were read stands on the first of them once they are.
  const first = catalog.bases[0];
  const draft = held && !held.base && !held.from && first ? { ...held, base: first } : held;
  const keys = useRef(0);
  const nextKey = () => ++keys.current;
  /**
   * Opened, the window reads its units again, since what this machine can give changes with it (a
   * part switched off, a browser set up), and draws the stack once they are read: so no answer is
   * drawn as it was and then changed. Until then it has its templates, and no stack.
   */
  const [opening, setOpening] = useState<{
    template?: Template | undefined;
    mode: Draft["mode"];
    was: Catalog | undefined;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new read, or none to be had, is the sign.
  useEffect(() => {
    if (!opening || (read.value === opening.was && !read.error)) return;
    setDraft(draftFrom(opening.template, catalog, opening.mode, nextKey));
    setOpening(undefined);
  }, [opening, read.value, read.error]);

  /** Any change makes what was found wrong with the stack out of date. */
  const change = (next: (was: Draft) => Partial<Draft>) =>
    setDraft((was) => (was ? { ...was, ...next(was), problems: [] } : was));
  const changeUnit = (key: number, next: (was: DraftUnit) => Partial<DraftUnit>) =>
    change((was) => ({ units: was.units.map((u) => (u.key === key ? { ...u, ...next(u) } : u)) }));

  /**
   * A template, or nothing, fills the window. Chosen in the open window, it keeps what was typed
   * for an agent; opening the window starts clean, whatever a closed one was left holding.
   */
  const start = (template?: Template, mode: Draft["mode"] = "agent") => {
    if (!open) {
      setDraft(undefined);
      setOpening({ template, mode, was: read.value });
      reread();
      setOpen(true);
      return;
    }
    const next = draftFrom(template, catalog, mode, nextKey);
    setDraft((was) => ({
      ...next,
      ...(mode === "agent" && open && was ? { name: was.name, purpose: was.purpose } : {}),
    }));
    setOpen(true);
  };

  return {
    catalog,
    /** Whether the catalog has been read, or couldn't be. */
    catalogRead: { loaded: read.loaded, ...(read.error ? { error: read.error } : {}) },
    draft,
    open,
    /** The window opens on an empty stack. */
    show: () => start(),
    hide: () => setOpen(false),
    start,
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
