import type { ReactNode } from "react";
import { FastForward, Pause, Play, Rewind, Square } from "lucide-react";

type TransportBarProps = {
  isPlaying: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onPrev: () => void;
  onNext: () => void;
};

type DeckButtonProps = {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
};

function DeckButton({ label, onClick, active = false, children }: DeckButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-12 w-full items-center justify-center rounded-sm transition duration-150 active:translate-y-0.5 ${
        active
          ? "bg-gradient-to-b from-zinc-400 to-zinc-600 text-zinc-950 shadow-[inset_0_3px_6px_rgba(0,0,0,0.45)]"
          : "bg-gradient-to-b from-zinc-100 via-zinc-300 to-zinc-500 text-zinc-900 shadow-[inset_0_-3px_0_rgba(0,0,0,0.35),0_3px_6px_rgba(0,0,0,0.5)] hover:brightness-110"
      }`}
    >
      {children}
    </button>
  );
}

export function TransportBar({ isPlaying, onPlayPause, onStop, onPrev, onNext }: TransportBarProps) {
  const PlayIcon = isPlaying ? Pause : Play;

  return (
    <div className="mx-auto grid w-full max-w-md grid-cols-4 gap-2 rounded-md bg-zinc-900 p-2 ring-1 ring-black">
      <DeckButton label="Previous track" onClick={onPrev}>
        <Rewind className="h-4 w-4" />
      </DeckButton>
      <DeckButton label="Stop" onClick={onStop} active={!isPlaying}>
        <Square className="h-3.5 w-3.5 fill-current" />
      </DeckButton>
      <DeckButton label={isPlaying ? "Pause" : "Play"} onClick={onPlayPause} active={isPlaying}>
        <span className="relative flex items-center justify-center">
          <PlayIcon className="h-4 w-4 fill-current" />
          {isPlaying && (
            <span className="absolute -top-3 h-1.5 w-1.5 animate-pulse rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]" />
          )}
        </span>
      </DeckButton>
      <DeckButton label="Next track" onClick={onNext}>
        <FastForward className="h-4 w-4" />
      </DeckButton>
    </div>
  );
}
