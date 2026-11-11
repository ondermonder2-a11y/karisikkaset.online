import { Disc3 } from "lucide-react";
import { Cassette } from "@/components/boombox/Cassette";
import { getTrackDuration, type Track } from "@/data/tracks";
import { formatTime } from "@/lib/time";

type CassettePlaylistProps = {
  tracks: Track[];
  activeIndex: number;
  isPlaying: boolean;
  onSelect: (index: number) => void;
};

export function CassettePlaylist({ tracks, activeIndex, isPlaying, onSelect }: CassettePlaylistProps) {
  return (
    <section className="flex flex-col gap-3 overflow-hidden rounded-xl bg-zinc-950 p-3 ring-1 ring-black shadow-inner">
      <header className="flex items-center justify-between px-1">
        <h2 className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-amber-300">
          <Disc3 className="h-3.5 w-3.5" />
          Cassette Tracks
        </h2>
        <span className="font-mono text-[10px] text-zinc-400">{tracks.length} tracks</span>
      </header>
      <Cassette label={tracks[activeIndex].title} spinning={isPlaying} />
      <ul className="max-h-48 divide-y divide-zinc-800 overflow-y-auto rounded-md ring-1 ring-zinc-800">
        {tracks.map((track, i) => {
          const active = i === activeIndex;
          return (
            <li key={track.id}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-current={active ? "true" : undefined}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition duration-150 hover:bg-zinc-900 ${
                  active ? "bg-zinc-900" : ""
                }`}
              >
                <span
                  className={`w-6 shrink-0 font-mono text-xs ${active ? "text-red-400" : "text-zinc-400"}`}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-100">{track.title}</span>
                  <span className="block truncate text-xs text-zinc-400">{track.artist}</span>
                </span>
                <span className="shrink-0 font-mono text-xs text-zinc-300">
                  {formatTime(getTrackDuration(track))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
