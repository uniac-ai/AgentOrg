// happy-dom's browser globals, before anything else loads: react-dom decides at import whether it
// runs in a browser, so this module comes first in dom.ts's imports.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
