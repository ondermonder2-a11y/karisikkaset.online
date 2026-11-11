import { Radio } from "lucide-react";
import type { Station } from "@/data/tracks";

type RadioDisplayProps = {
  station: Station;
  isOn: boolean;
};

const SIGNAL_BARS = 5;
const DIAL_MIN = 88;
const DIAL_MAX = 108;
const DIAL_TICKS = 41;

export function RadioDisplay({ station, isOn }: RadioDisplayProps) {
  const dialPosition = ((station.frequency - DIAL_MIN) / (DIAL_MAX - DIAL_MIN)) * 100;
  const litBars = isOn ? Math.round(station.signal * SIGNAL_BARS) : 0;

  return (
    <div className="min-w-0 rounded-md bg-zinc-950 p-2.5 ring-1 ring-black shadow-inner sm:p-3">
      <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.25em] text-amber-300/80 sm:text-[10px]">
        <span className="flex items-center gap-1.5">
          <Radio className="h-3 w-3" />
          FM Stereo
        </span>
        <span className="flex items-center gap-1.5 font-mono">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isOn ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]" : "bg-zinc-700"
            }`}
          />
          {isOn ? "On Air" : "Standby"}
        </span>
      </div>

      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl text-amber-300 [text-shadow:0_0_8px_rgba(252,176,64,0.6)] sm:text-3xl">
              {station.frequency.toFixed(1)}
            </span>
            <span className="font-mono text-[10px] text-amber-300/70">MHz</span>
          </div>
          <p className="truncate text-[11px] text-amber-200/75 sm:text-xs">{station.title}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[9px] uppercase tracking-[0.2em] text-amber-300/70">Signal</span>
          <div className="flex items-end gap-0.5">
            {Array.from({ length: SIGNAL_BARS }, (_, i) => (
              <span
                key={i}
                className={`w-1 rounded-sm transition-colors duration-300 ${
                  i < litBars ? "bg-amber-300 shadow-[0_0_4px_rgba(252,176,64,0.8)]" : "bg-zinc-700"
                }`}
                style={{ height: `${6 + i * 3}px` }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="relative mt-2 h-5">
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between">
          {Array.from({ length: DIAL_TICKS }, (_, i) => (
            <span key={i} className={`w-px bg-amber-300/50 ${i % 5 === 0 ? "h-4" : "h-2"}`} />
          ))}
        </div>
        <div
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)] transition-[left] duration-500 ease-out"
          style={{ left: `${dialPosition}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-amber-200/70">
        <span>{DIAL_MIN}</span>
        <span>{DIAL_MAX}</span>
      </div>
    </div>
  );
}
