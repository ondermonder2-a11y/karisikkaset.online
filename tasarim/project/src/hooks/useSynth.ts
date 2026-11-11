import { useRef } from "react";
import { TrackSynth } from "@/audio/TrackSynth";

export function useSynth() {
  const synthRef = useRef<TrackSynth | null>(null);
  if (synthRef.current === null) synthRef.current = new TrackSynth();
  return synthRef.current;
}
