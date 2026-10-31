/** Read-only history of former Actor calls, authorized to their original caller. */

import { Forbidden, NotFound } from "./errors.ts";
import { CALLS } from "./model/index.ts";
import type { Store } from "./ports.ts";
import { bindTool } from "./tools.ts";

export { CALLS as definition } from "./model/index.ts";

export function calls(store: Store["calls"]) {
  const found = (id: string) => {
    const call = store.get(id);
    if (!call) throw new NotFound(`there is no call ${id}`);
    return call;
  };
  return {
    found,
    tool: bindTool(CALLS, {
      call_result: (actor, request) => {
        const call = found(request.call);
        if (call.from !== actor.id) throw new Forbidden(`only its caller reads call ${call.id}`);
        return call;
      },
    }),
  };
}
