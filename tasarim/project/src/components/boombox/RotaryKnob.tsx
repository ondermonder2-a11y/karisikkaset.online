import { useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";

type RotaryKnobProps = {
  label: string;
  readout: string;
  value: number;
  onChange: (value: number) => void;
  steps?: number;
};

const SWEEP_DEG = 270;
const TICK_COUNT = 11;
const DRAG_PIXELS = 160;

export function RotaryKnob({ label, readout, value, onChange, steps }: RotaryKnobProps) {
  const dragStart = useRef<{ y: number; value: number } | null>(null);
  const increment = steps ? 1 / (steps - 1) : 0.05;
  const angle = -SWEEP_DEG / 2 + value * SWEEP_DEG;

  const commit = (raw: number) => {
    const clamped = Math.min(1, Math.max(0, raw));
    onChange(steps ? Math.round(clamped * (steps - 1)) / (steps - 1) : clamped);
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { y: e.clientY, value };
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    commit(dragStart.current.value + (dragStart.current.y - e.clientY) / DRAG_PIXELS);
  };

  const endDrag = () => {
    dragStart.current = null;
  };

  const handleWheel = (e: WheelEvent<HTMLDivElement>) => {
    commit(value - Math.sign(e.deltaY) * increment);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      commit(value + increment);
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      commit(value - increment);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuetext={readout}
        aria-valuenow={Math.round(value * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        className="relative h-24 w-24 cursor-grab touch-none select-none rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 active:cursor-grabbing sm:h-28 sm:w-28"
      >
        <div className="absolute inset-0 rounded-full bg-gradient-to-b from-zinc-900 to-black ring-1 ring-zinc-600 shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]" />
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
          {Array.from({ length: TICK_COUNT }, (_, i) => {
            const deg = -SWEEP_DEG / 2 + (i * SWEEP_DEG) / (TICK_COUNT - 1);
            return (
              <line
                key={i}
                x1="50"
                y1="3"
                x2="50"
                y2={i % 5 === 0 ? 10 : 7}
                stroke="#e4e4e7"
                strokeWidth={i % 5 === 0 ? 2 : 1}
                strokeLinecap="round"
                transform={`rotate(${deg} 50 50)`}
              />
            );
          })}
        </svg>
        <div
          className="absolute inset-[18%] rounded-full bg-[repeating-conic-gradient(from_0deg,#52525b_0deg_4deg,#a1a1aa_4deg_8deg)] shadow-[0_6px_14px_rgba(0,0,0,0.7),inset_0_1px_1px_rgba(255,255,255,0.3)] ring-1 ring-black transition-transform duration-200 ease-out"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div className="absolute inset-[14%] rounded-full bg-[radial-gradient(circle_at_35%_30%,#fafafa_0%,#d4d4d8_45%,#71717a_100%)] shadow-inner" />
          <span className="absolute left-1/2 top-[6%] h-[20%] w-[7%] -translate-x-1/2 rounded-full bg-red-600 shadow-[0_0_4px_rgba(220,38,38,0.8)]" />
        </div>
      </div>
      <span className="text-[10px] uppercase tracking-[0.25em] text-zinc-300">{label}</span>
      <span className="font-mono text-xs text-amber-300">{readout}</span>
    </div>
  );
}
