// Settings: a window over the place being looked at, which stays behind it. Its sections are rows
// down the left, and the chosen one's contents are at the right, with the section's own action on
// the top line beside the close. It opens on the section last looked at. On a phone it takes the
// screen: the sections first, then a section with a way back.
import { ChevronLeftIcon, PlusIcon, XIcon } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import {
  backToSections,
  closeSettings,
  pickSection,
  type SettingsSection,
  useSettings,
} from "../data.ts";
import { Button } from "../ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog.tsx";
import { McpsPage } from "./mcps-page.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { SkillsPage } from "./skills-page.tsx";
import { TemplatesPage } from "./templates-page.tsx";

const SECTIONS: { id: SettingsSection; title: string }[] = [
  { id: "templates", title: "Templates" },
  { id: "skills", title: "Skills" },
  { id: "mcps", title: "MCP connections" },
  { id: "providers", title: "Providers" },
  { id: "account", title: "Account" },
];

/** What a section offers, by its name. */
interface Offer {
  label: string;
  run(): void;
}
const Offered = createContext<(offer?: Offer) => void>(() => {});
/** The section drawn in the window offers this on the window's top line. */
export function useOffer(label: string, run: () => void) {
  const offer = useContext(Offered);
  const latest = useRef(run);
  latest.current = run;
  // Before anything is painted, so a section and what it offers change as one.
  useLayoutEffect(() => {
    offer({ label, run: () => latest.current() });
    return () => offer(undefined);
  }, [offer, label]);
}

export function SettingsWindow() {
  const { open, section, focus, adding, listing } = useSettings();
  const [action, setAction] = useState<Offer>();
  /** What had the keyboard when it opened, which has it again when it closes. */
  const opener = useRef<HTMLElement | null>(null);
  const row = (on: boolean) =>
    `flex h-9 w-full shrink-0 items-center rounded-lg px-3 text-left text-[15px] ${on ? "bg-[var(--selected)] font-medium" : "hover:bg-[var(--hover)]"}`;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeSettings()}>
      <DialogContent
        asWindow
        showCloseButton={false}
        onOpenAutoFocus={() => {
          opener.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
        className="window flex h-[min(600px,calc(100%-2rem))] gap-0 overflow-hidden rounded-3xl bg-background p-0 ring-0 sm:max-w-[860px] max-sm:top-0 max-sm:left-0 max-sm:h-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
      >
        <DialogDescription className="sr-only">AgentOrg's settings, by section</DialogDescription>
        <nav
          aria-label="Settings"
          className={`flex w-[220px] shrink-0 flex-col gap-0.5 border-r bg-[var(--ground)] p-2 max-sm:w-full max-sm:border-r-0 ${listing ? "" : "max-sm:hidden"}`}
        >
          <div className="flex h-12 shrink-0 items-center">
            <DialogTitle className="min-w-0 flex-1 px-3 text-[17px] font-semibold">
              Settings
            </DialogTitle>
            {/* On a phone the sections stand alone, so their close is here. */}
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                className="hidden max-sm:inline-flex"
              >
                <XIcon />
              </Button>
            </DialogClose>
          </div>
          {SECTIONS.map((one) => (
            <button
              key={one.id}
              type="button"
              aria-current={one.id === section ? "true" : undefined}
              onClick={() => pickSection(one.id)}
              className={`${row(one.id === section)} ${listing ? "max-sm:bg-transparent max-sm:font-normal" : ""}`}
            >
              {one.title}
            </button>
          ))}
        </nav>
        <section
          aria-label={SECTIONS.find((one) => one.id === section)?.title}
          className={`@container/main flex min-w-0 flex-1 flex-col ${listing ? "max-sm:hidden" : ""}`}
        >
          {/* The section's action and the close in one line, centred on it. */}
          <header className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-5 max-sm:pl-1.5">
            <Button
              variant="ghost"
              className="hidden h-9 gap-0.5 rounded-full pr-3 pl-1.5 text-[15px] max-sm:inline-flex"
              onClick={backToSections}
            >
              <ChevronLeftIcon className="size-5" />
              Settings
            </Button>
            <span className="min-w-0 flex-1" />
            {action && (
              <Button size="sm" aria-label={action.label} onClick={action.run}>
                <PlusIcon />
                {action.label}
              </Button>
            )}
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <XIcon />
              </Button>
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1">
            <Offered.Provider value={setAction}>
              {section === "templates" && <TemplatesPage />}
              {section === "skills" && <SkillsPage focus={focus} adding={adding} />}
              {section === "mcps" && <McpsPage focus={focus} adding={adding} />}
              {(section === "providers" || section === "account") && <SettingsPage tab={section} />}
            </Offered.Provider>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
