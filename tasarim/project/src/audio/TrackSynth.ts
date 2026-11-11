import type { Track } from "@/data/tracks";
import { STEPS_PER_CHORD, getStepDuration, getTotalSteps } from "@/data/tracks";

const LOOKAHEAD_S = 0.15;
const TICK_MS = 25;

type Graph = {
  ctx: AudioContext;
  master: GainNode;
  analyser: AnalyserNode;
  filter: BiquadFilterNode;
  noise: AudioBuffer;
};

const midiToHz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

export class TrackSynth {
  private graph: Graph | null = null;
  private track: Track | null = null;
  private step = 0;
  private nextTime = 0;
  private timer: number | null = null;
  private volume = 0.8;
  onTrackEnd: () => void = () => {};

  load(track: Track) {
    this.track = track;
    this.step = 0;
  }

  play() {
    const graph = this.ensureGraph();
    if (graph.ctx.state === "suspended") void graph.ctx.resume();
    this.nextTime = Math.max(this.nextTime, graph.ctx.currentTime + 0.05);
    this.stopTimer();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  pause() {
    this.stopTimer();
  }

  stop() {
    this.stopTimer();
    this.step = 0;
  }

  setVolume(value: number) {
    this.volume = value;
    if (this.graph) {
      this.graph.master.gain.setTargetAtTime(value, this.graph.ctx.currentTime, 0.02);
    }
  }

  getElapsed() {
    if (!this.track) return 0;
    return this.step * getStepDuration(this.track);
  }

  getLevels(bands: number): number[] {
    if (!this.graph) return Array.from({ length: bands }, () => 0);
    const data = new Uint8Array(this.graph.analyser.frequencyBinCount);
    this.graph.analyser.getByteFrequencyData(data);
    const usable = Math.floor(data.length * 0.6);
    const perBand = Math.floor(usable / bands);
    return Array.from({ length: bands }, (_, band) => {
      let sum = 0;
      for (let i = 0; i < perBand; i++) sum += data[band * perBand + i];
      return sum / perBand / 255;
    });
  }

  private ensureGraph(): Graph {
    if (this.graph) return this.graph;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = this.volume;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2600;
    filter.Q.value = 0.8;
    filter.connect(master);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    master.connect(analyser);
    analyser.connect(ctx.destination);

    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

    this.graph = { ctx, master, analyser, filter, noise };
    return this.graph;
  }

  private stopTimer() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private schedule() {
    const graph = this.graph;
    const track = this.track;
    if (!graph || !track) return;
    const stepDur = getStepDuration(track);
    while (this.nextTime < graph.ctx.currentTime + LOOKAHEAD_S) {
      if (this.step >= getTotalSteps(track)) {
        this.stopTimer();
        this.onTrackEnd();
        return;
      }
      this.playStep(track, this.step, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step++;
    }
  }

  private playStep(track: Track, step: number, when: number, stepDur: number) {
    const chord = track.chords[Math.floor(step / STEPS_PER_CHORD) % track.chords.length];
    const pos = step % STEPS_PER_CHORD;
    const base = track.root;

    if (pos === 0) {
      chord.forEach((offset) => this.tone(base + 12 + offset, when, stepDur * STEPS_PER_CHORD, "sawtooth", 0.025, 0.4));
      this.tone(base + chord[0], when, stepDur * 3.5, "triangle", 0.3);
    }
    if (pos === 4) this.tone(base + chord[0], when, stepDur * 3.5, "triangle", 0.25);

    const octave = Math.floor(pos / 4) % 2 === 1 ? 12 : 0;
    const arp = base + 24 + chord[pos % chord.length] + octave;
    this.tone(arp, when, stepDur * 0.85, "square", 0.05);

    if (pos % 4 === 0) this.kick(when);
    if (pos % 2 === 1) this.hat(when);
  }

  private tone(midi: number, when: number, dur: number, type: OscillatorType, peak: number, attack = 0.01) {
    const { ctx, filter } = this.graph!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = midiToHz(midi);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain).connect(filter);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  private kick(when: number) {
    const { ctx, master } = this.graph!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(140, when);
    osc.frequency.exponentialRampToValueAtTime(42, when + 0.14);
    gain.gain.setValueAtTime(0.7, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
    osc.connect(gain).connect(master);
    osc.start(when);
    osc.stop(when + 0.2);
  }

  private hat(when: number) {
    const { ctx, noise, master } = this.graph!;
    const src = ctx.createBufferSource();
    const hp = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = noise;
    hp.type = "highpass";
    hp.frequency.value = 7000;
    gain.gain.setValueAtTime(0.09, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    src.connect(hp).connect(gain).connect(master);
    src.start(when, Math.random() * 0.5, 0.06);
  }
}
