import { useCallback, useEffect, useRef, useState } from "react";
import { useSynth } from "@/hooks/useSynth";
import type { Station } from "@/data/tracks";

export function useRadioTuner(stations: Station[]) {
  const synth = useSynth();

  const [index, setIndex] = useState(0);
  const [isOn, setIsOn] = useState(false);
  const indexRef = useRef(0);

  useEffect(() => {
    synth.onTrackEnd = () => {
      synth.load(stations[indexRef.current]);
      synth.play();
    };
  }, [synth, stations]);

  useEffect(() => () => synth.stop(), [synth]);

  const selectStation = useCallback(
    (i: number) => {
      if (isOn && i === indexRef.current) return;
      indexRef.current = i;
      setIndex(i);
      setIsOn(true);
      synth.load(stations[i]);
      synth.play();
    },
    [synth, stations, isOn],
  );

  const setVolume = useCallback((value: number) => synth.setVolume(value), [synth]);
  const readLevels = useCallback((bands: number) => synth.getLevels(bands), [synth]);

  return {
    station: stations[index],
    stationIndex: index,
    isOn,
    selectStation,
    setVolume,
    readLevels,
  };
}
