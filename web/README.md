# Web client

The browser calls the web actor's `/api` with its signed-in session and CSRF token. The web
actor calls the core through the actor library. Views preserve those operations and authority,
including the explicit Send action for approvals.

`src/control/` owns data, domain state and interaction semantics. `src/views/` owns layout and
formatting, using the shadcn parts in `src/components/ui/`. Question metadata, progress rollups
and organization rows are domain compositions; cards, buttons, badges, disclosures and the
composer use the existing component library. The Base UI toast keeps the page's strict CSP.
The shell control supplies the selected actor's name for the view's route context.

Browser tests live in `e2e/`. They build the package, run isolated core and web servers on free
ports, seed organizations through the public actor API and assert browser writes by reading
them back through that API. Each fixture closes its own connections and processes and removes
its temporary organization. The runner uses no installed services or personal configuration.

With Node 22.13+ and dependencies installed using `npm ci`, install Chromium with
`npx playwright install chromium` (`--with-deps` on Linux), then run `npm run test:e2e`.
Both desktop (1280×720) and mobile (390×844) run against the packaged browser assets.
Set `AGENTORG_SCREENSHOTS=/absolute/output/directory` to retain review screenshots. Resource
IDs and owned PIDs/ports appear in each test's `owned-resources` attachment under `test-results`.
