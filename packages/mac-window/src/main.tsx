import { createRoot } from "react-dom/client";
import type { Mac } from "./mac.ts";
import { standIn } from "./stand-in.ts";
import { inTauri, tauriMac } from "./tauri.ts";
import { forgetGrants, Window } from "./window.tsx";

/** In a browser, the stand-in, a fresh Mac each time it opens, in the state `?state=` names. */
const inBrowser = (): Mac => {
  forgetGrants();
  return standIn(new URLSearchParams(location.search).get("state") ?? "first-open");
};
// Inside the app, its own implementation of the seam, Tauri commands, takes the stand-in's place.
const mac: Mac = inTauri() ? tauriMac() : inBrowser();

createRoot(document.getElementById("root") as HTMLElement).render(<Window mac={mac} />);
