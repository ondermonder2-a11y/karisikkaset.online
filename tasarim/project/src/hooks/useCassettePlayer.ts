import { useCallback, useEffect, useRef, useState } from "react";
import { useSynth } from "@/hooks/useSynth";
import { getTrackDuration, type Track } from "@/data/tracks";

export function useCassettePlayer(tracks: Track[]) {
  const synth = useSynth();

  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const playingRef = useRef(false);

  useEffect(() => {
    synth.onTrackEnd = () => setIndex((i) => (i + 1) % tracks.length);
  }, [synth, tracks.length]);

  useEffect(() => {
    synth.load(tracks[index]);
    setElapsed(0);
    if (playingRef.current) synth.play();
  }, [index, synth, tracks]);

  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => setElapsed(synth.getElapsed()), 250);
    return () => window.clearInterval(id);
  }, [isPlaying, synth]);

  useEffect(() => () => synth.stop(), [synth]);

  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      synth.pause();
      playingRef.current = false;
      setIsPlaying(false);
    } else {
      synth.play();
      playingRef.current = true;
      setIsPlaying(true);
    }
  }, [synth]);

  const stop = useCallback(() => {
    synth.stop();
    playingRef.current = false;
    setIsPlaying(false);
    setElapsed(0);
  }, [synth]);

  const next = useCallback(() => setIndex((i) => (i + 1) % tracks.length), [tracks.length]);
  const prev = useCallback(() => setIndex((i) => (i - 1 + tracks.length) % tracks.length), [tracks.length]);
  const selectTrack = useCallback((i: number) => setIndex(i), []);
  const setVolume = useCallback((value: number) => synth.setVolume(value), [synth]);
  const readLevels = useCallback((bands: number) => synth.getLevels(bands), [synth]);

  return {
    track: tracks[index],
    trackIndex: index,
    isPlaying,
    elapsed,
    duration: getTrackDuration(tracks[index]),
    togglePlay,
    stop,
    next,
    prev,
    selectTrack,
    setVolume,
    readLevels,
  };
}
