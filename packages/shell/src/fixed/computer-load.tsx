// How loaded an agent's computer is, while it says: the column beside it on its agent's page.
import { useEffect, useState } from "react";
import { REFRESH_MS } from "./data.ts";
import { type LiveTarget, useLive } from "./live-socket.ts";

/** The protocol a computer says how busy it is in: a reading every few seconds, sizes in bytes. */
export const LOAD = "metrics@1";
interface Reading {
  cpuUsedPct: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
}
const NUMBERS = ["cpuUsedPct", "memUsed", "memTotal", "diskUsed", "diskTotal"] as const;

/** The latest reading of a surface while its socket is open: none before its first. */
function useReading(target: LiveTarget): Reading | undefined {
  const [reading, setReading] = useState<Reading>();
  const live = useLive(
    target,
    (data) => {
      if (typeof data !== "string") return;
      const frame = JSON.parse(data) as { type?: string } & Partial<Reading>;
      if (frame.type === "reading" && NUMBERS.every((one) => Number.isFinite(frame[one])))
        setReading(frame as Reading);
    },
    () => setReading(undefined),
  );
  // A socket that closed is opened again, as often as what has no event is read again.
  const closed = live.state.phase === "closed";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is this socket's own.
  useEffect(() => {
    if (!closed) return;
    const timer = setTimeout(live.again, REFRESH_MS);
    return () => clearTimeout(timer);
  }, [closed]);
  return live.state.phase === "open" ? reading : undefined;
}

/** Memory is counted in 1024s, as a machine's own is said; a disk in 1000s, as disks are sold. */
const MEMORY = 2 ** 30;
const DISK = 1e9;
/** A size in GB: a decimal under ten, whole from there. */
const amount = (bytes: number, gb: number) => {
  const n = bytes / gb;
  return String(n < 10 ? Math.round(n * 10) / 10 : Math.round(n));
};

function Meter({ label, value, text }: { label: string; value: number; text: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{text}</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a <meter> can't be drawn as this bar is. */}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--raised)]"
      >
        <div
          className="h-full rounded-full bg-[var(--fg)]/60 transition-[width] duration-700 motion-reduce:transition-none"
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function Used({
  label,
  part,
  whole,
  gb,
}: {
  label: string;
  part: number;
  whole: number;
  gb: number;
}) {
  return (
    <Meter
      label={label}
      value={whole > 0 ? Math.round((part / whole) * 100) : 0}
      text={`${amount(part, gb)} of ${amount(whole, gb)} GB`}
    />
  );
}

/** Its CPU, memory and disk, watched while this is shown: nothing until the first reading. */
export function ComputerLoad({ target }: { target: LiveTarget }) {
  const reading = useReading(target);
  if (!reading) return null;
  return (
    <aside aria-label="About this computer" className="flex min-w-0 flex-col gap-5">
      <section className="flex flex-col gap-3.5">
        <Meters reading={reading} />
      </section>
    </aside>
  );
}

/** Its meters from one reading. */
function Meters({ reading }: { reading: Reading }) {
  const cpu = Math.round(reading.cpuUsedPct);
  return (
    <>
      <Meter label="CPU" value={cpu} text={`${cpu}%`} />
      <Used label="Memory" part={reading.memUsed} whole={reading.memTotal} gb={MEMORY} />
      <Used label="Disk" part={reading.diskUsed} whole={reading.diskTotal} gb={DISK} />
    </>
  );
}

/** Its meters, watched while they are shown: nothing until the first reading. */
export function Load({ target }: { target: LiveTarget }) {
  const reading = useReading(target);
  return reading ? <Meters reading={reading} /> : null;
}
