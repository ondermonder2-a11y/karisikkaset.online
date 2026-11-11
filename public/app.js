/**
 * app.js — Karışık Kaset | Ana uygulama
 *
 * Modüller:
 *  - DataLoader    : /api/stations ve /api/tracks uç noktalarından veri çeker
 *  - AudioEngine   : HTML5 Audio + Web Audio API (radyo stream, GainNode, AnalyserNode)
 *  - TapeController: SoundCloud Widget API sarmalayıcı (gizli iframe)
 *  - RadioController: Radyo modu mantığı (istasyon seçimi, proxy stream, snap)
 *  - Spectrum      : Spectrum analyzer (radyo: gerçek, kaset: simüle)
 *  - UI            : DOM güncellemeleri, knob, listeler, transport
 */

'use strict';

/* ═══════════════════════════════════════════════════════
   YARDIMCI FONKSİYONLAR
   ═══════════════════════════════════════════════════════ */

/** mm:ss biçimlendirme */
function formatTime(seconds) {
  const total = Math.floor(Math.max(0, seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Toast mesajı göster (3 sn sonra kaybolur) */
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

/* ═══════════════════════════════════════════════════════
   DATA LOADER
   ═══════════════════════════════════════════════════════ */
const DataLoader = {
  async fetchStations() {
    try {
      const res = await fetch('/api/stations');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.warning) showToast(`İstasyonlar: ${json.warning}`);
      return json.stations || [];
    } catch (err) {
      showToast('İstasyonlar yüklenemedi: ' + err.message);
      return [];
    }
  },
  async fetchStationHealth() {
    const res = await fetch('/api/station-status');
    if (!res.ok) throw new Error(`İstasyon durumları alınamadı (HTTP ${res.status}).`);
    return res.json();
  },
  /** config/tapes/ klasöründeki tüm kaset JSON'larını yükler.
   *  Her öğe: { id, label, color, tracks[] } */
  async fetchTapes() {
    try {
      const res = await fetch('/api/tapes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.warning) showToast(`Kasetler: ${json.warning}`);
      // Her parçaya _duration = null ekle
      (json.tapes || []).forEach(tape =>
        tape.tracks.forEach(t => { t._duration = null; })
      );
      return json.tapes || [];
    } catch (err) {
      showToast('Kasetler yüklenemedi: ' + err.message);
      return [];
    }
  }
};

/* ═══════════════════════════════════════════════════════
   AUDIO ENGINE
   Web Audio API ile radyo stream ve spektrum analizi
   ═══════════════════════════════════════════════════════ */
class AudioEngine {
  constructor() {
    this._ctx = null;
    this._gain = null;
    this._analyser = null;
    this._audio = null;
    this._playRequestId = 0;
    this._volume = 0.8;
    this._freqData = null;
  }

  /** AudioContext'i ilk kullanıcı etkileşiminde başlatır (tarayıcı politikası) */
  ensureContext() {
    if (this._ctx) return;
    this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._gain = this._ctx.createGain();
    this._gain.gain.value = this._volume;
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 512;
    this._analyser.smoothingTimeConstant = 0.8;
    this._freqData = new Uint8Array(this._analyser.frequencyBinCount);
    this._gain.connect(this._analyser);
    this._analyser.connect(this._ctx.destination);
  }

  /**
   * Verilen URL'yi radyo stream olarak çalar.
   * PLS/M3U URL'leri sunucu tarafında /api/resolve ile çözümlenir.
   * Tüm ses /api/stream proxy üzerinden akar (CORS + güvenlik).
   */
  async playStream(url) {
    this.stop();
    const requestId = this._playRequestId;
    this.ensureContext();

    // PLS veya M3U ise sunucudan gerçek stream URL'sini al
    let streamUrl = url;
    const lowerUrl = url.toLowerCase().split('?')[0];
    if (lowerUrl.endsWith('.pls') || lowerUrl.endsWith('.m3u') || lowerUrl.endsWith('.m3u8')) {
      try {
        const res = await fetch(`/api/resolve?url=${encodeURIComponent(url)}`);
        if (res.ok) {
          const json = await res.json();
          if (json.streamUrl) {
            streamUrl = json.streamUrl;
            console.log(`[AudioEngine] PLS/M3U çözümlendi → ${streamUrl}`);
          }
        }
      } catch (e) {
        console.warn('[AudioEngine] Resolve hatası, orijinal URL deneniyor:', e.message);
      }
    }

    if (requestId !== this._playRequestId) return null;

    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    this._audio = audio;

    // Proxy üzerinden aktar — backend beyaz liste kontrolü yapar.
    // Not: /api/stream, PLS'yi de kendi içinde çözer; resolve adımı
    // Audio elemanının doğru Content-Type alması için yapılır.
    const proxyUrl = `/api/stream?url=${encodeURIComponent(url)}`;
    audio.src = proxyUrl;
    audio.preload = 'none';

    try {
      if (this._ctx.state === 'suspended') await this._ctx.resume();
      if (requestId !== this._playRequestId) return null;
      const src = this._ctx.createMediaElementSource(audio);
      src.connect(this._gain);
      await audio.play();
    } catch (err) {
      if (requestId === this._playRequestId && this._audio === audio && err.name !== 'AbortError') {
        showToast('Stream başlatılamadı: ' + (err.message || err));
        console.error('[AudioEngine] play hatası:', err);
      }
    }

    return audio;
  }

  stop() {
    this._playRequestId++;
    if (this._audio) {
      this._audio.pause();
      this._audio.src = '';
      this._audio = null;
    }
  }

  pause() { this._audio?.pause(); }
  resume() {
    if (this._audio) {
      if (this._ctx?.state === 'suspended') this._ctx.resume();
      this._audio.play().catch(() => {});
    }
  }

  setVolume(v) {
    this._volume = v;
    if (this._gain && this._ctx) {
      this._gain.gain.setTargetAtTime(v, this._ctx.currentTime, 0.02);
    }
  }

  /** Frekans bantlarını 0–1 aralığında döner */
  getLevels(bands) {
    if (!this._analyser || !this._freqData) return Array(bands).fill(0);
    this._analyser.getByteFrequencyData(this._freqData);
    const usable = Math.floor(this._freqData.length * 0.65);
    const perBand = Math.max(1, Math.floor(usable / bands));
    return Array.from({ length: bands }, (_, b) => {
      let sum = 0;
      for (let i = 0; i < perBand; i++) sum += this._freqData[b * perBand + i] || 0;
      return (sum / perBand) / 255;
    });
  }

  get isPlaying() { return this._audio && !this._audio.paused; }
}

/* ═══════════════════════════════════════════════════════
   TAPE CONTROLLER (SoundCloud Widget API)
   ═══════════════════════════════════════════════════════ */
class TapeController {
  /**
   * @param {HTMLIFrameElement} iframe - Gizli SoundCloud iframe
   */
  constructor(iframe) {
    this._iframe = iframe;
    this._widget = null;
    this._ready = false;
    this._volume = 80; // 0-100
    this._currentDuration = 0;
    this._currentPosition = 0;
    this._isPlaying = false;
    this._pendingUrl = null;
    this._pendingPlay = false;
    this._autoplayAttempt = 0;
    this._autoplayTimer = null;

    // Callback'ler (dışarıdan set edilir)
    this.onReady = null;
    this.onPlay = null;
    this.onPause = null;
    this.onFinish = null;
    this.onProgress = null; // { position, duration }
    this.onError = null;

    this._init();
  }

  _init() {
    // SC.Widget API hazır mı?
    if (typeof SC === 'undefined' || !SC.Widget) {
      console.warn('[Tape] SoundCloud Widget API yüklenemedi.');
      return;
    }
    this._widget = SC.Widget(this._iframe);
    this._widget.bind(SC.Widget.Events.READY, () => {
      this._ready = true;
      this._widget.setVolume(this._volume);
      if (this._pendingUrl) {
        this._loadAndPlay(this._pendingUrl, this._pendingPlay);
        this._pendingUrl = null;
        this._pendingPlay = false;
      }
      this.onReady?.();
    });
    this._widget.bind(SC.Widget.Events.PLAY, () => {
      this._isPlaying = true;
      clearTimeout(this._autoplayTimer);
      this._autoplayTimer = null;
      this.onPlay?.();
    });
    this._widget.bind(SC.Widget.Events.PAUSE, () => {
      this._isPlaying = false;
      this.onPause?.();
    });
    this._widget.bind(SC.Widget.Events.FINISH, () => {
      this._isPlaying = false;
      this.onFinish?.();
    });
    this._widget.bind(SC.Widget.Events.PLAY_PROGRESS, (data) => {
      this._currentPosition = (data.currentPosition || 0) / 1000; // ms → s
      this._currentDuration = (data.loadedProgress > 0 && data.duration ? data.duration : this._currentDuration) / 1000;
      this.onProgress?.({ position: this._currentPosition, duration: this._currentDuration });
    });
    // Hata olayı
    this._widget.bind(SC.Widget.Events.ERROR, (err) => {
      this._isPlaying = false;
      console.error('[Tape] SC Widget hatası:', err);
      this.onError?.(err);
    });

    // iframe başlangıç URL'si HTML'de tanımlı; burada tekrar atama yapmıyoruz.
    // Widget API, iframe yüklendiğinde READY olayını ateşler.
  }

  /**
   * SoundCloud parçasını yükle ve opsiyonel olarak çal.
   * @param {string} scUrl  - soundcloud.com URL'si
   * @param {boolean} autoPlay
   */
  load(scUrl, autoPlay = true) {
    if (!this._ready) {
      this._pendingUrl = scUrl;
      this._pendingPlay = autoPlay;
      return;
    }
    this._loadAndPlay(scUrl, autoPlay);
  }

  _loadAndPlay(scUrl, autoPlay) {
    this._currentDuration = 0;
    this._currentPosition = 0;
    this._isPlaying = false;
    const autoplayAttempt = ++this._autoplayAttempt;
    clearTimeout(this._autoplayTimer);
    // Widget.load() ile yeni parça yükle
    this._widget.load(scUrl, {
      auto_play: autoPlay,
      hide_related: true,
      show_comments: false,
      show_user: true,
      show_reposts: false,
      show_teaser: false,
      visual: false,
      buying: false,
      liking: false,
      download: false,
      sharing: false,
      callback: () => {
        // Süreyi widget'tan al
        this._widget.getDuration((ms) => {
          this._currentDuration = ms / 1000;
          this.onProgress?.({ position: this._currentPosition, duration: this._currentDuration });
        });
      }
    });
    if (autoPlay) {
      // Send play in the selection gesture too; mobile browsers may ignore delayed auto_play.
      this._widget.play();
      this._autoplayTimer = setTimeout(() => {
        if (autoplayAttempt === this._autoplayAttempt && !this._isPlaying) {
          this.onAutoplayBlocked?.();
        }
      }, 4000);
    }
  }

  play()  {
    clearTimeout(this._autoplayTimer);
    this._autoplayTimer = null;
    this._widget?.play();
  }
  pause() { this._widget?.pause(); }

  /** Pozisyona git (saniye) */
  seek(seconds) {
    this._widget?.seekTo(Math.floor(seconds * 1000));
  }

  setVolume(v) {
    // v: 0–1 arası → widget 0–100 arası ister
    this._volume = Math.round(v * 100);
    this._widget?.setVolume(this._volume);
  }

  getDuration()  { return this._currentDuration; }
  getPosition()  { return this._currentPosition; }
  get isPlaying(){ return this._isPlaying; }
}

/* ═══════════════════════════════════════════════════════
   SPECTRUM ANALYZER
   - Radyo modu   : AudioEngine.getLevels() kullanır (gerçek analiz)
   - Kaset modu   : Simüle edilmiş animasyon
     NOT: SoundCloud iframe sesine tarayıcıdan erişilemediği için
          kaset modunda gerçek frekans analizi YAPILAMAZ.
          Bunun yerine yumuşak geçişli, rastgele ama gerçekçi görünen
          simülasyon kullanılır. Düşük bantlar daha yüksek tutulur.
   ═══════════════════════════════════════════════════════ */
const SPECTRUM_BARS = 48;
const SPECTRUM_STYLES = ['mirror', 'equalizer', 'wave', 'classic', 'led', 'mono', 'fire'];

class Spectrum {
  constructor(containerEl, audioEngine) {
    this._container = containerEl;
    this._audio = audioEngine;
    this._bars = [];
    this._animFrame = null;
    this._mode = 'radio'; // 'radio' | 'tape'
    this._tapeIsPlaying = false;
    this._powered = true;
    this._visualization = 'mirror';
    this._wavePhase = 0;
    this._wavePaths = [];
    this._speakerLightMode = 'rhythm';
    this._randomLight = 0.5;
    this._randomLightTarget = 0.5;
    this._beat = 0;

    // Simülasyon için hedef seviyeler (kaset modu)
    this._simTargets = Array(SPECTRUM_BARS).fill(0);
    this._simCurrents = Array(SPECTRUM_BARS).fill(0);
    this._simTimer = 0;

    this._buildBars();
    const savedStyle = localStorage.getItem('kk_spectrum_style');
    const visualization = SPECTRUM_STYLES.includes(savedStyle) ? savedStyle : 'mirror';
    this.setVisualization(visualization);
    this.setSpeakerLightMode(localStorage.getItem('kk_speaker_light_mode') || 'rhythm');
    this._tick();
  }

  _buildBars() {
    this._container.innerHTML = '';
    for (let i = 0; i < SPECTRUM_BARS; i++) {
      const bar = document.createElement('span');
      bar.className = 'sbar-item';
      bar.style.height = '4%';
      bar.style.setProperty('--bar-hue', String(300 - (i / (SPECTRUM_BARS - 1)) * 300));
      this._container.appendChild(bar);
      this._bars.push(bar);
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spectrum-wave');
    svg.setAttribute('viewBox', '0 0 600 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const defs = document.createElementNS(svg.namespaceURI, 'defs');
    const gradient = document.createElementNS(svg.namespaceURI, 'linearGradient');
    gradient.id = 'spectrum-wave-gradient';
    gradient.innerHTML = '<stop offset="0%" stop-color="#22d3ee"/><stop offset="48%" stop-color="#f0abfc"/><stop offset="100%" stop-color="#22d3ee"/>';
    defs.appendChild(gradient);
    svg.appendChild(defs);
    for (let i = 0; i < 3; i++) {
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('class', `spectrum-wave-line spectrum-wave-line-${i + 1}`);
      svg.appendChild(path);
      this._wavePaths.push(path);
    }
    this._container.appendChild(svg);
  }

  setMode(mode) { this._mode = mode; }
  setTapePlaying(v) { this._tapeIsPlaying = v; }
  setPowered(powered) { this._powered = powered; }

  setVisualization(style) {
    if (!SPECTRUM_STYLES.includes(style)) return;
    this._visualization = style;
    this._container.dataset.visualization = style;
    localStorage.setItem('kk_spectrum_style', style);
    document.querySelectorAll('[data-spectrum-style]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.spectrumStyle === style));
    });
  }

  setSpeakerLightMode(mode) {
    if (mode !== 'rhythm' && mode !== 'random') return;
    this._speakerLightMode = mode;
    localStorage.setItem('kk_speaker_light_mode', mode);
    const button = document.getElementById('speaker-light-toggle');
    if (button) {
      button.textContent = mode === 'rhythm' ? 'Işık: Ritim' : 'Işık: Rastgele';
      button.setAttribute('aria-pressed', String(mode === 'random'));
      button.setAttribute('aria-label', `Hoparlör ışık modu: ${mode === 'rhythm' ? 'ritim' : 'rastgele'}`);
    }
    const speakerLight = mode === 'random' ? this._randomLight : this._beat;
    document.documentElement.style.setProperty('--speaker-light', speakerLight.toFixed(3));
  }

  toggleSpeakerLightMode() {
    this.setSpeakerLightMode(this._speakerLightMode === 'rhythm' ? 'random' : 'rhythm');
  }

  _tick() {
    this._animFrame = requestAnimationFrame(() => this._tick());
    this._simTimer++;

    if (!this._powered) {
      this._bars.forEach(bar => { bar.style.height = '0%'; });
      this._beat = 0;
      document.documentElement.style.setProperty('--beat', '0');
      document.documentElement.style.setProperty('--speaker-light', '0');
      return;
    }

    let levels;

    if (this._mode === 'radio') {
      // Gerçek zamanlı analiz (radyo stream'in Web Audio AnalyserNode'u)
      levels = this._audio.getLevels(SPECTRUM_BARS);
    } else {
      // ── SIMÜLASYON (kaset modu) ──────────────────────────────────
      // SoundCloud iframe sesine tarayıcıdan doğrudan erişilemez,
      // bu nedenle kaset modu için simüle edilmiş spektrum animasyonu kullanılır.
      // Çalma durumuna göre hedef seviyeleri güncelle.
      if (this._simTimer % 8 === 0 && this._tapeIsPlaying) {
        // Yeni rastgele hedefler: bas frekanslar (düşük indeks) daha yüksek
        for (let i = 0; i < SPECTRUM_BARS; i++) {
          const bassFactor = 1 - (i / SPECTRUM_BARS) * 0.65;
          const rand = Math.random();
          this._simTargets[i] = this._tapeIsPlaying
            ? rand * 0.75 * bassFactor + 0.05
            : 0;
        }
      }
      if (!this._tapeIsPlaying) {
        for (let i = 0; i < SPECTRUM_BARS; i++) this._simTargets[i] = 0;
      }
      // Yumuşak geçiş (lerp)
      for (let i = 0; i < SPECTRUM_BARS; i++) {
        this._simCurrents[i] += (this._simTargets[i] - this._simCurrents[i]) * 0.12;
      }
      levels = this._simCurrents;
    }

    // Çubukları güncelle
    let beatSum = 0;
    levels.forEach((lvl, i) => {
      const maxHeight = this._visualization === 'mirror' ? 48 : 100;
      const idleHeight = this._visualization === 'equalizer'
        ? 20 + Math.max(0, Math.sin(i * 0.52 + this._simTimer * 0.045)) * 36
        : this._visualization === 'mirror'
          ? 3 + Math.max(0, Math.sin(i * 0.47)) * 9
          : 0;
      const signalHeight = lvl * (this._visualization === 'equalizer' ? 145 : maxHeight);
      const pct = Math.max(idleHeight, Math.min(maxHeight, signalHeight));
      if (this._bars[i]) this._bars[i].style.height = pct + '%';
      if (i < 3) beatSum += lvl;
    });

    if (this._visualization === 'wave') this._updateWave(levels);

    // Beat efekti (hoparlör LED'leri için CSS değişkeni)
    const beat = Math.min(1, (beatSum / 3) * 1.6);
    this._beat = beat;
    document.documentElement.style.setProperty('--beat', beat.toFixed(3));
    if (this._simTimer % 18 === 0) this._randomLightTarget = Math.random();
    this._randomLight += (this._randomLightTarget - this._randomLight) * 0.08;
    const speakerLight = this._speakerLightMode === 'random' ? this._randomLight : beat;
    document.documentElement.style.setProperty('--speaker-light', speakerLight.toFixed(3));
  }

  _updateWave(levels) {
    this._wavePhase += 0.055;
    this._wavePaths.forEach((path, pathIndex) => {
      const amplitude = [1, 0.62, 0.34][pathIndex];
      const phaseOffset = pathIndex * 1.4;
      const points = levels.map((level, index) => {
        const x = (index / (levels.length - 1)) * 600;
        const envelope = 18 + level * 35;
        const wave = Math.sin(index * 0.5 + this._wavePhase + phaseOffset)
          + Math.sin(index * 0.19 - this._wavePhase * 0.7) * 0.28;
        return [x, 50 + wave * envelope * amplitude];
      });
      path.setAttribute('d', points.map(([x, y], index) =>
        `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
      ).join(' '));
    });
  }

  destroy() { cancelAnimationFrame(this._animFrame); }
}

/* ═══════════════════════════════════════════════════════
   RADIO CONTROLLER
   ═══════════════════════════════════════════════════════ */
class RadioController {
  constructor(audioEngine, stations) {
    this._audio = audioEngine;
    this._stations = stations;
    this._currentIndex = -1;
    this._isOn = false;

    this.onStationChange = null; // (station, index)
    this.onStateChange = null;   // (isOn)
  }

  get stations() { return this._stations; }
  get currentIndex() { return this._currentIndex; }
  get isOn() { return this._isOn; }
  get currentStation() { return this._stations[this._currentIndex] || null; }

  async selectStation(index) {
    if (index < 0 || index >= this._stations.length) return;
    const station = this._stations[index];
    this._currentIndex = index;
    this._isOn = true;
    this.onStationChange?.(station, index);
    this.onStateChange?.(true);
    await this._audio.playStream(station.streamUrl);
  }

  stop() {
    this._audio.stop();
    this._isOn = false;
    this.onStateChange?.(false);
  }

  pause() { this._audio.pause(); this._isOn = false; this.onStateChange?.(false); }
  resume() { this._audio.resume(); this._isOn = true; this.onStateChange?.(true); }

  next() {
    if (!this._stations.length) return;
    const next = (this._currentIndex + 1) % this._stations.length;
    this.selectStation(next);
  }
  prev() {
    if (!this._stations.length) return;
    const prev = (this._currentIndex - 1 + this._stations.length) % this._stations.length;
    this.selectStation(prev);
  }

  /** Frekansa göre en yakın istasyonu bul */
  snapToFrequency(freq) {
    if (!this._stations.length) return null;
    let best = null, bestDist = Infinity;
    this._stations.forEach((s, i) => {
      const d = Math.abs(s.frequency - freq);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    // 0.4 MHz içindeyse snap yap
    if (bestDist <= 0.4) return best;
    return null;
  }
}

/* ═══════════════════════════════════════════════════════
   UI
   DOM etkileşimleri, knob mantığı, liste render
   ═══════════════════════════════════════════════════════ */
class UI {
  constructor(app) {
    this._app = app;

    // Ses seviyesi
    this._volume = parseFloat(localStorage.getItem('kk_volume') || '0.8');

    // FM tuning durumu (88–108 MHz)
    this._FM_MIN = 88;
    this._FM_MAX = 108;
    this._currentFreq = 91.4;

    // Knob drag durumları
    this._tuningDrag = null;
    this._volumeDrag = null;
    this._signalTimer = null;

    // Cetvel tiklerini oluştur
    this._buildRulerTicks();
    // Spectrum barlarını oluştur (Spectrum sınıfı yapar)
    // Knob tiklerini oluştur
    this._buildKnobTicks('tuning-ticks');
    this._buildKnobTicks('volume-ticks');

    this._bindKnobs();
    this._bindTransport();
    this._bindProgressBar();
    this._bindKeyboard();
    this._bindRequestBoard();
    this._bindTapeCollection();
    this._bindRadioCollection();
    this._bindRoomLightSwitch();
    this._bindLegalDialogs();
    this._updateFrequencyClock();
    this._clockTimer = setInterval(() => this._updateFrequencyClock(), 1_000);
    this._powerBootTimer = null;
    document.querySelector('.spectrum-modes')?.addEventListener('click', event => {
      const button = event.target.closest('[data-spectrum-style]');
      if (button) this._app._spectrum.setVisualization(button.dataset.spectrumStyle);
    });
    document.getElementById('speaker-light-toggle')?.addEventListener('click', () => {
      this._app._spectrum.toggleSpeakerLightMode();
    });
    document.getElementById('tape-category-filter')?.addEventListener('change', event => {
      this._app.setTapeCategory(event.currentTarget.value);
    });
    document.getElementById('tape-choice')?.addEventListener('change', event => {
      const tapeIndex = Number(event.currentTarget.value);
      if (Number.isInteger(tapeIndex) && tapeIndex >= 0) {
        this._app.switchToTapeBySelector(tapeIndex);
      }
    });

    // Ses seviyesini uygula
    this._setVolumeDisplay(this._volume);
    this._updateFMDisplay();
    this._updateTuningKnob();
    this._updateSpectrumTrack('FM Stereo');
    const frequencyDisplay = document.getElementById('radio-freq');
    if (frequencyDisplay && 'ResizeObserver' in window) {
      this._frequencyResizeObserver = new ResizeObserver(() => this._renderDigitalFrequency(this._currentFreq));
      this._frequencyResizeObserver.observe(frequencyDisplay);
    }
  }

  _bindRequestBoard() {
    const dialog = document.getElementById('song-request-dialog');
    const form = document.getElementById('song-request-form');
    const status = document.getElementById('song-request-status');
    const openButton = document.getElementById('open-song-request');
    const copyButton = document.getElementById('copy-site-link');
    const closeButton = document.getElementById('close-song-request');
    const submitButton = form?.querySelector('[type="submit"]');
    if (!dialog || !form || !status || !openButton || !closeButton || !submitButton) return;

    openButton.addEventListener('click', () => {
      status.textContent = '';
      status.classList.remove('is-error');
      dialog.showModal();
      form.elements.namedItem('song')?.focus();
    });
    const sharedUrl = encodeURIComponent(window.location.href);
    const shareText = encodeURIComponent(`${document.title} - Retro Radyo ve Kaset Çalar`);
    document.querySelectorAll('[data-share-provider]').forEach(link => {
      const provider = link.dataset.shareProvider;
      const shareUrls = {
        whatsapp: `https://api.whatsapp.com/send?text=${shareText}%20${sharedUrl}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${sharedUrl}`,
        x: `https://twitter.com/intent/tweet?text=${shareText}&url=${sharedUrl}`,
        telegram: `https://t.me/share/url?url=${sharedUrl}&text=${shareText}`
      };
      if (shareUrls[provider]) link.href = shareUrls[provider];
    });
    copyButton?.addEventListener('click', async () => {
      try {
        try {
          await navigator.clipboard.writeText(window.location.href);
        } catch (clipboardError) {
          const field = document.createElement('textarea');
          field.value = window.location.href;
          field.setAttribute('readonly', '');
          field.style.position = 'fixed';
          field.style.opacity = '0';
          document.body.appendChild(field);
          field.select();
          const copied = document.execCommand('copy');
          field.remove();
          if (!copied) throw clipboardError;
        }
        showToast('Site bağlantısı kopyalandı.');
      } catch (error) {
        console.error('[UI] Site bağlantısı kopyalanamadı:', error);
        showToast('Site bağlantısı kopyalanamadı: ' + error.message);
      }
    });
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      status.textContent = 'Gönderiliyor...';
      status.classList.remove('is-error');
      submitButton.disabled = true;
      try {
        const response = await fetch('/api/song-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
        });
        let result;
        try {
          result = await response.json();
        } catch {
          throw new Error('Sunucudan geçerli bir yanıt alınamadı.');
        }
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        form.reset();
        status.textContent = result.message;
      } catch (error) {
        status.textContent = `İstek gönderilemedi: ${error.message}`;
        status.classList.add('is-error');
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  _bindTapeCollection() {
    const dialog = document.getElementById('tape-collection-dialog');
    const list = document.getElementById('tape-collection-list');
    const openButton = document.getElementById('open-tape-collection');
    const closeButton = document.getElementById('close-tape-collection');
    if (!dialog || !list || !openButton || !closeButton) return;

    const renderCollection = () => {
      list.replaceChildren();
      const tapes = this._app._tapes;
      if (!tapes.length) {
        const empty = document.createElement('p');
        empty.className = 'tape-collection-empty';
        empty.textContent = 'Kaset koleksiyonu yüklenemedi veya henüz kaset eklenmedi.';
        list.appendChild(empty);
        return;
      }

      tapes.forEach((tape, tapeIndex) => {
        const card = document.createElement('article');
        card.className = 'tape-collection-card';

        const heading = document.createElement('div');
        heading.className = 'tape-collection-card-heading';
        const label = document.createElement('span');
        label.className = 'tape-collection-label';
        label.textContent = tape.label;
        const category = document.createElement('span');
        category.className = 'tape-collection-category';
        category.textContent = tape.category || 'Diğer';
        const count = document.createElement('span');
        count.className = 'tape-collection-count';
        count.textContent = `${tape.tracks.length} parça`;
        const info = document.createElement('div');
        info.className = 'tape-collection-info';
        info.append(label, category, count);

        const playButton = document.createElement('button');
        playButton.className = 'tape-collection-play';
        playButton.type = 'button';
        playButton.textContent = '▶ Çal';
        playButton.setAttribute('aria-label', `${tape.label} kasetini çal`);
        playButton.addEventListener('click', () => {
          dialog.close();
          this._app.switchToTapeBySelector(tapeIndex);
        });
        heading.append(info, playButton);
        card.appendChild(heading);

        const tracksDetails = document.createElement('details');
        tracksDetails.className = 'tape-collection-track-details';
        const tracksSummary = document.createElement('summary');
        tracksSummary.textContent = 'Parça listesini göster';
        const tracks = document.createElement('ol');
        tracks.className = 'tape-collection-tracks';
        tape.tracks.forEach(track => {
          const item = document.createElement('li');
          const title = document.createElement('span');
          title.className = 'tape-collection-track-title';
          title.textContent = track.title;
          item.appendChild(title);
          if (track.subtitle) {
            const artist = document.createElement('span');
            artist.className = 'tape-collection-track-artist';
            artist.textContent = track.subtitle;
            item.appendChild(artist);
          }
          tracks.appendChild(item);
        });
        tracksDetails.append(tracksSummary, tracks);
        card.appendChild(tracksDetails);
        list.appendChild(card);
      });
    };

    openButton.addEventListener('click', () => {
      renderCollection();
      dialog.showModal();
      closeButton.focus();
    });
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
  }

  _bindRadioCollection() {
    const dialog = document.getElementById('radio-collection-dialog');
    const list = document.getElementById('radio-collection-list');
    const openButton = document.getElementById('open-radio-collection');
    const closeButton = document.getElementById('close-radio-collection');
    if (!dialog || !list || !openButton || !closeButton) return;

    let likedStations = new Set();
    try {
      const savedLikes = JSON.parse(localStorage.getItem('kk_station_likes') || '[]');
      if (Array.isArray(savedLikes)) likedStations = new Set(savedLikes.filter(value => typeof value === 'string'));
    } catch (error) {
      console.warn('[UI] Beğenilen istasyonlar okunamadı:', error);
    }

    const saveLikes = () => {
      try {
        localStorage.setItem('kk_station_likes', JSON.stringify([...likedStations]));
      } catch (error) {
        console.error('[UI] Beğenilen istasyonlar kaydedilemedi:', error);
        showToast('Beğeniler kaydedilemedi: ' + error.message);
      }
    };

    const renderStations = () => {
      list.replaceChildren();
      const stations = this._app._stations;
      if (!stations.length) {
        const empty = document.createElement('p');
        empty.className = 'tape-collection-empty';
        empty.textContent = 'Radyo istasyonları yüklenemedi veya henüz istasyon eklenmedi.';
        list.appendChild(empty);
        return;
      }

      stations.forEach((station, index) => {
        const card = document.createElement('article');
        card.className = 'radio-collection-card';
        if (this._app._radio?.currentIndex === index) card.classList.add('is-active');

        const info = document.createElement('div');
        info.className = 'radio-collection-info';
        const frequency = document.createElement('span');
        frequency.className = 'radio-collection-frequency';
        frequency.textContent = `${Number(station.frequency).toFixed(1)} MHz`;
        const name = document.createElement('span');
        name.className = 'radio-collection-name';
        name.textContent = station.name || 'İsimsiz istasyon';
        const genre = document.createElement('span');
        genre.className = 'radio-collection-genre';
        genre.textContent = station.genre || 'Tür belirtilmemiş';
        const health = this._app._stationHealth.get(station.streamUrl);
        const healthBadge = document.createElement('span');
        healthBadge.className = `station-health-badge ${health?.healthy === true ? 'is-online' : health?.healthy === false ? 'is-offline' : ''}`;
        healthBadge.textContent = health?.healthy === true ? 'ONLINE' : health?.healthy === false ? 'OFFLINE' : 'TEST';
        healthBadge.title = health?.message || 'İstasyon bağlantı kontrolü bekleniyor.';
        info.append(frequency, name, genre, healthBadge);

        const actions = document.createElement('div');
        actions.className = 'radio-collection-actions';
        const tuneButton = document.createElement('button');
        tuneButton.className = 'radio-tune-button';
        tuneButton.type = 'button';
        tuneButton.textContent = 'Dinle';
        tuneButton.setAttribute('aria-label', `${station.name || 'İstasyon'} istasyonunu dinle`);
        tuneButton.addEventListener('click', () => {
          dialog.close();
          this._app.switchToRadio(index);
        });

        const likeButton = document.createElement('button');
        likeButton.className = 'radio-like-button';
        likeButton.type = 'button';
        const updateLikeButton = () => {
          const liked = likedStations.has(station.streamUrl);
          likeButton.classList.toggle('is-liked', liked);
          likeButton.setAttribute('aria-pressed', String(liked));
          likeButton.setAttribute('aria-label', liked
            ? `${station.name || 'İstasyon'} beğenisini kaldır`
            : `${station.name || 'İstasyon'} istasyonunu beğen`);
          likeButton.innerHTML = `<span class="radio-like-heart" aria-hidden="true">${liked ? '♥' : '♡'}</span><span>${liked ? 'Beğenildi' : 'Beğen'}</span>`;
        };
        updateLikeButton();
        likeButton.addEventListener('click', () => {
          const liked = !likedStations.has(station.streamUrl);
          if (liked) likedStations.add(station.streamUrl);
          else likedStations.delete(station.streamUrl);
          updateLikeButton();
          saveLikes();
          if (liked) {
            likeButton.classList.remove('like-pop');
            void likeButton.offsetWidth;
            likeButton.classList.add('like-pop');
            const burst = document.createElement('span');
            burst.className = 'radio-like-burst';
            burst.setAttribute('aria-hidden', 'true');
            burst.textContent = '♥';
            likeButton.appendChild(burst);
            burst.addEventListener('animationend', () => burst.remove(), { once: true });
          }
        });

        actions.append(tuneButton, likeButton);
        card.append(info, actions);
        list.appendChild(card);
      });
    };
    this._renderRadioCollection = renderStations;

    openButton.addEventListener('click', () => {
      renderStations();
      dialog.showModal();
      closeButton.focus();
    });
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
  }

  _bindRoomLightSwitch() {
    const lightButton = document.getElementById('room-light-switch');
    const fullscreenButton = document.getElementById('fullscreen-switch');
    const powerButton = document.getElementById('player-power-switch');
    const app = document.querySelector('.app-bg');
    if (!app) return;

    lightButton?.addEventListener('click', () => {
      const dimmed = app.classList.toggle('room-dim');
      lightButton.setAttribute('aria-pressed', String(dimmed));
      const label = dimmed ? 'Oda ışığını aç' : 'Oda ışığını kapat';
      lightButton.setAttribute('aria-label', label);
      lightButton.title = label;
    });

    fullscreenButton?.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await document.documentElement.requestFullscreen();
        }
      } catch (error) {
        console.error('[UI] Tam ekran değiştirilemedi:', error);
        showToast('Tam ekran açılamadı: ' + error.message);
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const isFullscreen = Boolean(document.fullscreenElement);
      const label = isFullscreen ? 'Tam ekrandan çık' : 'Tam ekranı aç';
      fullscreenButton?.setAttribute('aria-label', label);
      if (fullscreenButton) fullscreenButton.title = label;
    });

    powerButton?.addEventListener('click', () => this._app.togglePower());
  }

  _bindLegalDialogs() {
    const dialogs = [
      ['open-cookie-policy', 'cookie-policy-dialog'],
      ['open-legal-notice', 'legal-notice-dialog']
    ];

    dialogs.forEach(([buttonId, dialogId]) => {
      const button = document.getElementById(buttonId);
      const dialog = document.getElementById(dialogId);
      if (!button || !dialog) return;

      button.addEventListener('click', () => dialog.showModal());
      dialog.querySelector('[data-close-legal]')?.addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
      });
    });
  }

  /* ─── Ruler (FM cetvel) ─── */
  _buildRulerTicks() {
    const container = document.getElementById('ruler-ticks');
    if (!container) return;
    // 88–108 = 20 MHz, her 0.5'te bir tik (41 tik)
    const count = 41;
    for (let i = 0; i < count; i++) {
      const tick = document.createElement('span');
      tick.className = `ruler-tick ${i % 5 === 0 ? 'major' : 'minor'}`;
      container.appendChild(tick);
    }
  }

  /* ─── Knob tiklerini SVG'ye çiz ─── */
  _buildKnobTicks(svgId) {
    const svg = document.getElementById(svgId);
    if (!svg) return;
    const COUNT = 21, SWEEP = 270;
    for (let i = 0; i < COUNT; i++) {
      const deg = -SWEEP / 2 + (i * SWEEP) / (COUNT - 1);
      const radians = (deg * Math.PI) / 180;
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(50 + Math.sin(radians) * 44));
      dot.setAttribute('cy', String(50 - Math.cos(radians) * 44));
      dot.setAttribute('r', '3');
      dot.classList.add('knob-tick-dot');
      svg.appendChild(dot);
    }
  }

  _updateKnobTicks(svgId, value) {
    const dots = document.getElementById(svgId)?.querySelectorAll('.knob-tick-dot');
    if (!dots?.length) return;
    const activeCount = Math.round(Math.max(0, Math.min(1, value)) * dots.length);
    dots.forEach((dot, index) => dot.classList.toggle('active', index < activeCount));
  }

  /* ─── Knob bağlama ─── */
  _bindKnobs() {
    // ── Tuning knob ──
    const tuningKnob = document.getElementById('knob-tuning');
    if (tuningKnob) {
      tuningKnob.addEventListener('pointerdown', (e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        this._tuningDrag = { startY: e.clientY, startFreq: this._currentFreq };
      });
      tuningKnob.addEventListener('pointermove', (e) => {
        if (!this._tuningDrag) return;
        const delta = (this._tuningDrag.startY - e.clientY) / 160; // 160px = tam tarama
        const range = this._FM_MAX - this._FM_MIN;
        const raw = this._tuningDrag.startFreq + delta * range;
        this._setFrequency(Math.max(this._FM_MIN, Math.min(this._FM_MAX, raw)));
      });
      tuningKnob.addEventListener('pointerup',     () => { this._tuningDrag = null; });
      tuningKnob.addEventListener('pointercancel', () => { this._tuningDrag = null; });
      tuningKnob.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = 0.1 * (this._app._stations.length > 1 ? 1 : 0.5);
        this._setFrequency(Math.max(this._FM_MIN, Math.min(this._FM_MAX, this._currentFreq - Math.sign(e.deltaY) * step)));
      }, { passive: false });
      tuningKnob.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          e.preventDefault();
          this._setFrequency(Math.min(this._FM_MAX, this._currentFreq + 0.1));
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          this._setFrequency(Math.max(this._FM_MIN, this._currentFreq - 0.1));
        }
      });
    }

    // ── Volume knob ──
    const volumeKnob = document.getElementById('knob-volume');
    if (volumeKnob) {
      volumeKnob.addEventListener('pointerdown', (e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        this._volumeDrag = { startY: e.clientY, startVol: this._volume };
      });
      volumeKnob.addEventListener('pointermove', (e) => {
        if (!this._volumeDrag) return;
        const delta = (this._volumeDrag.startY - e.clientY) / 160;
        const raw = this._volumeDrag.startVol + delta;
        this._setVolume(Math.max(0, Math.min(1, raw)));
      });
      volumeKnob.addEventListener('pointerup',     () => { this._volumeDrag = null; });
      volumeKnob.addEventListener('pointercancel', () => { this._volumeDrag = null; });
      volumeKnob.addEventListener('wheel', (e) => {
        e.preventDefault();
        this._setVolume(Math.max(0, Math.min(1, this._volume - Math.sign(e.deltaY) * 0.05)));
      }, { passive: false });
      volumeKnob.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          e.preventDefault(); this._setVolume(Math.min(1, this._volume + 0.05));
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault(); this._setVolume(Math.max(0, this._volume - 0.05));
        }
      });
    }
  }

  _setFrequency(freq) {
    this._currentFreq = parseFloat(freq.toFixed(1));
    this._updateTuningKnob();
    this._updateFMDisplay();

    // Snap kontrolü
    const app = this._app;
    const snapIdx = app._radio.snapToFrequency(this._currentFreq);
    if (snapIdx !== null) {
      // Snap: istasyona otomatik otur
      app.switchToRadio(snapIdx);
    } else {
      // İstasyon yok: statik ses (gürültü)
      app.playStatic();
    }
  }

  _updateTuningKnob() {
    const face = document.getElementById('knob-tuning-face');
    if (!face) return;
    const ratio = (this._currentFreq - this._FM_MIN) / (this._FM_MAX - this._FM_MIN);
    const angle = -135 + ratio * 270;
    face.style.transform = `rotate(${angle}deg)`;
    this._updateKnobTicks('tuning-ticks', ratio);

    const knob = document.getElementById('knob-tuning');
    if (knob) {
      knob.setAttribute('aria-valuenow', this._currentFreq);
      knob.setAttribute('aria-valuetext', `${this._currentFreq.toFixed(1)} MHz`);
    }
  }

  _setVolume(v) {
    this._volume = v;
    this._setVolumeDisplay(v);
    localStorage.setItem('kk_volume', String(v));
    this._app._audioEngine.setVolume(v);
    this._app._tape.setVolume(v);
  }

  _setVolumeDisplay(v) {
    const face = document.getElementById('knob-volume-face');
    if (face) face.style.transform = `rotate(${-135 + v * 270}deg)`;
    this._updateKnobTicks('volume-ticks', v);
    const knob = document.getElementById('knob-volume');
    if (knob) {
      knob.setAttribute('aria-valuenow', Math.round(v * 100));
      knob.setAttribute('aria-valuetext', `${Math.round(v * 100)}%`);
    }
  }

  /* ─── FM Display güncelle ─── */
  _updateFMDisplay(station = null) {
    const freq = this._currentFreq;
    this._renderDigitalFrequency(freq);

    // Cetvel iğnesi
    const needle = document.getElementById('ruler-needle');
    if (needle) {
      const pct = ((freq - this._FM_MIN) / (this._FM_MAX - this._FM_MIN)) * 100;
      needle.style.left = `${pct}%`;
    }

    if (station) {
      document.getElementById('radio-station-name').textContent = station.name || '';
      document.getElementById('radio-station-genre').textContent = station.genre || '';
      this._updateSpectrumTrack(`${station.name || 'FM Stereo'}${station.genre ? ` — ${station.genre}` : ''}`);
    }
  }

  _updateFrequencyClock() {
    const dateDisplay = document.getElementById('radio-date');
    const timeDisplay = document.getElementById('radio-time');
    if (!dateDisplay || !timeDisplay) return;
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const date = `${day}.${month}.${year}`;
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(value => String(value).padStart(2, '0'))
      .join(':');
    this._renderDigitalText(dateDisplay, date);
    this._renderDigitalText(timeDisplay, time);
    dateDisplay.setAttribute('aria-label', `Tarih: ${date}`);
    timeDisplay.setAttribute('aria-label', `Saat: ${time}`);
  }

  setPowerState(powered, showBootEffect = powered) {
    const panel = document.querySelector('.center-panel');
    const boombox = document.querySelector('.boombox-row');
    if (panel) {
      panel.classList.toggle('power-off', !powered);
      panel.inert = !powered;
      panel.classList.remove('power-booting');
      clearTimeout(this._powerBootTimer);
      if (powered && showBootEffect) {
        panel.classList.add('power-booting');
        this._powerBootTimer = setTimeout(() => panel.classList.remove('power-booting'), 900);
      }
    }
    boombox?.classList.toggle('power-off', !powered);
    const speakerLights = document.getElementById('speaker-light-toggle');
    if (speakerLights) speakerLights.disabled = !powered;
    const powerSwitch = document.getElementById('player-power-switch');
    if (powerSwitch) {
      powerSwitch.setAttribute('aria-pressed', String(powered));
      const label = powered ? 'Player elektriğini kes' : 'Player elektriğini aç';
      powerSwitch.setAttribute('aria-label', label);
      powerSwitch.title = label;
    }
  }

  _renderDigitalText(display, value) {
    const segments = {
      '0': 'abcdef',
      '1': 'bc',
      '2': 'abged',
      '3': 'abgcd',
      '4': 'fgbc',
      '5': 'afgcd',
      '6': 'afgecd',
      '7': 'abc',
      '8': 'abcdefg',
      '9': 'abfgcd'
    };
    display.replaceChildren();
    for (const character of value.toUpperCase()) {
      if (character === '.') {
        const decimal = document.createElement('span');
        decimal.className = 'freq-info-decimal';
        display.appendChild(decimal);
        continue;
      }
      if (character === ':') {
        const colon = document.createElement('span');
        colon.className = 'freq-info-colon';
        display.appendChild(colon);
        continue;
      }
      const digit = document.createElement('span');
      digit.className = 'freq-info-digit';
      for (const segment of 'abcdefg') {
        const element = document.createElement('i');
        element.className = `freq-segment segment-${segment}${segments[character]?.includes(segment) ? ' lit' : ''}`;
        digit.appendChild(element);
      }
      display.appendChild(digit);
    }
  }

  _renderDigitalFrequency(freq) {
    const display = document.getElementById('radio-freq');
    if (!display) return;
    const segments = {
      '0': 'abcdef',
      '1': 'bc',
      '2': 'abged',
      '3': 'abgcd',
      '4': 'fgbc',
      '5': 'afgcd',
      '6': 'afgecd',
      '7': 'abc',
      '8': 'abcdefg',
      '9': 'abfgcd'
    };
    const value = freq.toFixed(1);
    display.replaceChildren();
    display.setAttribute('aria-label', `${value} MHz`);
    const ghostCount = Math.max(3, Math.floor((display.clientWidth - 136) / 32));
    const ghosts = document.createElement('span');
    ghosts.className = 'freq-ghosts';
    ghosts.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < ghostCount; i++) {
      const ghostDigit = document.createElement('span');
      ghostDigit.className = 'freq-digit freq-ghost-digit';
      for (const segment of 'abcdefg') {
        const element = document.createElement('i');
        element.className = `freq-segment segment-${segment}`;
        ghostDigit.appendChild(element);
      }
      ghosts.appendChild(ghostDigit);
    }
    display.appendChild(ghosts);
    for (const character of value) {
      if (character === '.') {
        const decimal = document.createElement('span');
        decimal.className = 'freq-decimal';
        decimal.setAttribute('aria-hidden', 'true');
        display.appendChild(decimal);
        continue;
      }
      const digit = document.createElement('span');
      digit.className = 'freq-digit';
      digit.setAttribute('aria-hidden', 'true');
      for (const segment of 'abcdefg') {
        const element = document.createElement('i');
        element.className = `freq-segment segment-${segment}${segments[character].includes(segment) ? ' lit' : ''}`;
        digit.appendChild(element);
      }
      display.appendChild(digit);
    }
  }

  _updateSpectrumTrack(text) {
    const wrap = document.getElementById('spectrum-track-wrap');
    const label = document.getElementById('spectrum-track-text');
    const copy = document.getElementById('spectrum-track-copy');
    if (!wrap || !label || !copy) return;
    const segments = {
      '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
      '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abfgcd',
      A: 'abcefg', B: 'cdefg', C: 'adef', D: 'bcdeg', E: 'adefg', F: 'aefg',
      G: 'acdef', H: 'bcefg', I: 'bc', J: 'bcde', K: 'bcefg', L: 'def',
      M: 'ceg', N: 'abcef', O: 'abcdef', P: 'abefg', Q: 'abfgc', R: 'abefgc',
      S: 'afgcd', T: 'defg', U: 'bcdef', V: 'cde', W: 'bcde', X: 'bcefg',
      Y: 'bcdfg', Z: 'abged', '-': 'g', '–': 'g', '—': 'g'
    };
    const turkishCharacters = {
      ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
      Ç: 'C', Ğ: 'G', İ: 'I', I: 'I', Ö: 'O', Ş: 'S', Ü: 'U'
    };
    const displayText = text
      .replace(/[çğıöşüÇĞİÖŞÜ]/g, character => turkishCharacters[character])
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9 .:\-–—]/g, '');
    const renderLabel = element => {
      element.replaceChildren();
      for (const character of displayText) {
        if (character === ' ') {
          const space = document.createElement('span');
          space.className = 'freq-info-space';
          element.appendChild(space);
          continue;
        }
        if (character === '.' || character === ':') {
          const punctuation = document.createElement('span');
          punctuation.className = character === '.' ? 'freq-info-decimal' : 'freq-info-colon';
          element.appendChild(punctuation);
          continue;
        }
        if (character === 'M') {
          const letter = document.createElement('span');
          letter.className = 'freq-info-letter-m';
          letter.innerHTML = '<svg viewBox="0 0 7 12" aria-hidden="true"><path d="M.8 11V1L3.5 5.5 6.2 1V11"/></svg>';
          element.appendChild(letter);
          continue;
        }
        const digit = document.createElement('span');
        digit.className = 'freq-info-digit';
        for (const segment of 'abcdefg') {
          const part = document.createElement('i');
          part.className = `freq-segment segment-${segment}${segments[character]?.includes(segment) ? ' lit' : ''}`;
          digit.appendChild(part);
        }
        element.appendChild(digit);
      }
    };
    renderLabel(label);
    renderLabel(copy);
    label.setAttribute('aria-hidden', 'true');
    copy.setAttribute('aria-hidden', 'true');
    wrap.setAttribute('aria-label', text);
    requestAnimationFrame(() => {
      wrap.classList.toggle('is-scrolling', label.getBoundingClientRect().width > wrap.clientWidth + 4);
    });
  }

  /* ─── Radyo durum UI ─── */
  updateRadioStatus(isOn, station = null) {
    const dot  = document.getElementById('radio-dot');
    const text = document.getElementById('radio-status-text');
    if (isOn) {
      dot?.classList.add('on-air');
      if (text) text.textContent = 'On Air';
    } else {
      dot?.classList.remove('on-air');
      if (text) text.textContent = 'Standby';
    }
    if (station) {
      this._currentFreq = station.frequency;
      this._updateFMDisplay(station);
      this._updateTuningKnob();
    }
    // Signal barları
    const bars = document.querySelectorAll('.sbar');
    const renderSignal = () => {
      const litCount = 1 + Math.floor(Math.random() * bars.length);
      bars.forEach((bar, i) => bar.classList.toggle('lit', i < litCount));
    };
    if (isOn && bars.length) {
      if (!this._signalTimer) {
        renderSignal();
        this._signalTimer = setInterval(renderSignal, 700);
      }
    } else {
      clearInterval(this._signalTimer);
      this._signalTimer = null;
      bars.forEach(bar => bar.classList.remove('lit'));
    }
    // Aktif mod vurgusu
    document.getElementById('radio-display')?.classList.toggle('mode-active', isOn);
    document.getElementById('tape-display')?.classList.remove('mode-active');
  }

  updateNowPlaying(metadata) {
    const nowPlaying = document.getElementById('radio-now-playing');
    const nowPlayingCopy = document.getElementById('radio-now-playing-copy');
    const nowPlayingWrap = document.getElementById('radio-now-playing-wrap');
    if (!nowPlaying || !nowPlayingCopy || !nowPlayingWrap) return;
    const title = metadata?.title || 'Şarkı bilgisi alınamıyor';
    nowPlaying.textContent = title;
    nowPlayingCopy.textContent = title;
    nowPlayingWrap.classList.toggle('is-scrolling', nowPlaying.scrollWidth > nowPlayingWrap.clientWidth + 4);
    const stationName = document.getElementById('radio-station-name')?.textContent.trim();
    const genre = document.getElementById('radio-station-genre')?.textContent.trim();
    this._updateSpectrumTrack(metadata?.title
      ? `${stationName || 'FM Stereo'} — ${metadata.title}`
      : `${stationName || 'FM Stereo'}${genre ? ` — ${genre}` : ''}`);
  }

  /* ─── Kaset durum UI ─── */
  updateTapeStatus(isPlaying, track = null) {
    const dot  = document.getElementById('tape-dot');
    const text = document.getElementById('tape-status-text');
    if (isPlaying) {
      dot?.classList.add('tape-play');
      if (text) text.textContent = 'Play';
    } else {
      dot?.classList.remove('tape-play');
      if (text) text.textContent = 'Stop';
    }
    if (track) {
      document.querySelector('.cassette-title').textContent = track.subtitle || 'GUESS THE SONG';
      document.getElementById('tape-label').textContent = track.title || 'Karışık Kaset';
      document.getElementById('tape-track-artist').textContent = track.subtitle || '';
    }
    // Makara animasyonu
    ['reel-left','reel-right'].forEach(id => {
      const reel = document.getElementById(id);
      if (!reel) return;
      if (isPlaying) {
        reel.classList.add('spinning');
      } else {
        // Yavaşlayarak dur: CSS animation'ı gecikmeli kaldır
        reel.style.animationPlayState = 'paused';
        setTimeout(() => {
          reel.classList.remove('spinning');
          reel.style.animationPlayState = '';
        }, 600);
      }
    });
    // Aktif mod vurgusu
    document.getElementById('tape-display')?.classList.toggle('mode-active', isPlaying);
    if (isPlaying) document.getElementById('radio-display')?.classList.remove('mode-active');
  }

  /* ─── Sayaç ve ilerleme çubuğu ─── */
  updateTapeProgress(position, duration) {
    // Dijital sayaç
    const digits = document.querySelectorAll('.cdigit');
    const formatted = formatTime(position);
    const parts = formatted.replace(':', '').split('');
    digits.forEach((d, i) => { d.textContent = parts[i] || '0'; });

    // Kalan süre
    const remaining = duration > 0 ? Math.max(0, duration - position) : 0;
    const remEl = document.getElementById('progress-remaining');
    if (remEl) remEl.textContent = `-${formatTime(remaining)}`;

    // İlerleme çubuğu
    const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = `${pct}%`;
    const bar = document.getElementById('progress-bar');
    if (bar) bar.setAttribute('aria-valuenow', Math.round(pct));
  }

  resetTapeCounter() {
    document.querySelectorAll('.cdigit').forEach(d => d.textContent = '0');
    const remEl = document.getElementById('progress-remaining');
    if (remEl) remEl.textContent = '-00:00';
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = '0%';
  }

  /* ─── Play/Pause/Stop düğmeleri ─── */
  setPlayState(isPlaying) {
    const btn  = document.getElementById('btn-play');
    const dot  = document.getElementById('play-dot');
    const icoP = document.getElementById('icon-play');
    const icoU = document.getElementById('icon-pause');
    const btnStop = document.getElementById('btn-stop');

    if (isPlaying) {
      btn?.setAttribute('aria-pressed', 'true');
      dot?.classList.add('active');
      icoP?.classList.add('hidden');
      icoU?.classList.remove('hidden');
      btnStop?.setAttribute('aria-pressed', 'false');
    } else {
      btn?.setAttribute('aria-pressed', 'false');
      dot?.classList.remove('active');
      icoP?.classList.remove('hidden');
      icoU?.classList.add('hidden');
      btnStop?.setAttribute('aria-pressed', 'true');
    }
  }

  /* ─── Transport butonları ─── */
  _bindTransport() {
    document.getElementById('btn-play')?.addEventListener('click', () => this._app.togglePlay());
    document.getElementById('btn-stop')?.addEventListener('click', () => this._app.stop());
    document.getElementById('btn-prev')?.addEventListener('click', () => this._app.prev());
    document.getElementById('btn-next')?.addEventListener('click', () => this._app.next());
  }

  /* ─── İlerleme çubuğu tıklama (seekTo) ─── */
  _bindProgressBar() {
    const bar = document.getElementById('progress-bar');
    if (!bar) return;
    const seek = (e) => {
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this._app.seekTape(ratio);
    };
    bar.addEventListener('click', seek);
    // Sürükleme desteği
    let dragging = false;
    bar.addEventListener('pointerdown', (e) => {
      bar.setPointerCapture(e.pointerId);
      dragging = true;
      seek(e);
    });
    bar.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
    bar.addEventListener('pointerup',   () => { dragging = false; });
    bar.addEventListener('pointercancel', () => { dragging = false; });
  }

  /* ─── Klavye kısayolları ─── */
  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      // Input alanlarında kısayolları devre dışı bırak
      const tag = e.target.tagName;
      if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
      if (e.target.isContentEditable) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this._app.togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this._app.prev();
          break;
        case 'ArrowRight':
          e.preventDefault();
          this._app.next();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this._setVolume(Math.min(1, this._volume + 0.05));
          break;
        case 'ArrowDown':
          e.preventDefault();
          this._setVolume(Math.max(0, this._volume - 0.05));
          break;
      }
    });
  }

  /* ─── Radyo listesini render et ─── */
  renderStationList(stations, activeIndex, isOn) {
    const list = document.getElementById('station-list');
    const countEl = document.getElementById('station-count');
    if (!list) return;

    countEl.textContent = `${stations.length} station${stations.length !== 1 ? 's' : ''}`;

    if (stations.length === 0) {
      list.innerHTML = '<li class="station-item" style="justify-content:center;color:#71717a;cursor:default">Henüz istasyon yok</li>';
      return;
    }

    list.innerHTML = '';
    stations.forEach((s, i) => {
      const active = i === activeIndex;
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', active ? 'true' : 'false');

      const btn = document.createElement('button');
      btn.className = `station-item${active ? ' active' : ''}`;
      btn.dataset.stationIndex = String(i);
      btn.type = 'button';
      const health = this._app._stationHealth.get(s.streamUrl);
      const statusText = health?.healthy === true ? 'Çevrimiçi' : health?.healthy === false ? 'Çevrimdışı' : 'Bağlantı kontrol ediliyor';
      btn.classList.toggle('is-offline', health?.healthy === false);
      btn.setAttribute('aria-label', `${s.frequency.toFixed(1)} MHz – ${s.name}${s.genre ? ` - ${s.genre}` : ''} - ${statusText}`);

      btn.innerHTML = `
        <span class="station-freq">${s.frequency.toFixed(1)}</span>
        <span class="station-info">
          <span class="station-info-name">${this._esc(s.name || '')}</span>
          ${s.genre ? `<span class="station-info-separator" aria-hidden="true">-</span><span class="station-info-genre">${this._esc(s.genre)}</span>` : ''}
        </span>
        <span class="station-health-badge ${health?.healthy === true ? 'is-online' : health?.healthy === false ? 'is-offline' : ''}" title="${this._esc(health?.message || 'İstasyon bağlantı kontrolü bekleniyor.')}">${health?.healthy === true ? 'ONLINE' : health?.healthy === false ? 'OFFLINE' : 'TEST'}</span>
        ${active ? `<span class="station-dot ${isOn ? 'playing' : ''}"></span>` : ''}
      `;
      btn.addEventListener('click', () => this._app.switchToRadio(i));
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  updateStationHealth() {
    const stations = this._app._stations;
    document.querySelectorAll('#station-list .station-item[data-station-index]').forEach(button => {
      const station = stations[Number(button.dataset.stationIndex)];
      if (!station) return;
      const health = this._app._stationHealth.get(station.streamUrl);
      const badge = button.querySelector('.station-health-badge');
      const statusText = health?.healthy === true ? 'Çevrimiçi' : health?.healthy === false ? 'Çevrimdışı' : 'Bağlantı kontrol ediliyor';
      button.classList.toggle('is-offline', health?.healthy === false);
      button.setAttribute('aria-label', `${station.frequency.toFixed(1)} MHz – ${station.name}${station.genre ? ` - ${station.genre}` : ''} - ${statusText}`);
      if (badge) {
        badge.textContent = health?.healthy === true ? 'ONLINE' : health?.healthy === false ? 'OFFLINE' : 'TEST';
        badge.title = health?.message || 'İstasyon bağlantı kontrolü bekleniyor.';
        badge.classList.toggle('is-online', health?.healthy === true);
        badge.classList.toggle('is-offline', health?.healthy === false);
      }
    });
    const dialog = document.getElementById('radio-collection-dialog');
    if (dialog?.open) this._renderRadioCollection?.();
  }

  /** Aktif istasyon satırını görünür alana kaydır */
  scrollStationIntoView(index) {
    const list = document.getElementById('station-list');
    if (!list) return;
    const item = list.querySelectorAll('li')[index];
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ─── Kaset listesini render et ─── */
  renderTrackList(tracks, activeIndex, errorIndices = new Set(), tapeIdx = 0) {
    const list = document.getElementById('track-list');
    const countEl = document.getElementById('track-count');
    if (!list) return;

    countEl.textContent = `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`;

    if (tracks.length === 0) {
      list.innerHTML = '<li class="track-item" style="justify-content:center;color:#71717a;cursor:default">Henüz parça yok</li>';
      return;
    }

    list.innerHTML = '';
    tracks.forEach((t, i) => {
      const active = i === activeIndex;
      const isErr  = errorIndices.has(`${tapeIdx}:${i}`);
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', active ? 'true' : 'false');

      const btn = document.createElement('button');
      btn.className = `track-item${active ? ' active' : ''}${isErr ? ' error' : ''}`;
      btn.type = 'button';
      btn.setAttribute('aria-label', `${String(i+1).padStart(2,'0')} – ${t.title}`);
      if (isErr) btn.setAttribute('aria-disabled', 'true');

      const dur = t._duration != null ? formatTime(t._duration) : '--:--';

      btn.innerHTML = `
        <span class="track-num">${String(i+1).padStart(2,'0')}</span>
        <span class="track-info">
          <span class="track-info-title">${this._esc(t.title || '')}</span>
          <span class="track-info-sub">${this._esc(t.subtitle || '')}</span>
        </span>
        <span class="track-duration">${dur}</span>
      `;
      btn.addEventListener('click', () => {
        if (!isErr) this._app.switchToTape(i);
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  /** Aktif parça satırını görünür alana kaydır */
  scrollTrackIntoView(index) {
    const list = document.getElementById('track-list');
    if (!list) return;
    const item = list.querySelectorAll('li')[index];
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* Kaset seçicilerini kategori ve aktif kasete göre güncelle */
  renderTapeSelectors(tapes, activeTapeIdx, selectedCategory = 'all') {
    const categoryFilter = document.getElementById('tape-category-filter');
    const tapeChoice = document.getElementById('tape-choice');
    if (!categoryFilter || !tapeChoice) return;

    const categories = [...new Set(tapes.map(tape => tape.category || 'Diğer'))]
      .sort((a, b) => a.localeCompare(b, 'tr'));
    categoryFilter.replaceChildren(new Option('Tüm kategoriler', 'all'));
    categories.forEach(category => categoryFilter.add(new Option(category, category)));
    categoryFilter.value = selectedCategory;

    const visibleTapes = tapes
      .map((tape, index) => ({ tape, index }))
      .filter(({ tape }) => selectedCategory === 'all' || (tape.category || 'Diğer') === selectedCategory);
    tapeChoice.replaceChildren(...visibleTapes.map(({ tape, index }) =>
      new Option(`${tape.label} (${tape.tracks?.length || 0} parça)`, String(index))
    ));
    tapeChoice.disabled = visibleTapes.length === 0;
    if (visibleTapes.length > 0) {
      tapeChoice.value = String(activeTapeIdx);
    }
  }

  /** HTML escape */
  _esc(str) {
    return str
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  get volume() { return this._volume; }
}

/* ═══════════════════════════════════════════════════════
   ANA UYGULAMA (App)
   Tüm modülleri birleştirir ve mod geçişlerini yönetir.
   ═══════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════
   ANA UYGULAMA (App)
   Tüm modülleri birleştirir ve mod geçişlerini yönetir.
   ═══════════════════════════════════════════════════════ */
class App {
  constructor() {
    this._stations  = [];
    this._tapes     = [];   // [{ id, label, color, tracks[] }]
    this._tapeIdx   = 0;    // aktif kaset (raf) indeksi
    this._trackIdx  = 0;    // aktif kaset içindeki parça indeksi
    this._tapeCategory = 'all';
    this._mode      = 'tape';
    this._radioIdx  = -1;
    this._errorTracks = new Set(); // "tapeIdx:trackIdx" string seti
    this._tapeIsPlaying = false;
    this._staticPlaying = false;
    this._metadataTimer = null;
    this._metadataController = null;
    this._metadataStationUrl = null;
    this._metadataRequestId = 0;
    this._stationHealth = new Map();
    this._stationHealthTimer = null;
    this._powered = true;
    this._resumeAfterPowerOn = null;
    this._audioEngine = new AudioEngine();
    this._tape = new TapeController(document.getElementById('sc-iframe'));
    this._radio   = null;
    this._spectrum = null;
    this._ui       = null;
  }

  get _activeTape()   { return this._tapes[this._tapeIdx] || null; }
  get _activeTracks() { return this._activeTape?.tracks || []; }
  get _activeTrack()  { return this._activeTracks[this._trackIdx] || null; }
  _errKey(ti, tri)    { return `${ti}:${tri}`; }

  async init() {
    const [stations, tapes] = await Promise.all([
      DataLoader.fetchStations(),
      DataLoader.fetchTapes()
    ]);
    this._stations = stations;
    this._tapes    = tapes;

    this._radio = new RadioController(this._audioEngine, stations);
    this._radio.onStationChange = (st, idx) => {
      this._radioIdx = idx;
      this._ui.updateRadioStatus(true, st);
      this._startNowPlaying(st);
      this._ui.renderStationList(stations, idx, true);
      this._ui.scrollStationIntoView(idx);
    };
    this._radio.onStateChange = (isOn) => {
      this._ui.updateRadioStatus(isOn, this._radio.currentStation);
      if (isOn && this._radio.currentStation) {
        this._startNowPlaying(this._radio.currentStation);
      } else {
        this._stopNowPlaying();
      }
    };

    const specContainer = document.getElementById('spectrum-bars');
    this._spectrum = new Spectrum(specContainer, this._audioEngine);
    this._ui = new UI(this);
    await this._refreshStationHealth();
    this._stationHealthTimer = setInterval(() => this._refreshStationHealth(), 60_000);
    this._ui.setPowerState(true, false);
    this._audioEngine.setVolume(this._ui.volume);
    this._tape.setVolume(this._ui.volume);

    this._tape.onPlay = () => {
      this._tapeIsPlaying = true;
      this._spectrum.setTapePlaying(true);
      this._ui.setPlayState(true);
      this._ui.updateTapeStatus(true, this._activeTrack);
    };
    this._tape.onPause = () => {
      this._tapeIsPlaying = false;
      this._spectrum.setTapePlaying(false);
      this._ui.setPlayState(false);
      this._ui.updateTapeStatus(false, this._activeTrack);
    };
    this._tape.onFinish = () => {
      this._tapeIsPlaying = false;
      this._spectrum.setTapePlaying(false);
      this._nextTrack();
    };
    this._tape.onProgress = ({ position, duration }) => {
      const track = this._activeTrack;
      if (track && duration > 0) {
        const wasNull = track._duration == null;
        track._duration = duration;
        if (wasNull) {
          this._ui.renderTrackList(this._activeTracks, this._trackIdx, this._errorTracks, this._tapeIdx);
        }
      }
      this._ui.updateTapeProgress(position, duration);
    };
    this._tape.onError = () => {
      showToast(`Parça yüklenemedi: ${this._activeTrack?.title || '?'}`);
      this._errorTracks.add(this._errKey(this._tapeIdx, this._trackIdx));
      this._ui.renderTrackList(this._activeTracks, this._trackIdx, this._errorTracks, this._tapeIdx);
      setTimeout(() => this._nextTrack(), 1500);
    };
    this._tape.onAutoplayBlocked = () => {
      showToast('Tarayıcı otomatik oynatmayı engelledi. Çal düğmesine dokunun.');
    };

    this._ui.renderStationList(stations, -1, false);
    this._ui.renderTapeSelectors(this._tapes, this._tapeIdx, this._tapeCategory);
    if (this._activeTape) {
      this._ui.renderTrackList(this._activeTracks, this._trackIdx, this._errorTracks, this._tapeIdx);
      this._ui.updateTapeStatus(false, this._activeTrack);
      this._tape.load(this._activeTrack?.soundcloudUrl, false);
    }
    this._ui._setVolumeDisplay(this._ui.volume);
    console.log('[App] Hazır. İstasyonlar:', stations.length, '| Kasetler:', tapes.length);
  }

  async _refreshStationHealth() {
    try {
      const result = await DataLoader.fetchStationHealth();
      this._stationHealth = new Map(result.stations.map(station => [station.streamUrl, station]));
      this._ui?.updateStationHealth();
    } catch (error) {
      console.warn('[App] İstasyon durumları güncellenemedi:', error.message);
    }
  }

  _startNowPlaying(station) {
    if (this._metadataStationUrl === station.streamUrl && this._metadataTimer) return;
    this._stopNowPlaying();
    this._metadataStationUrl = station.streamUrl;
    this._ui.updateNowPlaying(null);
    const requestId = this._metadataRequestId;
    const fetchMetadata = async () => {
      if (requestId !== this._metadataRequestId) return;
      const controller = new AbortController();
      this._metadataController = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`/api/now-playing?url=${encodeURIComponent(station.streamUrl)}`, {
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (requestId === this._metadataRequestId) {
          this._ui.updateNowPlaying(result.metadata);
        }
      } catch (err) {
        if (err.name !== 'AbortError' && requestId === this._metadataRequestId) {
          console.warn('[Radio] Şarkı bilgisi alınamadı:', err.message);
          this._ui.updateNowPlaying(null);
        }
      } finally {
        clearTimeout(timeout);
        if (this._metadataController === controller) this._metadataController = null;
      }
    };
    fetchMetadata();
    this._metadataTimer = setInterval(fetchMetadata, 20000);
  }

  _stopNowPlaying() {
    if (this._metadataTimer) clearInterval(this._metadataTimer);
    this._metadataTimer = null;
    this._metadataStationUrl = null;
    this._metadataRequestId++;
    this._metadataController?.abort();
    this._metadataController = null;
    this._ui?.updateNowPlaying(null);
  }

  async switchToRadio(index) {
    if (!this._powered) return;
    if (this._tapeIsPlaying) {
      this._tape.pause();
      this._tapeIsPlaying = false;
      this._spectrum.setTapePlaying(false);
      this._ui.updateTapeStatus(false);
      this._ui.setPlayState(false);
    }
    this._mode = 'radio';
    this._spectrum.setMode('radio');
    this._staticPlaying = false;
    await this._radio.selectStation(index);
    this._ui.setPlayState(true);
  }

  switchToTapeBySelector(tapeIdx) {
    this._selectTape(tapeIdx, 0, true);
  }

  switchToTape(trackIdx) {
    this._selectTape(this._tapeIdx, trackIdx, true);
  }

  setTapeCategory(category) {
    if (!this._powered) return;
    this._tapeCategory = category;
    const activeTape = this._activeTape;
    if (category !== 'all' && activeTape?.category !== category) {
      const nextTapeIdx = this._tapes.findIndex(tape => (tape.category || 'Diğer') === category);
      if (nextTapeIdx >= 0) {
        this._selectTape(nextTapeIdx, 0, false);
        return;
      }
    }
    this._ui.renderTapeSelectors(this._tapes, this._tapeIdx, this._tapeCategory);
  }

  _selectTape(tapeIdx, trackIdx, autoPlay) {
    if (!this._powered) return;
    if (this._mode === 'radio') {
      this._radio.stop();
      this._ui.updateRadioStatus(false);
      this._ui.setPlayState(false);
    }
    this._mode = 'tape';
    this._spectrum.setMode('tape');
    this._staticPlaying = false;

    const sameTrack = tapeIdx === this._tapeIdx && trackIdx === this._trackIdx;
    if (sameTrack && this._tapeIsPlaying) return;

    this._tapeIdx  = tapeIdx;
    this._trackIdx = trackIdx;

    const tape  = this._activeTape;
    const track = this._activeTrack;

    this._ui.renderTapeSelectors(this._tapes, tapeIdx, this._tapeCategory);
    this._ui.renderTrackList(tape?.tracks || [], trackIdx, this._errorTracks, tapeIdx);
    this._ui.scrollTrackIntoView(trackIdx);
    this._ui.updateTapeStatus(false, track);
    this._ui.resetTapeCounter();

    if (track) this._tape.load(track.soundcloudUrl, autoPlay);
  }

  playStatic() {
    if (!this._powered) return;
    if (this._staticPlaying) return;
    this._radio.stop();
    this._ui.updateRadioStatus(false);
    this._ui.setPlayState(false);
    this._staticPlaying = true;
  }

  togglePlay() {
    if (!this._powered) return;
    this._audioEngine.ensureContext();
    if (this._mode === 'radio') {
      if (this._radio.isOn) {
        this._radio.pause();
        this._ui.setPlayState(false);
      } else if (this._radioIdx >= 0) {
        this._radio.resume();
        this._ui.setPlayState(true);
      } else if (this._stations.length > 0) {
        this.switchToRadio(0);
      }
    } else {
      if (this._tapeIsPlaying) {
        this._tape.pause();
      } else {
        if (!this._activeTrack) return;
        this._tape.play();
        this._spectrum.setMode('tape');
      }
    }
  }

  stop() {
    if (!this._powered) return;
    if (this._mode === 'radio') {
      this._radio.stop();
      this._ui.updateRadioStatus(false);
    } else {
      this._tape.pause();
      this._tape.seek(0);
      this._tapeIsPlaying = false;
      this._spectrum.setTapePlaying(false);
      this._ui.updateTapeStatus(false, this._activeTrack);
      this._ui.resetTapeCounter();
    }
    this._ui.setPlayState(false);
  }

  togglePower() {
    if (this._powered) {
      this._resumeAfterPowerOn = {
        radio: this._mode === 'radio' && Boolean(this._radio?.isOn),
        tape: this._mode === 'tape' && this._tapeIsPlaying
      };
      if (this._radio?.isOn) this._radio.pause();
      if (this._tapeIsPlaying) this._tape.pause();
      this._tapeIsPlaying = false;
      this._staticPlaying = false;
      this._spectrum?.setTapePlaying(false);
      this._spectrum?.setPowered(false);
      this._ui?.setPlayState(false);
      this._powered = false;
      this._ui?.setPowerState(false);
      return;
    }

    this._powered = true;
    this._spectrum?.setPowered(true);
    this._ui?.setPowerState(true);
    const resume = this._resumeAfterPowerOn;
    this._resumeAfterPowerOn = null;
    if (resume?.radio) {
      this._radio.resume();
      this._ui.setPlayState(true);
    } else if (resume?.tape) {
      this._tape.play();
      this._spectrum.setTapePlaying(true);
    }
  }

  next() {
    if (!this._powered) return;
    if (this._mode === 'radio') this._radio.next(); else this._nextTrack();
  }
  prev() {
    if (!this._powered) return;
    if (this._mode === 'radio') this._radio.prev(); else this._prevTrack();
  }

  _nextTrack() {
    if (!this._powered) return;
    const tracks = this._activeTracks;
    if (!tracks.length) return;
    this._selectTape(this._tapeIdx, (this._trackIdx + 1) % tracks.length, true);
  }
  _prevTrack() {
    if (!this._powered) return;
    const tracks = this._activeTracks;
    if (!tracks.length) return;
    this._selectTape(this._tapeIdx, (this._trackIdx - 1 + tracks.length) % tracks.length, true);
  }

  seekTape(ratio) {
    if (this._mode !== 'tape') return;
    const dur = this._tape.getDuration();
    if (dur <= 0) return;
    this._tape.seek(ratio * dur);
  }
}

const ROOM_PICTURE_IMAGES = [
  'pexels-zeynep-sude-emek-193601188-36753970.jpg',
  'pexels-wal_-172619-2156618639-37738870.jpg',
  'pexels-theroshanbhatt-32419298.jpg',
  'pexels-steve-30784971.jpg',
  'pexels-sirokad-37818592.jpg',
  'pexels-sami-aksu-48867324-11254754.jpg',
  'pexels-recepcelikphoto-13672091.jpg',
  'pexels-nazar-aslan-443954785-33068045.jpg',
  'pexels-edward-jenner-4253054.jpg',
  'pexels-burakarli-39533353.jpg',
  'pexels-astar-537690801-26202179.jpg',
  'pexels-arnetx-34780375.jpg'
];

function setRandomRoomPictures() {
  const images = [...ROOM_PICTURE_IMAGES];
  for (let i = images.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [images[i], images[j]] = [images[j], images[i]];
  }
  const image = document.getElementById('wall-picture-right');
  if (!image || !images[0]) return;
  image.onerror = () => console.warn(`[Room decor] Tablo görseli yüklenemedi: /arkaplan/${images[0]}`);
  image.src = `/arkaplan/${images[0]}`;
}

setRandomRoomPictures();

const app = new App();
app.init().catch(err => {
  console.error('[App] Başlatılamadı:', err);
  showToast('Uygulama başlatılamadı: ' + err.message);
});
