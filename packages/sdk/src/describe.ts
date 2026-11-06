import { type DescribedInterface, describeInterface } from "./interface.js";
import { isModuleDefinition, type Placement } from "./module.js";

/** A module as the build reads it from its code. */
export interface ModuleDescription {
  placement: Placement;
  slots: Record<string, DescribedInterface>;
  exports: Record<string, DescribedInterface>;
}

/**
 * Describe a module's default export. The build bundles this with the author's own module, so it
 * uses the same SDK and zod copies as the module, and runs it in a permission-limited process.
 */
export function describeModule(definition: unknown): ModuleDescription {
  if (!isModuleDefinition(definition))
    throw new TypeError(
      "The default export isn't a module: define it with defineActor or defineWidget.",
    );
  const describe = (interfaces: Record<string, Parameters<typeof describeInterface>[0]>) =>
    Object.fromEntries(
      Object.entries(interfaces).map(([name, iface]) => [name, describeInterface(iface)]),
    );
  return {
    placement: definition.placement,
    slots: describe(definition.slots),
    exports: describe(definition.exports),
  };
}
