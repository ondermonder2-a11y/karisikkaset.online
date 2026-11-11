import { ChevronLeft, ChevronRight } from "lucide-react";

type CassetteProps = {
  label: string;
  spinning: boolean;
};

const SPOKES = [0, 60, 120];

function Reel({ spinning }: { spinning: boolean }) {
  return (
    <div
      className={`relative h-14 w-14 rounded-full bg-zinc-200 ring-4 ring-zinc-800 ${
        spinning ? "animate-[spin_2.2s_linear_infinite]" : ""
      }`}
    >
      {SPOKES.map((deg) => (
        <span
          key={deg}
          className="absolute left-1/2 top-1/2 h-1.5 w-[70%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-700"
          style={{ transform: `translate(-50%, -50%) rotate(${deg}deg)` }}
        />
      ))}
      <span className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-900 ring-2 ring-zinc-400" />
    </div>
  );
}

export function Cassette({ label, spinning }: CassetteProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md bg-gradient-to-b from-zinc-800 to-zinc-950 p-2 ring-1 ring-black">
      <div className="relative flex h-20 items-center justify-center gap-4 overflow-hidden rounded-sm bg-zinc-950 ring-1 ring-zinc-700 sm:h-24">
        <Reel spinning={spinning} />
        <Reel spinning={spinning} />
        <div className="absolute inset-x-0 bottom-0 h-px bg-zinc-600" />
      </div>
      <div className="flex h-7 items-center rounded-sm bg-stone-100 px-2 ring-1 ring-black/20">
        <span className="truncate font-mono text-[10px] uppercase tracking-wider text-zinc-800 sm:text-xs">{label}</span>
      </div>
      <div className="flex items-center justify-center gap-1 text-[8px] font-semibold uppercase tracking-[0.2em] text-zinc-300 sm:text-[10px]">
        <ChevronLeft className="h-3 w-3" />
        Auto Reverse
        <ChevronRight className="h-3 w-3" />
      </div>
    </div>
  );
}
