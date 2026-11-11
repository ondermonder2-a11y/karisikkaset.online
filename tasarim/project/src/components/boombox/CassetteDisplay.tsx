import { formatTime } from "@/lib/time";
import type { Track } from "@/data/tracks";

type CassetteDisplayProps = {
  track: Track;
  isPlaying: boolean;
  elapsed: number;
  duration: number;
};

function CounterDigit({ char }: { char: string }) {
  return (
    <span className="flex h-7 w-5 items-center justify-center rounded-[3px] bg-zinc-900 font-mono text-base text-amber-300 ring-1 ring-black sm:h-8 sm:w-6 sm:text-lg">
      {char}
    </span>
  );
}

export function CassetteDisplay({ track, isPlaying, elapsed, duration }: CassetteDisplayProps) {
  const progress = duration > 0 ? Math.min(elapsed / duration, 1) : 0;
  const digits = formatTime(elapsed).replace(":", "").split("");

  return (
    <div className="flex items-center gap-3 rounded-md bg-zinc-950 p-2.5 ring-1 ring-black shadow-inner sm:gap-4 sm:p-3">
      <div className="flex items-center gap-1">
        {digits.slice(0, 2).map((char, i) => (
          <CounterDigit key={`m${i}`} char={char} />
        ))}
        <span className="px-0.5 font-mono text-amber-300">:</span>
        {digits.slice(2).map((char, i) => (
          <CounterDigit key={`s${i}`} char={char} />
        ))}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.25em] text-amber-300/80 sm:text-[10px]">
          <span className="truncate">Tape - {track.title}</span>
          <span className="flex shrink-0 items-center gap-1.5 font-mono">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isPlaying ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]" : "bg-zinc-700"
              }`}
            />
            {isPlaying ? "Play" : "Stop"}
          </span>
        </div>
        <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800 ring-1 ring-black">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-amber-400 to-red-500 transition-[width] duration-300 ease-linear"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-amber-200/70">
          <span>-{formatTime(Math.max(duration - elapsed, 0))}</span>
          <span className="truncate pl-2">{track.artist}</span>
        </div>
      </div>
    </div>
  );
}
