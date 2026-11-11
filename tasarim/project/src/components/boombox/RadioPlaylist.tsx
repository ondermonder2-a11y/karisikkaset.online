import { Radio } from "lucide-react";
import type { Station } from "@/data/tracks";

type RadioPlaylistProps = {
  stations: Station[];
  activeIndex: number;
  isOn: boolean;
  onSelect: (index: number) => void;
};

export function RadioPlaylist({ stations, activeIndex, isOn, onSelect }: RadioPlaylistProps) {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl bg-zinc-950 ring-1 ring-black shadow-inner">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-amber-300">
          <Radio className="h-3.5 w-3.5" />
          Radio Stations
        </h2>
        <span className="font-mono text-[10px] text-zinc-400">{stations.length} stations</span>
      </header>
      <ul className="max-h-72 divide-y divide-zinc-800 overflow-y-auto">
        {stations.map((station, i) => {
          const active = i === activeIndex;
          return (
            <li key={station.id}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-current={active ? "true" : undefined}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition duration-150 hover:bg-zinc-900 ${
                  active ? "bg-zinc-900" : ""
                }`}
              >
                <span
                  className={`w-14 shrink-0 font-mono text-base ${
                    active ? "text-amber-300 [text-shadow:0_0_8px_rgba(252,176,64,0.5)]" : "text-zinc-300"
                  }`}
                >
                  {station.frequency.toFixed(1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-100">{station.title}</span>
                  <span className="block truncate text-xs text-zinc-400">{station.artist}</span>
                </span>
                {active && (
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      isOn ? "animate-pulse bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]" : "bg-amber-400"
                    }`}
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
