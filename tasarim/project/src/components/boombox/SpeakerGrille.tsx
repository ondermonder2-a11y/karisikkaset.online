const LED_COUNT = 5;

export function SpeakerGrille() {
  return (
    <div className="flex h-full w-40 flex-col gap-3 rounded-2xl bg-gradient-to-b from-zinc-700 to-zinc-950 p-3 ring-1 ring-black shadow-xl">
      <div className="relative flex-1 overflow-hidden rounded-xl bg-[#bba388] ring-4 ring-zinc-900 shadow-inner">
        <div className="absolute inset-0 bg-[radial-gradient(circle,rgba(38,26,16,0.55)_1.2px,transparent_1.6px)] bg-[length:7px_7px]" />
        <div className="absolute inset-x-0 bottom-4 flex justify-center">
          <span className="rounded-sm bg-[#c9b596]/90 px-2 py-1 text-xs font-semibold tracking-[0.2em] text-zinc-900">
            2 WAY
          </span>
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 py-1">
        {Array.from({ length: LED_COUNT }, (_, i) => (
          <span
            key={i}
            className="h-2 w-2 rounded-full bg-amber-400"
            style={{
              boxShadow:
                "0 0 calc(3px + var(--beat, 0) * 14px) rgba(251, 191, 36, calc(0.25 + var(--beat, 0) * 0.75))",
              opacity: "calc(0.35 + var(--beat, 0) * 0.65)",
            }}
          />
        ))}
      </div>
    </div>
  );
}
