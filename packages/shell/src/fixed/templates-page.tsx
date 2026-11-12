// Saved stacks: use one, or start a new one from it.
import { CopyPlusIcon } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { useBuilding } from "./building.tsx";
import { DeleteButton } from "./delete-dialog.tsx";
import { rowClass, Scroll } from "./parts.tsx";
import { useOffer } from "./settings-page.tsx";

export function TemplatesPage() {
  const { catalog, removeTemplate, start } = useBuilding();
  const titleOf = (id: string) => catalog.units.find((u) => u.id === id)?.title ?? id;
  useOffer("New template", () => start(undefined, "template"));
  return (
    <Scroll>
      <ul aria-label="Templates" className="mx-auto max-w-5xl">
        {catalog.templates.map((t) => (
          <li
            key={t.id}
            className={`${rowClass(false)} grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_24px] tight:grid-cols-[minmax(0,1fr)_auto_24px]`}
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{t.title}</div>
              <div className="truncate text-[13px] text-muted-foreground">{t.description}</div>
            </div>
            <span className="truncate text-[13px] text-muted-foreground tight:col-span-3 tight:row-start-2">
              {t.units.map((u) => titleOf(u.unit)).join(", ")}
            </span>
            <span className="flex items-center gap-1 tight:row-start-1">
              <Button variant="ghost" size="sm" onClick={() => start(t)}>
                Use
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`New template from ${t.title}`}
                onClick={() => start(t, "template")}
              >
                <CopyPlusIcon />
              </Button>
            </span>
            <span className="tight:row-start-1">
              {/* One that came with the app can't be removed. */}
              {!t.shipped && (
                <DeleteButton
                  name={t.title}
                  agents={[]}
                  onDelete={() => removeTemplate(t.id)}
                  onDeleted={() => {}}
                />
              )}
            </span>
          </li>
        ))}
      </ul>
    </Scroll>
  );
}
