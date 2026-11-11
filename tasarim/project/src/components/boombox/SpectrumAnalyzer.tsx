import { useEffect, useRef, type RefObject } from "react";

const BARS = 20;

type SpectrumAnalyzerProps = {
  readLevels: (bands: number) => number[];
  glowRef: RefObject<HTMLElement>;
};

export function SpectrumAnalyzer({ readLevels, glowRef }: SpectrumAnalyzerProps) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const levels = readLevels(BARS);
      levels.forEach((level, i) => {
        const bar = bars.current[i];
        if (bar) bar.style.height = `${Math.max(4, Math.min(1, level * 1.6) * 100)}%`;
      });
      const beat = Math.min(1, ((levels[0] + levels[1] + levels[2]) / 3) * 1.6);
      glowRef.current?.style.setProperty("--beat", beat.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [readLevels, glowRef]);

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md bg-zinc-950 p-3 ring-1 ring-black shadow-inner">
      <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.25em] text-amber-300/80 sm:text-[10px]">
        <span>Spectrum</span>
        <span className="font-mono">dB</span>
      </div>
      <div className="flex h-20 items-end gap-[3px] sm:h-24">
        {Array.from({ length: BARS }, (_, i) => (
          <span
            key={i}
            ref={(el) => {
              bars.current[i] = el;
            }}
            className="flex-1 rounded-t-[2px] bg-gradient-to-t from-amber-700 via-amber-400 to-amber-200 shadow-[0_0_8px_rgba(251,191,36,0.55)] transition-[height] duration-75 ease-out"
            style={{ height: "4%" }}
          />
        ))}
      </div>
    </div>
  );
}
