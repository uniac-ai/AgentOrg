// The shell's own components: Radix primitives for what has behavior (dialogs, menus, switches,
// tabs), plain elements for the rest, all drawn by the kit's classes.
import {
  DropdownMenu,
  Dialog as RadixDialog,
  Switch as RadixSwitch,
  Tabs as RadixTabs,
} from "radix-ui";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `primary` is the accent; `quiet` reads as a link. */
  variant?: "primary" | "quiet";
};
export function Button({ variant, className, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("kit-button", variant && `kit-${variant}`, className)}
      {...props}
    />
  );
}

/** A button with only an icon: its `label` is its accessible name, and its tooltip. */
export function IconButton({
  label,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx("kit-icon-button", className)}
      {...props}
    />
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <RadixSwitch.Root
      className="kit-switch"
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
    >
      <RadixSwitch.Thumb className="kit-switch-thumb" />
    </RadixSwitch.Root>
  );
}

export function Field({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("kit-field", className)} {...props} />;
}

/** The browser's own select, drawn in the kit's look: accessible and native on every device. */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("kit-select", className)} {...props} />;
}

/**
 * A modal dialog: focus held inside, Escape and a click outside close it, and focus goes back to
 * what opened it. `title` names it.
 */
export function Dialog({
  open = true,
  onClose,
  title,
  children,
}: {
  open?: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="kit-scrim" />
        <RadixDialog.Content className="kit-dialog" aria-describedby={undefined}>
          <RadixDialog.Title className="kit-dialog-title">{title}</RadixDialog.Title>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A row of buttons at the end of a dialog or a form. */
export const Actions = ({ children }: { children: ReactNode }) => (
  <div className="kit-actions">{children}</div>
);

/**
 * A menu opened from `trigger` (a button: an `IconButton`, usually): arrow keys move through its
 * items, Escape and a click outside close it.
 */
export function Menu({
  trigger,
  children,
  open,
  onOpenChange,
  align = "end",
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  align?: "start" | "end";
}) {
  return (
    <DropdownMenu.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
      modal={false}
    >
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="kit-menu" align={align} sideOffset={4}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  onSelect,
  disabled,
  children,
}: {
  onSelect(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item className="kit-menu-item" onSelect={onSelect} disabled={disabled}>
      {children}
    </DropdownMenu.Item>
  );
}

/** Tabs, each a `[value, label]`; `children` is the selected one's panel. */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string;
  tabs: readonly (readonly [NoInfer<T>, ReactNode])[];
  value: T;
  onChange(value: T): void;
  children: ReactNode;
}) {
  return (
    <RadixTabs.Root
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className="kit-stack"
    >
      <RadixTabs.List className="kit-tabs-list" aria-label={label}>
        {tabs.map(([key, name]) => (
          <RadixTabs.Trigger key={key} value={key} className="kit-tab">
            {name}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      <RadixTabs.Content value={value} className="kit-fill kit-scroll">
        {children}
      </RadixTabs.Content>
    </RadixTabs.Root>
  );
}

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx("kit-card", className)}>{children}</div>
);

/** Rows divided by lines: each child is an `<li>`. */
export const List = ({ children, label }: { children: ReactNode; label?: string }) => (
  <ul className="kit-list" aria-label={label}>
    {children}
  </ul>
);

export function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <table className="kit-table">
      <thead>
        <tr>
          {head.map((cell, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a header is a fixed list of columns.
            <th key={i}>{cell}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are given in order, without ids.
          <tr key={r}>
            {row.map((cell, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional.
              <td key={c}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `value` of `max` as segments, one per unit: a board's done cards, say. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div className="kit-meter" role="img" aria-label={label}>
      {Array.from({ length: max }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional.
        <i key={i} className={i < value ? "kit-on" : undefined} />
      ))}
    </div>
  );
}

type Layout = { children: ReactNode; gap?: number; className?: string; style?: CSSProperties };
const gapped = (gap: number | undefined, style?: CSSProperties) =>
  gap === undefined ? style : ({ ...style, "--kit-gap": `${gap}px` } as CSSProperties);

/** Children in a column. */
export const Stack = ({ children, gap, className, style }: Layout) => (
  <div className={cx("kit-stack", className)} style={gapped(gap, style)}>
    {children}
  </div>
);
/** Children in a row, centered on the cross axis. */
export const Row = ({ children, gap, className, style }: Layout) => (
  <div className={cx("kit-row", className)} style={gapped(gap, style)}>
    {children}
  </div>
);
/** Takes the room its parent (a `Stack` or `Row`) has left. */
export const Fill = ({ children, className, style }: Layout) => (
  <div className={cx("kit-fill", className)} style={style}>
    {children}
  </div>
);
/** Scrolls what doesn't fit, with no visible scrollbar. */
export const Scroll = ({ children, className, style }: Layout) => (
  <div className={cx("kit-scroll", className)} style={style}>
    {children}
  </div>
);
