/** Live links and the last advertised interfaces. Online state exists only while a link does. */

import { INTERFACE_NAME, type InterfaceDescriptor } from "./model/index.ts";
import type { ActorLink, Store } from "./ports.ts";

/** Valid local names, once each; the first descriptor owns its contract. */
function validInterfaces(interfaces: InterfaceDescriptor[]): InterfaceDescriptor[] {
  const names = new Set<string>();
  return interfaces.filter((each) => {
    if (!INTERFACE_NAME.test(each.name) || names.has(each.name)) return false;
    names.add(each.name);
    return true;
  });
}

export function connections(
  exposures: Store["exposures"],
  onOnline: (actor: string) => void,
  onClosed: (actor: string) => void,
) {
  const links = new Map<string, ActorLink>();
  const candidates = new WeakMap<ActorLink, number>();
  const owners = new Map<string, number>();
  const ended = new WeakSet<ActorLink>();
  let order = 0;
  const changed = (actor: string, link: ActorLink, interfaces: InterfaceDescriptor[]) => {
    if (links.get(actor) === link) {
      exposures.put(actor, validInterfaces(interfaces));
    }
  };
  return {
    begin(_actor: string, link: ActorLink): void {
      candidates.set(link, ++order);
    },
    link: (actor: string) => links.get(actor),
    interfaces: (actor: string) => validInterfaces(exposures.get(actor)),
    online(actor: string, link: ActorLink, interfaces: InterfaceDescriptor[]): void {
      const candidate = candidates.get(link);
      if (ended.has(link) || candidate === undefined || candidate < (owners.get(actor) ?? 0))
        return;
      const previous = links.get(actor);
      owners.set(actor, candidate);
      links.set(actor, link);
      if (previous && previous !== link) void previous.close();
      changed(actor, link, interfaces);
      onOnline(actor);
    },
    changed,
    offline(actor: string, link: ActorLink): void {
      ended.add(link);
      if (links.get(actor) === link) links.delete(actor);
    },
    async disconnect(actor: string): Promise<void> {
      const link = links.get(actor);
      links.delete(actor);
      onClosed(actor);
      await link?.close();
    },
  };
}

export type Connections = ReturnType<typeof connections>;
