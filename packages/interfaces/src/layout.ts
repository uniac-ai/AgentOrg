import { defineInterface, event, method } from "@agentorg/sdk";
import { z } from "zod";

const Id = z.string().min(1).max(128);
/** A module of a package, by its name in the manifest. */
const ModuleName = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*$/)
  .max(64);

/** One view on the dashboard: a `view` module of a running package Actor. */
export const Placement = z.object({
  id: Id,
  actor: Id,
  module: ModuleName,
  title: z.string().max(200).optional(),
});

/**
 * `layout@1`: the person's dashboard, the views placed on it and their order. The person's Actor
 * exports it, so a program bound to it places a widget as the person does.
 */
export const layout = defineInterface({
  name: "layout",
  major: 1,
  kind: "rpc",
  methods: {
    get: method({ input: z.object({}), output: z.object({ home: z.array(Placement) }) }),
    /**
     * Place a view, after the placement `after`, or last. Refused unless `module` is a `view`
     * module of that Actor's package.
     */
    place: method({
      input: z.object({
        actor: Id,
        module: ModuleName,
        title: z.string().max(200).optional(),
        after: Id.optional(),
      }),
      output: z.object({ id: Id }),
    }),
    remove: method({ input: z.object({ id: Id }), output: z.object({}) }),
    /** Move a placement after `after`, or first. */
    move: method({ input: z.object({ id: Id, after: Id.optional() }), output: z.object({}) }),
  },
  events: {
    /** The layout changed; read it again with `get`. */
    changed: event(z.object({})),
  },
});
