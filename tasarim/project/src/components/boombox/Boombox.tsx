import { useCallback, useEffect, useRef, useState } from "react";
import { CassetteDisplay } from "@/components/boombox/CassetteDisplay";
import { CassettePlaylist } from "@/components/boombox/CassettePlaylist";
import { RadioDisplay } from "@/components/boombox/RadioDisplay";
import { RadioPlaylist } from "@/components/boombox/RadioPlaylist";
import { RotaryKnob } from "@/components/boombox/RotaryKnob";
import { SpeakerGrille } from "@/components/boombox/SpeakerGrille";
import { SpectrumAnalyzer } from "@/components/boombox/SpectrumAnalyzer";
import { TransportBar } from "@/components/boombox/TransportBar";
import { STATIONS, TRACKS } from "@/data/tracks";
import { useCassettePlayer } from "@/hooks/useCassettePlayer";
import { useRadioTuner } from "@/hooks/useRadioTuner";

const STATION_LAST = STATIONS.length - 1;

export function Boombox() {
  const cassette = useCassettePlayer(TRACKS);
  const radio = useRadioTuner(STATIONS);
  const rootRef = useRef<HTMLDivElement>(null);
  const [volume, setVolumeState] = useState(0.8);

  const { togglePlay } = cassette;
  const { readLevels: readRadioLevels, selectStation, setVolume: setRadioVolume } = radio;
  const { readLevels: readCassetteLevels, setVolume: setCassetteVolume } = cassette;

  const setVolume = useCallback(
    (value: number) => {
      setVolumeState(value);
      setRadioVolume(value);
      setCassetteVolume(value);
    },
    [setRadioVolume, setCassetteVolume],
  );

  const readLevels = useCallback(
    (bands: number) => {
      const radioLevels = readRadioLevels(bands);
      const cassetteLevels = readCassetteLevels(bands);
      return radioLevels.map((level, i) => Math.max(level, cassetteLevels[i]));
    },
    [readRadioLevels, readCassetteLevels],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && target.closest("button, input, textarea, select, [role='slider']")) return;
      event.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay]);

  return (
    <div ref={rootRef} className="flex w-full max-w-6xl items-stretch gap-4">
      <div className="hidden lg:block">
        <SpeakerGrille />
      </div>

      <div className="min-w-0 flex-1 rounded-[28px] bg-gradient-to-b from-zinc-700 via-zinc-800 to-zinc-950 p-4 ring-1 ring-black shadow-[0_30px_60px_-20px_rgba(0,0,0,0.6)] sm:p-6">
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:gap-6">
          <RotaryKnob
            label="Tuning"
            readout={`${radio.station.frequency.toFixed(1)} MHz`}
            value={radio.stationIndex / STATION_LAST}
            steps={STATIONS.length}
            onChange={(value) => selectStation(Math.round(value * STATION_LAST))}
          />
          <SpectrumAnalyzer readLevels={readLevels} glowRef={rootRef} />
          <RotaryKnob
            label="Volume"
            readout={`${Math.round(volume * 100)}%`}
            value={volume}
            onChange={setVolume}
          />
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <RadioDisplay station={radio.station} isOn={radio.isOn} />
          <CassetteDisplay
            track={cassette.track}
            isPlaying={cassette.isPlaying}
            elapsed={cassette.elapsed}
            duration={cassette.duration}
          />
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <RadioPlaylist
            stations={STATIONS}
            activeIndex={radio.stationIndex}
            isOn={radio.isOn}
            onSelect={selectStation}
          />
          <CassettePlaylist
            tracks={TRACKS}
            activeIndex={cassette.trackIndex}
            isPlaying={cassette.isPlaying}
            onSelect={cassette.selectTrack}
          />
        </div>

        <div className="mt-6">
          <TransportBar
            isPlaying={cassette.isPlaying}
            onPlayPause={togglePlay}
            onStop={cassette.stop}
            onPrev={cassette.prev}
            onNext={cassette.next}
          />
        </div>
      </div>

      <div className="hidden lg:block">
        <SpeakerGrille />
      </div>
    </div>
  );
}
