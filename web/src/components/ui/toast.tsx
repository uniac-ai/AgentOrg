// Toasts on Base UI's primitive, styled here: it adds no style elements of its own, so the page's
// Content-Security-Policy can stay at `style-src 'self'`.

import { Toast } from "@base-ui/react/toast";
import { CircleAlertIcon, CircleCheckIcon, XIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** The app's one toast manager; anything may add to it, inside React or not. */
export const toasts = Toast.createToastManager();

function ToastList() {
  const { toasts: list } = Toast.useToastManager();
  return list.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg",
        "transition-all duration-200 data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0",
      )}
    >
      {toast.type === "error" ? (
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-state-closed" />
      )}
      <div className="min-w-0 flex-1">
        <Toast.Title className="font-medium" />
        <Toast.Description className="text-muted-foreground" />
      </div>
      <Toast.Close
        aria-label="Dismiss"
        className="rounded-sm text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-4" />
      </Toast.Close>
    </Toast.Root>
  ));
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider toastManager={toasts} timeout={4000}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
