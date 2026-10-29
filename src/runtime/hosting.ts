/** Commands for one application's user-service lifecycle. */

import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { launcherPath } from "./launcher.ts";
import { installService, manager, type Service, uninstallService } from "./services.ts";
import { answers } from "./status.ts";

export const serviceHelp = (program: string) => `usage: ${program} service install|uninstall

install pins this executable and Node in <home>/bin/${program}, and keeps it running as a launchd user agent on macOS or a systemd user unit on Linux. It waits until the service answers. Run it again after upgrading the package or Node.

uninstall stops and removes only this executable's service. The home and its records stay.`;

export async function serviceCommand(
  service: Service,
  url: string,
  args: string[],
): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const [action, ...rest] = positionals;
  if (rest.length || (action !== "install" && action !== "uninstall")) {
    throw new Error(serviceHelp(service.program));
  }
  const managing = manager();
  if (action === "uninstall") {
    const removed = uninstallService(service, managing);
    process.stdout.write(
      removed
        ? `removed service ${service.name}, ${service.title}\n`
        : `no ${service.title} service to remove\n`,
    );
    return 0;
  }
  await installService(service, managing, async () => {
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(250)) {
      if (await answers(url)) return;
    }
    throw new Error(
      `${service.title} did not answer at ${url} within 30 seconds; see ${managing.logs(service)}`,
    );
  });
  process.stdout.write(
    `${service.title}: answering at ${url}, as service ${service.name}\nlauncher: ${launcherPath(service.program)}\n`,
  );
  return 0;
}
