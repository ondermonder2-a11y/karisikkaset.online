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
    this._timeData = null;
    this._channelAnalysers = null;
    this._channelTimeData = null;
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
    this._timeData = new Uint8Array(this._analyser.fftSize);
    this._gain.connect(this._analyser);
    this._analyser.connect(this._ctx.destination);

    const splitter = this._ctx.createChannelSplitter(2);
    const silentGain = this._ctx.createGain();
    silentGain.gain.value = 0;
    silentGain.connect(this._ctx.destination);
    this._channelAnalysers = [0, 1].map(() => {
      const analyser = this._ctx.createAnalyser();
      analyser.fftSize = 512;
      return analyser;
    });
    this._channelTimeData = this._channelAnalysers.map(analyser => new Uint8Array(analyser.fftSize));
    this._gain.connect(splitter);
    this._channelAnalysers.forEach((analyser, channel) => {
      splitter.connect(analyser, channel);
      analyser.connect(silentGain);
    });
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
    audio.addEventListener('error', () => {
      if (requestId === this._playRequestId && this._audio === audio) {
        showToast('Radyo yayını başlatılamadı. İstasyon bağlantısını kontrol edin.');
        console.error('[AudioEngine] Stream medya hatası:', audio.error?.message || audio.error?.code || 'Bilinmeyen hata');
        // Yayın düştüyse dinleyici sayacından da düş
        Heartbeat.stop();
      }
    }, { once: true });

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

  getWaveform() {
    if (!this._analyser || !this._timeData) return null;
    this._analyser.getByteTimeDomainData(this._timeData);
    return this._timeData;
  }

  getStereoLevels() {
    if (!this._channelAnalysers || !this._channelTimeData) return [0, 0];
    return this._channelAnalysers.map((analyser, channel) => {
      const samples = this._channelTimeData[channel];
      analyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) {
        const value = (sample - 128) / 128;
        sumSquares += value * value;
      }
      return Math.sqrt(sumSquares / samples.length);
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
      this._applyVolume('ready');
      if (this._pendingUrl) {
        this._loadAndPlay(this._pendingUrl, this._pendingPlay);
        this._pendingUrl = null;
        this._pendingPlay = false;
      }
      this.onReady?.();
    });
    this._widget.bind(SC.Widget.Events.PLAY, () => {
      this._isPlaying = true;
      this._applyVolume('play');
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
    // play() başladıktan sonra sesi uygula
    setTimeout(() => this._applyVolume('play-btn'), 200);
  }
  pause() { this._widget?.pause(); }

  /** Pozisyona git (saniye) */
  seek(seconds) {
    this._widget?.seekTo(Math.floor(seconds * 1000));
  }

  _applyVolume(stage) {
    if (!this._widget || !this._ready) return;
    const requested = this._volume;
    this._widget.setVolume(requested);
    if (typeof this._widget.getVolume !== 'function') {
      console.log(`[Tape volume] ${stage}: set ${requested}% (readback unavailable)`);
      return;
    }
    console.log(`[Tape volume] ${stage}: requested=${requested}%`);
    try {
      this._widget.getVolume(actual => {
        const value = Number(actual);
        if (!Number.isFinite(value)) {
          console.log(`[Tape volume] ${stage}: actual volume unavailable`);
          return;
        }
        const observed = Math.round(value);
        if (Math.abs(observed - requested) > 1) {
          console.warn(`[Tape volume] ${stage}: mismatch requested=${requested}% actual=${observed}%`);
        } else {
          console.log(`[Tape volume] ${stage}: actual=${observed}%`);
        }
      });
    } catch (error) {
      console.warn(`[Tape volume] ${stage}: readback failed`, error);
    }
  }

  setVolume(v) {
    // v: 0–1 arası → widget 0–100 arası ister
    this._volume = Math.round(v * 100);
    this._applyVolume('volume-change');
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
const SPECTRUM_STYLES = ['mirror', 'equalizer', 'wave', 'classic', 'led', 'mono', 'fire', 'vfd', 'vu', 'crt', 'matrix'];

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
    this._renderPhase = 0;
    this._vuTheme = localStorage.getItem('kk_vu_theme') === 'ice' ? 'ice' : 'warm';
    this._vuNeedles = [0, 0];
    this._wrap = containerEl.closest('.spectrum-wrap');
    this._vfdBands = Number(localStorage.getItem('kk_vfd_bands')) === 16 ? 16 : 24;
    this._crtColor = localStorage.getItem('kk_crt_color') === 'amber' ? 'amber' : 'green';
    this._matrixTheme = localStorage.getItem('kk_matrix_theme') === 'fire' ? 'fire' : 'cyber';
    this._peakLevels = Array(SPECTRUM_BARS).fill(0);
    this._peakTimes = Array(SPECTRUM_BARS).fill(0);
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
    this.setVuTheme(this._vuTheme);
    this.setVfdBands(this._vfdBands);
    this.setCrtColor(this._crtColor);
    this.setMatrixTheme(this._matrixTheme);
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

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'spectrum-canvas';
    this._canvas.setAttribute('aria-hidden', 'true');
    this._canvasContext = this._canvas.getContext('2d');
    this._container.appendChild(this._canvas);
  }

  setMode(mode) { this._mode = mode; }
  setTapePlaying(v) { this._tapeIsPlaying = v; }
  setPowered(powered) { this._powered = powered; }

  setVisualization(style) {
    if (!SPECTRUM_STYLES.includes(style)) return;
    this._visualization = style;
    this._container.dataset.visualization = style;
    this._wrap?.classList.toggle('is-vu-mode', style === 'vu');
    const isModuleMode = ['vfd', 'vu', 'crt', 'matrix'].includes(style);
    this._wrap?.classList.toggle('is-module-mode', isModuleMode);
    if (this._wrap) this._wrap.dataset.visualization = style;
    localStorage.setItem('kk_spectrum_style', style);
    document.querySelectorAll('[data-spectrum-style]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.spectrumStyle === style));
    });
  }

  setVuTheme(theme) {
    if (theme !== 'warm' && theme !== 'ice') return;
    this._vuTheme = theme;
    localStorage.setItem('kk_vu_theme', theme);
    document.querySelectorAll('[data-vu-theme]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.vuTheme === theme));
    });
  }

  setVfdBands(bands) {
    if (bands !== 16 && bands !== 24) return;
    this._vfdBands = bands;
    localStorage.setItem('kk_vfd_bands', String(bands));
    document.querySelectorAll('[data-vfd-bands]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.vfdBands) === bands));
    });
  }

  setCrtColor(color) {
    if (color !== 'green' && color !== 'amber') return;
    this._crtColor = color;
    localStorage.setItem('kk_crt_color', color);
    document.querySelectorAll('[data-crt-color]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.crtColor === color));
    });
  }

  setMatrixTheme(theme) {
    if (theme !== 'cyber' && theme !== 'fire') return;
    this._matrixTheme = theme;
    localStorage.setItem('kk_matrix_theme', theme);
    document.querySelectorAll('[data-matrix-theme]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.matrixTheme === theme));
    });
  }

  setVfdBands(bands) {
    if (bands !== 16 && bands !== 24) return;
    this._vfdBands = bands;
    localStorage.setItem('kk_vfd_bands', String(bands));
    document.querySelectorAll('[data-vfd-bands]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.vfdBands) === bands));
    });
  }

  setCrtColor(color) {
    if (color !== 'green' && color !== 'amber') return;
    this._crtColor = color;
    localStorage.setItem('kk_crt_color', color);
    document.querySelectorAll('[data-crt-color]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.crtColor === color));
    });
  }

  setMatrixTheme(theme) {
    if (theme !== 'cyber' && theme !== 'fire') return;
    this._matrixTheme = theme;
    localStorage.setItem('kk_matrix_theme', theme);
    document.querySelectorAll('[data-matrix-theme]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.matrixTheme === theme));
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

    const now = performance.now();
    levels.forEach((level, index) => {
      if (level >= this._peakLevels[index]) {
        this._peakLevels[index] = level;
        this._peakTimes[index] = now;
      } else if (now - this._peakTimes[index] > 650) {
        this._peakLevels[index] = Math.max(level, this._peakLevels[index] - 0.012);
      }
    });

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
    if (['vfd', 'vu', 'crt', 'matrix'].includes(this._visualization)) {
      this._renderCanvas(levels);
    }

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

  _renderCanvas(levels) {
    const rect = this._canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !this._canvasContext) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(rect.width * pixelRatio);
    const pixelHeight = Math.round(rect.height * pixelRatio);
    if (this._canvas.width !== pixelWidth || this._canvas.height !== pixelHeight) {
      this._canvas.width = pixelWidth;
      this._canvas.height = pixelHeight;
    }
    const ctx = this._canvasContext;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const width = rect.width;
    const height = rect.height;
    this._renderPhase += 0.045;
    if (this._visualization === 'vfd') this._drawVfd(ctx, width, height, levels);
    if (this._visualization === 'vu') this._drawVu(ctx, width, height, levels);
    if (this._visualization === 'crt') {
      this._drawCrt(ctx, width, height, levels, this._mode === 'radio' ? this._audio.getWaveform() : null);
    }
    if (this._visualization === 'matrix') this._drawMatrix(ctx, width, height, levels);
  }

  _drawVfd(ctx, width, height, levels) {
    ctx.fillStyle = '#05090c';
    ctx.fillRect(0, 0, width, height);
    const dbLabels = ['+6dB', '0dB', '-6dB', '-12dB', '-24dB'];
    ctx.strokeStyle = 'rgba(0, 255, 157, 0.08)';
    ctx.fillStyle = 'rgba(0, 255, 157, 0.55)';
    ctx.font = '7px monospace';
    for (let row = 0; row < dbLabels.length; row++) {
      const y = height * 0.12 + row * (height * 0.76 / 4);
      ctx.beginPath(); ctx.moveTo(31, y); ctx.lineTo(width - 5, y); ctx.stroke();
      ctx.fillText(dbLabels[row], 2, y + 2.5);
    }
    const segments = 18;
    const leftPad = 34;
    const rightPad = 5;
    const topPad = 6;
    const bottomPad = 5;
    const availableWidth = width - leftPad - rightPad;
    const availableHeight = height - topPad - bottomPad;
    const columnWidth = availableWidth / this._vfdBands;
    const barWidth = Math.max(2, columnWidth * 0.72);
    const segmentHeight = (availableHeight / segments) * 0.68;
    const segmentGap = (availableHeight / segments) * 0.32;
    for (let band = 0; band < this._vfdBands; band++) {
      const index = Math.floor((band / this._vfdBands) * 47);
      const value = levels[index] || 0;
      const activeSegments = Math.round(value * segments);
      const peakSegment = Math.min(segments - 1, Math.round((this._peakLevels[index] || 0) * segments));
      const x = leftPad + band * columnWidth + (columnWidth - barWidth) / 2;
      for (let segment = 0; segment < segments; segment++) {
        const y = height - bottomPad - (segment + 1) * (segmentHeight + segmentGap);
        const ratio = segment / segments;
        const color = ratio >= 0.8 ? '#ff2a55' : ratio >= 0.6 ? '#ffbe0b' : '#00f59b';
        const isLit = segment < activeSegments;
        const isPeak = segment === peakSegment && this._peakLevels[index] > 0.04;
        ctx.fillStyle = isLit || isPeak ? color : 'rgba(255,255,255,0.06)';
        ctx.shadowColor = isLit || isPeak ? color : 'transparent';
        ctx.shadowBlur = isPeak ? 5 : 2;
        ctx.fillRect(x, y, barWidth, segmentHeight);
      }
    }
    ctx.shadowBlur = 0;
  }

  _drawVu(ctx, width, height, levels) {
    ctx.fillStyle = '#090a0d';
    ctx.fillRect(0, 0, width, height);
    const gap = 8;
    const meterWidth = (width - gap * 3) / 2;
    const meterHeight = height - gap * 2;
    const measuredLevels = this._mode === 'radio'
      ? this._audio.getStereoLevels()
      : [0, 1].map(channel => {
        const slice = levels.filter((_, index) => index % 2 === channel);
        return Math.sqrt(slice.reduce((sum, item) => sum + item, 0) / Math.max(1, slice.length));
      });
    const targets = measuredLevels.map(level => Math.min(1.06, Math.pow(level, 0.7) * 1.4));
    this._vuNeedles = this._vuNeedles.map((current, index) => {
      const target = targets[index] || 0;
      return current + (target - current) * (target > current ? 0.42 : 0.14);
    });
    this._drawSingleVuMeter(ctx, gap, gap, meterWidth, meterHeight, this._vuNeedles[0], 'CH-L');
    this._drawSingleVuMeter(ctx, gap * 2 + meterWidth, gap, meterWidth, meterHeight, this._vuNeedles[1], 'CH-R');
  }

  _drawSingleVuMeter(ctx, x, y, width, height, needleValue, channelLabel) {
    const isWarm = this._vuTheme === 'warm';
    const gradient = ctx.createRadialGradient(x + width / 2, y + height * 0.85, 10, x + width / 2, y + height * 0.5, width * 0.75);
    if (isWarm) {
      gradient.addColorStop(0, '#ffdf9e');
      gradient.addColorStop(0.65, '#f4b446');
      gradient.addColorStop(1, '#9e5b14');
    } else {
      gradient.addColorStop(0, '#d8f3ff');
      gradient.addColorStop(0.65, '#68b5e8');
      gradient.addColorStop(1, '#1c4973');
    }

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 6);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0a0c0e';
    ctx.stroke();
    ctx.clip();

    const pivotX = x + width / 2;
    const pivotY = y + height * 1.18;
    const radius = height * 0.92;
    const startAngle = -Math.PI * 0.74;
    const endAngle = -Math.PI * 0.26;
    const zeroAngle = startAngle + (endAngle - startAngle) * 0.72;
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, radius, startAngle, zeroAngle);
    ctx.strokeStyle = '#18181b';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, radius, zeroAngle, endAngle);
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 4;
    ctx.stroke();

    const ticks = [
      { position: 0, label: '-20', red: false },
      { position: 0.22, label: '-10', red: false },
      { position: 0.4, label: '-7', red: false },
      { position: 0.56, label: '-3', red: false },
      { position: 0.72, label: '0', red: true },
      { position: 0.86, label: '+1', red: true },
      { position: 1, label: '+3', red: true }
    ];
    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.textAlign = 'center';
    ticks.forEach(tick => {
      const angle = startAngle + (endAngle - startAngle) * tick.position;
      const innerRadius = radius - 6;
      const outerRadius = radius + 6;
      const textRadius = radius + 15;
      ctx.beginPath();
      ctx.moveTo(pivotX + Math.cos(angle) * innerRadius, pivotY + Math.sin(angle) * innerRadius);
      ctx.lineTo(pivotX + Math.cos(angle) * outerRadius, pivotY + Math.sin(angle) * outerRadius);
      ctx.strokeStyle = tick.red ? '#dc2626' : '#18181b';
      ctx.lineWidth = tick.label === '0' ? 2.2 : 1.4;
      ctx.stroke();
      ctx.fillStyle = tick.red ? '#b91c1c' : '#18181b';
      ctx.fillText(tick.label, pivotX + Math.cos(angle) * textRadius, pivotY + Math.sin(angle) * textRadius);
    });

    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = 'rgba(24, 24, 27, 0.8)';
    ctx.fillText('VU', pivotX, y + height * 0.58);
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.fillStyle = 'rgba(24, 24, 27, 0.75)';
    ctx.fillText(channelLabel, x + 24, y + height - 10);

    const isPeak = needleValue > 0.78;
    ctx.beginPath();
    ctx.arc(x + width - 16, y + 16, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = isPeak ? '#ff1e42' : 'rgba(60, 20, 20, 0.45)';
    if (isPeak) { ctx.shadowColor = '#ff1e42'; ctx.shadowBlur = 10; }
    ctx.fill();
    ctx.shadowBlur = 0;

    const clampedNeedle = Math.max(0, Math.min(1.06, needleValue));
    const needleAngle = startAngle + (endAngle - startAngle) * clampedNeedle;
    const tipX = pivotX + Math.cos(needleAngle) * (radius + 9);
    const tipY = pivotY + Math.sin(needleAngle) * (radius + 9);
    ctx.beginPath();
    ctx.moveTo(pivotX + 3, pivotY + 3);
    ctx.lineTo(tipX + 3, tipY + 3);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pivotX, y + height, 18, Math.PI, 0);
    ctx.fillStyle = '#141619';
    ctx.fill();
    ctx.restore();
  }

  _drawCrt(ctx, width, height, levels, waveform) {
    const isGreen = this._crtColor === 'green';
    const background = isGreen ? '#031208' : '#140c03';
    const gridColor = isGreen ? 'rgba(51,255,102,0.14)' : 'rgba(255,176,32,0.14)';
    const beamColor = isGreen ? '#4dff88' : '#ffb833';
    const glowColor = isGreen ? 'rgba(51,255,102,0.85)' : 'rgba(255,176,32,0.85)';
    ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    for (let column = 1; column < 10; column++) {
      const x = width * column / 10;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let row = 1; row < 8; row++) {
      const y = height * row / 8;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    const centerY = height / 2;
    const centerX = width / 2;
    ctx.strokeStyle = isGreen ? 'rgba(51,255,102,0.35)' : 'rgba(255,176,32,0.35)';
    for (let x = 0; x < width; x += width / 50) {
      ctx.beginPath(); ctx.moveTo(x, centerY - 2); ctx.lineTo(x, centerY + 2); ctx.stroke();
    }
    for (let y = 0; y < height; y += height / 40) {
      ctx.beginPath(); ctx.moveTo(centerX - 2, y); ctx.lineTo(centerX + 2, y); ctx.stroke();
    }
    ctx.beginPath();
    const samples = Math.max(48, Math.floor(width));
    for (let index = 0; index <= samples; index++) {
      const x = (index / samples) * width;
      const dataIndex = waveform ? Math.floor((index / samples) * (waveform.length - 1)) : 0;
      const signal = waveform
        ? (waveform[dataIndex] - 128) / 128
        : Math.sin(index * 0.16 + this._renderPhase) * (0.25 + (levels[index % levels.length] || 0) * 0.62)
          + Math.sin(index * 0.047 - this._renderPhase * 0.7) * 0.12;
      const y = centerY - signal * height * 0.42;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.save();
    ctx.strokeStyle = glowColor; ctx.lineWidth = 4.5; ctx.shadowColor = glowColor; ctx.shadowBlur = 12; ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4; ctx.shadowBlur = 0; ctx.stroke();
    ctx.restore();
    const vignette = ctx.createRadialGradient(width / 2, height / 2, width * 0.25, width / 2, height / 2, width * 0.65);
    vignette.addColorStop(0, 'rgba(0,0,0,0)'); vignette.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height);
  }

  _drawMatrix(ctx, width, height, levels) {
    ctx.fillStyle = '#06070a'; ctx.fillRect(0, 0, width, height);
    const columns = 20; const rows = 12; const padX = 8; const padY = 5;
    const dotWidth = (width - padX * 2) / columns;
    const dotHeight = (height - padY * 2) / rows;
    const dotRadius = Math.max(1.5, Math.min(dotWidth, dotHeight) * 0.34);
    const isCyber = this._matrixTheme === 'cyber';
    for (let column = 0; column < columns; column++) {
      const index = Math.floor((column / columns) * 47);
      const value = levels[index] || 0;
      const litRows = Math.round(value * rows);
      for (let row = 0; row < rows; row++) {
        const lit = row >= rows - litRows;
        const peakRow = rows - 1 - Math.round((this._peakLevels[index] || 0) * (rows - 1));
        const isPeak = row === peakRow && this._peakLevels[index] > 0.04;
        const x = padX + column * dotWidth + dotWidth / 2;
        const y = height - padY - row * dotHeight - dotHeight / 2;
        const activeColor = isPeak ? '#f8fafc' : isCyber
          ? (row > 9 ? '#a5f3fc' : '#22d3ee')
          : (row > 9 ? '#fef08a' : row > 5 ? '#fb923c' : '#ef4444');
        ctx.fillStyle = lit || isPeak ? activeColor : (isCyber ? 'rgba(30,58,138,0.32)' : 'rgba(127,29,29,0.32)');
        ctx.shadowColor = lit || isPeak ? activeColor : 'transparent'; ctx.shadowBlur = lit || isPeak ? 4 : 0;
        ctx.beginPath();
        ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.shadowBlur = 0;
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
    this._tapeDisplayActive = false;

    // Knob drag durumları
    this._tuningDrag = null;
    this._volumeDrag = null;
    this._signalTimer = null;
    this._counterDrums = {
      m1: document.getElementById('drum-m1'),
      m2: document.getElementById('drum-m2'),
      s1: document.getElementById('drum-s1'),
      s2: document.getElementById('drum-s2')
    };
    this._counterPreviousDigits = null;
    this._counterRollTimers = new Map();
    this._buildTapeCounter();
    this._buildProgressPixels();

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
    this._bindCassetteShelf();
    this._bindCassetteCreator();
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
    document.querySelector('.vu-meter-themes')?.addEventListener('click', event => {
      const button = event.target.closest('[data-vu-theme]');
      if (button) this._app._spectrum.setVuTheme(button.dataset.vuTheme);
    });
    document.querySelector('.vfd-band-controls')?.addEventListener('click', event => {
      const button = event.target.closest('[data-vfd-bands]');
      if (button) this._app._spectrum.setVfdBands(Number(button.dataset.vfdBands));
    });
    document.querySelector('.crt-color-controls')?.addEventListener('click', event => {
      const button = event.target.closest('[data-crt-color]');
      if (button) this._app._spectrum.setCrtColor(button.dataset.crtColor);
    });
    document.querySelector('.matrix-theme-controls')?.addEventListener('click', event => {
      const button = event.target.closest('[data-matrix-theme]');
      if (button) this._app._spectrum.setMatrixTheme(button.dataset.matrixTheme);
    });
    document.getElementById('speaker-light-toggle')?.addEventListener('click', () => {
      this._app._spectrum.toggleSpeakerLightMode();
    });
    // Ses seviyesini uygula
    this._setVolumeDisplay(this._volume);
    this._updateFMDisplay();
    this._updateTuningKnob();
    this._updateSpectrumTrack('FM Stereo');
    const frequencyDisplay = document.getElementById('radio-freq');
    if (frequencyDisplay && 'ResizeObserver' in window) {
      this._frequencyResizeObserver = new ResizeObserver(() => this._renderDigitalFrequency(this._tapeDisplayActive ? 'TAPE' : this._currentFreq));
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

  _bindCassetteCreator() {
    const dialog = document.getElementById('cassette-builder-dialog');
    const openButtons = Array.from(document.querySelectorAll('[data-open-cassette-builder]'));
    const hideRobotButtons = Array.from(document.querySelectorAll('[data-hide-cassette-robot]'));
    const showRobotButtons = Array.from(document.querySelectorAll('[data-show-cassette-robot]'));
    const closeButton = document.getElementById('close-cassette-builder');
    const createForm = document.getElementById('custom-cassette-form');
    const lookupForm = document.getElementById('custom-cassette-lookup-form');
    const builderTitle = document.getElementById('cassette-builder-title');
    const labelInput = document.getElementById('custom-cassette-label');
    const colorInput = document.getElementById('custom-cassette-color');
    const createEmailInput = document.getElementById('custom-cassette-email');
    const lookupEmailInput = document.getElementById('custom-cassette-lookup-email');
    const search = document.getElementById('custom-cassette-search');
    const trackOptions = document.getElementById('custom-cassette-track-options');
    const radioSearch = document.getElementById('custom-cassette-radio-search');
    const radioCountry = document.getElementById('custom-cassette-radio-country');
    const radioSearchButton = document.getElementById('custom-cassette-radio-search-button');
    const radioStatus = document.getElementById('custom-cassette-radio-status');
    const radioResults = document.getElementById('custom-cassette-radio-results');
    const selectionCount = document.getElementById('custom-cassette-selection-count');
    const saveButton = document.getElementById('custom-cassette-save');
    const createStatus = document.getElementById('custom-cassette-create-status');
    const lookupStatus = document.getElementById('custom-cassette-lookup-status');
    const savedList = document.getElementById('custom-cassette-saved-list');
    const createPanel = document.getElementById('cassette-create-panel');
    const retrievePanel = document.getElementById('cassette-retrieve-panel');
    const tabButtons = Array.from(document.querySelectorAll('[data-cassette-view]'));
    const robotHiddenKey = 'karisikKasetRobotHidden';
    let robotStartsHidden = false;
    try {
      robotStartsHidden = window.localStorage.getItem(robotHiddenKey) === '1';
    } catch { /* Yerel depolama kapalıysa robot varsayılan olarak görünür kalır. */ }
    document.body.classList.toggle('cassette-robot-is-hidden', robotStartsHidden);
    const setRobotHidden = hidden => {
      document.body.classList.toggle('cassette-robot-is-hidden', hidden);
      try {
        window.localStorage.setItem(robotHiddenKey, hidden ? '1' : '0');
      } catch { /* Depolama kapalı olsa da bu oturumdaki görünüm güncellenir. */ }
    };
    hideRobotButtons.forEach(button => button.addEventListener('click', () => {
      setRobotHidden(true);
      showToast('Robot gizlendi. Kaset simgesine dokunarak yeniden gösterebilirsin.');
    }));
    showRobotButtons.forEach(button => button.addEventListener('click', () => {
      setRobotHidden(false);
      showToast('Kaset robotu yeniden gösterildi.');
    }));
    if (!dialog || !openButtons.length || !closeButton || !createForm || !lookupForm || !search || !trackOptions) return;

    const MAX_TRACKS = 20;
    const selectedUrls = new Set();
    const selectedRadioStations = new Map();
    let catalog = [];
    let radioCatalog = [];
    let editingTapeId = null;

    const setStatus = (element, message, isError = false) => {
      if (!element) return;
      element.textContent = message;
      element.classList.toggle('is-error', isError);
    };

    const setView = view => {
      const showCreate = view === 'create';
      if (createPanel) createPanel.hidden = !showCreate;
      if (retrievePanel) retrievePanel.hidden = showCreate;
      tabButtons.forEach(button => {
        const active = button.dataset.cassetteView === view;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
    };

    const setEditMode = tape => {
      editingTapeId = tape?.id || null;
      if (builderTitle) builderTitle.textContent = editingTapeId ? 'Kasetini düzenle' : 'Kendi kasetini hazırla';
      if (saveButton) saveButton.textContent = editingTapeId ? 'Değişiklikleri kaydet' : 'Kaseti oluştur ve rafa ekle';
    };

    const updateSelection = () => {
      const totalSelected = selectedUrls.size + selectedRadioStations.size;
      if (selectionCount) selectionCount.textContent = `${totalSelected} / ${MAX_TRACKS} parça`;
      if (saveButton) saveButton.disabled = totalSelected < 1 || totalSelected > MAX_TRACKS;
    };

    const buildCatalog = () => {
      const uniqueTracks = new Map();
      (this._app._tapes || []).filter(tape => !tape.isCustom).forEach(tape => {
        (tape.tracks || []).forEach(track => {
          if (!track.soundcloudUrl || uniqueTracks.has(track.soundcloudUrl)) return;
          uniqueTracks.set(track.soundcloudUrl, {
            title: track.title || 'İsimsiz parça',
            subtitle: track.subtitle || '',
            soundcloudUrl: track.soundcloudUrl,
            tapeLabel: tape.label || 'Kaset koleksiyonu',
          });
        });
      });
      catalog = [...uniqueTracks.values()].sort((left, right) =>
        left.title.localeCompare(right.title, 'tr', { sensitivity: 'base' })
      );
    };

    const renderTracks = () => {
      const query = search.value.trim().toLocaleLowerCase('tr');
      const matches = catalog.filter(track =>
        `${track.title} ${track.subtitle} ${track.tapeLabel}`.toLocaleLowerCase('tr').includes(query)
      );
      trackOptions.replaceChildren();
      if (!matches.length) {
        const empty = document.createElement('p');
        empty.className = 'cassette-track-empty';
        empty.textContent = catalog.length ? 'Bu aramayla eşleşen parça bulunamadı.' : 'Şarkı listesi yüklenemedi.';
        trackOptions.appendChild(empty);
      } else {
        matches.forEach(track => {
          const option = document.createElement('label');
          option.className = 'cassette-track-option';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = track.soundcloudUrl;
          checkbox.checked = selectedUrls.has(track.soundcloudUrl);
          checkbox.disabled = !checkbox.checked && selectedUrls.size >= MAX_TRACKS;
          const details = document.createElement('span');
          details.className = 'cassette-track-option-info';
          const title = document.createElement('span');
          title.className = 'cassette-track-option-title';
          title.textContent = track.title;
          const artist = document.createElement('span');
          artist.className = 'cassette-track-option-artist';
          artist.textContent = track.subtitle || track.tapeLabel;
          details.append(title, artist);
          option.append(checkbox, details);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedUrls.add(track.soundcloudUrl);
            else selectedUrls.delete(track.soundcloudUrl);
            updateSelection();
            renderTracks();
            renderRadioStations();
          });
          trackOptions.appendChild(option);
        });
      }
      updateSelection();
    };

    const renderRadioStations = () => {
      if (!radioResults) return;
      radioResults.replaceChildren();
      radioCatalog.forEach(station => {
        const key = station.streamUrl;
        const option = document.createElement('label');
        option.className = 'cassette-track-option';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedRadioStations.has(key);
        checkbox.disabled = !checkbox.checked && selectedUrls.size + selectedRadioStations.size >= MAX_TRACKS;
        const details = document.createElement('span');
        details.className = 'cassette-track-option-info';
        const title = document.createElement('span');
        title.className = 'cassette-track-option-title';
        title.textContent = station.name || 'İsimsiz radyo';
        const subtitle = document.createElement('span');
        subtitle.className = 'cassette-track-option-artist';
        subtitle.textContent = `${station.genre || 'Radyo'} · ${station._frequency?.toFixed(1) || 'otomatik'} MHz`;
        details.append(title, subtitle);
        option.append(checkbox, details);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedRadioStations.set(key, station);
          else selectedRadioStations.delete(key);
          updateSelection();
          renderTracks();
          renderRadioStations();
        });
        radioResults.appendChild(option);
      });
      updateSelection();
    };

    const searchRadioStations = async () => {
      const query = radioSearch?.value.trim() || '';
      const country = radioCountry?.value.trim().toUpperCase() || '';
      if (!query && !country) {
        setStatus(radioStatus, 'İstasyon adı veya ülke kodu gir.', true);
        return;
      }
      radioSearchButton.disabled = true;
      setStatus(radioStatus, 'Radyo istasyonları aranıyor…');
      try {
        const params = new URLSearchParams({ limit: '30' });
        if (query) params.set('q', query);
        if (country) params.set('country', country);
        const response = await fetch(`/api/admin/search-radio?${params}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        radioCatalog = (result.stations || []).map((station, index) => ({
          ...station,
          _frequency: Number.isFinite(Number(station.frequency)) ? Number(station.frequency) : 88 + index / 10,
        }));
        setStatus(radioStatus, radioCatalog.length ? `${radioCatalog.length} istasyon bulundu.` : 'İstasyon bulunamadı.');
        renderRadioStations();
      } catch (error) {
        setStatus(radioStatus, `Radyo araması başarısız: ${error.message}`, true);
      } finally {
        radioSearchButton.disabled = false;
      }
    };

    const renderSavedCassettes = cassettes => {
      savedList.replaceChildren();
      cassettes.forEach(tape => {
        const card = document.createElement('article');
        card.className = 'cassette-saved-card';
        const details = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = tape.label;
        const meta = document.createElement('p');
        meta.textContent = `${tape.tracks.length} parça · Kişisel kaset`;
        details.append(title, meta);
        const useButton = document.createElement('button');
        useButton.type = 'button';
        useButton.className = 'cassette-saved-use';
        useButton.textContent = 'Rafa ekle ve dinle';
        useButton.addEventListener('click', () => {
          const tapeIndex = this._app._tapes.findIndex(item => item.id === tape.id);
          if (tapeIndex < 0) return;
          dialog.close();
          this._app.switchToTapeBySelector(tapeIndex);
        });
        const actions = document.createElement('div');
        actions.className = 'cassette-saved-actions';
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'cassette-saved-edit';
        editButton.textContent = 'Düzenle';
        editButton.addEventListener('click', () => {
          createForm.reset();
          selectedUrls.clear();
          selectedRadioStations.clear();
          buildCatalog();
          const knownUrls = new Set(catalog.map(track => track.soundcloudUrl));
          (tape.tracks || []).forEach(track => {
            if (track.type === 'radio' && track.streamUrl) {
              const station = { name: track.title, genre: track.subtitle, streamUrl: track.streamUrl, _frequency: Number(track.frequency) || 88 };
              selectedRadioStations.set(track.streamUrl, station);
              if (!radioCatalog.some(item => item.streamUrl === track.streamUrl)) radioCatalog.push(station);
              return;
            }
            if (!track.soundcloudUrl) return;
            selectedUrls.add(track.soundcloudUrl);
            if (!knownUrls.has(track.soundcloudUrl)) {
              catalog.push({
                title: track.title || 'İsimsiz parça',
                subtitle: track.subtitle || '',
                soundcloudUrl: track.soundcloudUrl,
                tapeLabel: `${tape.label} · mevcut parça`,
              });
            }
          });
          if (labelInput) labelInput.value = tape.label || '';
          if (colorInput) colorInput.value = tape.color || '#d59333';
          if (createEmailInput) createEmailInput.value = lookupEmailInput?.value.trim() || '';
          search.value = '';
          setEditMode(tape);
          renderTracks();
          renderRadioStations();
          setView('create');
          setStatus(createStatus, 'Kaset bilgilerini veya parça listesini düzenleyebilirsin.');
          setStatus(lookupStatus, '');
        });
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'cassette-saved-delete';
        deleteButton.textContent = 'Sil';
        deleteButton.addEventListener('click', async () => {
          const email = lookupEmailInput?.value.trim() || '';
          if (!email) {
            setStatus(lookupStatus, 'Kaseti silmek için önce e-posta adresinle kasetlerini bul.', true);
            return;
          }
          if (!window.confirm(`“${tape.label}” kasetini kalıcı olarak silmek istiyor musun?`)) return;
          deleteButton.disabled = true;
          setStatus(lookupStatus, 'Kaset siliniyor…');
          try {
            const response = await fetch(`/api/custom-cassettes/${encodeURIComponent(tape.id)}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ email }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
            const remaining = this._app._tapes.filter(item => item.isCustom && item.id !== tape.id);
            this._app.setCustomCassettes(remaining);
            renderSavedCassettes(remaining);
            setStatus(lookupStatus, 'Kaset silindi.');
            showToast('Kişisel kaset silindi.');
          } catch (error) {
            setStatus(lookupStatus, `Kaset silinemedi: ${error.message}`, true);
            deleteButton.disabled = false;
          }
        });
        actions.append(useButton, editButton, deleteButton);
        card.append(details, actions);
        savedList.appendChild(card);
      });
    };

    openButtons.forEach(button => button.addEventListener('click', () => {
      createForm.reset();
      selectedUrls.clear();
      selectedRadioStations.clear();
      radioCatalog = [];
      radioResults?.replaceChildren();
      setStatus(radioStatus, '');
      search.value = '';
      setEditMode(null);
      buildCatalog();
      renderTracks();
      renderRadioStations();
      setView('create');
      setStatus(createStatus, '');
      setStatus(lookupStatus, '');
      if (!dialog.open) dialog.showModal();
    }));
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
    tabButtons.forEach(button => button.addEventListener('click', () => setView(button.dataset.cassetteView)));
    search.addEventListener('input', renderTracks);
    radioSearchButton?.addEventListener('click', searchRadioStations);
    radioSearch?.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); searchRadioStations(); }
    });

    createForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!createForm.reportValidity()) return;
      if (!selectedUrls.size && !selectedRadioStations.size) {
        setStatus(createStatus, 'Kasete eklemek için en az bir şarkı veya radyo kanalı seç.', true);
        return;
      }
      const isEditing = Boolean(editingTapeId);
      const submitButton = saveButton || createForm.querySelector('[type="submit"]');
      submitButton.disabled = true;
      setStatus(createStatus, isEditing ? 'Değişiklikler kaydediliyor…' : 'Kaset hazırlanıyor…');
      const payload = {
        label: document.getElementById('custom-cassette-label')?.value.trim() || '',
        color: document.getElementById('custom-cassette-color')?.value || '#d59333',
        email: document.getElementById('custom-cassette-email')?.value.trim() || '',
        trackUrls: [...selectedUrls],
        radioStations: [...selectedRadioStations.values()].map(station => ({
          name: station.name,
          genre: station.genre,
          streamUrl: station.streamUrl,
          frequency: station._frequency,
        })),
      };
      try {
        const endpoint = isEditing
          ? `/api/custom-cassettes/${encodeURIComponent(editingTapeId)}`
          : '/api/custom-cassettes';
        const response = await fetch(endpoint, {
          method: isEditing ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        if (isEditing) {
          const otherLoadedTapes = this._app._tapes.filter(item => item.isCustom && item.id !== result.tape.id);
          this._app.setCustomCassettes([...otherLoadedTapes, result.tape], result.tape.id, false);
        } else {
          this._app.setCustomCassettes([result.tape], result.tape.id, false);
        }
        createForm.reset();
        selectedUrls.clear();
        selectedRadioStations.clear();
        radioCatalog = [];
        radioResults?.replaceChildren();
        setStatus(radioStatus, '');
        setEditMode(null);
        renderTracks();
        dialog.close();
        showToast(isEditing ? 'Kaset güncellendi.' : 'Kasetin rafa eklendi. Dinlemek için PLAY düğmesine bas.');
      } catch (error) {
        setStatus(createStatus, `${isEditing ? 'Kaset güncellenemedi' : 'Kaset oluşturulamadı'}: ${error.message}`, true);
      } finally {
        submitButton.disabled = selectedUrls.size + selectedRadioStations.size === 0;
      }
    });

    lookupForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!lookupForm.reportValidity()) return;
      const submitButton = lookupForm.querySelector('[type="submit"]');
      submitButton.disabled = true;
      savedList.replaceChildren();
      setStatus(lookupStatus, 'Kasetlerin aranıyor…');
      try {
        const email = document.getElementById('custom-cassette-lookup-email')?.value.trim() || '';
        const response = await fetch('/api/custom-cassettes/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        const cassettes = Array.isArray(result.cassettes) ? result.cassettes : [];
        this._app.setCustomCassettes(cassettes);
        renderSavedCassettes(cassettes);
        setStatus(lookupStatus, cassettes.length
          ? `${cassettes.length} kaset bulundu. Dinlemek istediğini seç.`
          : 'Bu e-posta adresiyle eşleşen kaset bulunamadı.', !cassettes.length);
      } catch (error) {
        setStatus(lookupStatus, `Kasetler getirilemedi: ${error.message}`, true);
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

  _bindCassetteShelf() {
    const shelf = document.querySelector('.cassette-rack-svg');
    if (!shelf) return;
    const selectCassette = cassette => {
      if (cassette.getAttribute('aria-disabled') === 'true') return;
      const tapeIndex = this._app._tapes.findIndex(tape => tape.id === cassette.dataset.tape);
      if (tapeIndex >= 0) this._app.switchToTapeBySelector(tapeIndex);
    };
    shelf.addEventListener('click', event => {
      const cassette = event.target.closest('.svg-tape');
      if (cassette) selectCassette(cassette);
    });
    shelf.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const cassette = event.target.closest('.svg-tape');
      if (!cassette) return;
      event.preventDefault();
      selectCassette(cassette);
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
        const customStatus = station.isCustom && !health;
        healthBadge.className = `station-health-badge ${health?.healthy === true ? 'is-online' : health?.healthy === false ? 'is-offline' : ''}`;
        healthBadge.textContent = health?.healthy === true ? 'ONLINE' : health?.healthy === false ? 'OFFLINE' : customStatus ? 'KİŞİSEL' : 'TEST';
        healthBadge.title = health?.message || (customStatus ? 'Kişisel kaset kanalına bağlı istasyon.' : 'İstasyon bağlantı kontrolü bekleniyor.');
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
      document.querySelectorAll('[data-mirror-switch="fullscreen-switch"]').forEach(mirror => {
        mirror.textContent = isFullscreen ? 'Tam ekrandan çık' : 'Tam ekran';
        mirror.setAttribute('aria-label', label);
      });
    });

    powerButton?.addEventListener('click', () => this._app.togglePower());

    /* Duvar anahtarı dar ekranlarda gizlendiği için aynı işlevler
       alt bilgi çubuğundaki kısayol düğmelerinden tetiklenir. */
    document.querySelectorAll('[data-mirror-switch]').forEach(mirror => {
      const target = document.getElementById(mirror.dataset.mirrorSwitch);
      if (!target) return;
      mirror.addEventListener('click', () => {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
    });
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
    this._renderDigitalFrequency(this._tapeDisplayActive ? 'TAPE' : freq);

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
    const seconds = now.getSeconds();
    const minutes = now.getMinutes();
    const hours = now.getHours() % 12;
    document.querySelector('.wall-clock-hour')?.style.setProperty('transform', `rotate(${hours * 30 + minutes * 0.5}deg)`);
    document.querySelector('.wall-clock-minute')?.style.setProperty('transform', `rotate(${minutes * 6 + seconds * 0.1}deg)`);
    document.querySelector('.wall-clock-second')?.style.setProperty('transform', `rotate(${seconds * 6}deg)`);
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
    document.querySelectorAll('[data-mirror-switch="player-power-switch"]').forEach(mirror => {
      mirror.textContent = powered ? 'Güç' : 'Güç aç';
      mirror.setAttribute('aria-label', powered ? 'Player elektriğini kes' : 'Player elektriğini aç');
    });
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
      '9': 'abfgcd',
      A: 'abcefg',
      E: 'adefg',
      P: 'abefg',
      T: 'defg'
    };
    const isText = typeof freq === 'string';
    const value = isText ? freq : freq.toFixed(1);
    display.replaceChildren();
    display.setAttribute('aria-label', isText ? value : `${value} MHz`);
    if (!isText) {
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
    }
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
    this._tapeDisplayActive = isPlaying;
    const deckBrandMode = document.getElementById('deck-brand-mode');
    if (deckBrandMode) deckBrandMode.textContent = isPlaying ? 'TAPE' : 'STEREO FM RADIO';
    this._renderDigitalFrequency(isPlaying ? 'TAPE' : this._currentFreq);
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
  _buildTapeCounter() {
    Object.values(this._counterDrums).forEach(strip => {
      if (!strip) return;
      strip.replaceChildren();
      for (let digit = 0; digit <= 10; digit++) {
        const drumDigit = document.createElement('span');
        drumDigit.className = 'drum-digit';
        drumDigit.textContent = String(digit % 10);
        strip.appendChild(drumDigit);
      }
    });
    this._setTapeCounter(0, true);
  }

  _buildProgressPixels() {
    const track = document.getElementById('progress-pixels');
    if (!track) return;
    track.replaceChildren();
    for (let index = 0; index < 32; index++) {
      const pixel = document.createElement('span');
      pixel.className = 'progress-pixel';
      track.appendChild(pixel);
    }
  }

  _setTapeCounter(seconds, instant = false) {
    const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(totalSeconds / 60) % 100;
    const remainder = totalSeconds % 60;
    const digits = {
      m1: Math.floor(minutes / 10),
      m2: minutes % 10,
      s1: Math.floor(remainder / 10),
      s2: remainder % 10
    };

    Object.entries(digits).forEach(([key, digit]) => {
      const strip = this._counterDrums[key];
      if (!strip) return;
      const resetTimer = this._counterRollTimers.get(key);
      if (resetTimer) clearTimeout(resetTimer);
      const previousDigit = this._counterPreviousDigits?.[key];
      if (instant || previousDigit == null) {
        strip.style.transition = 'none';
        strip.style.transform = `translateY(-${digit * 38}px)`;
      } else {
        strip.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
        if (previousDigit === 9 && digit === 0) {
          strip.style.transform = 'translateY(-380px)';
          this._counterRollTimers.set(key, setTimeout(() => {
            strip.style.transition = 'none';
            strip.style.transform = 'translateY(0px)';
            this._counterRollTimers.delete(key);
          }, 360));
        } else {
          strip.style.transform = `translateY(-${digit * 38}px)`;
        }
      }
    });
    this._counterPreviousDigits = digits;
  }

  updateTapeProgress(position, duration) {
    this._setTapeCounter(position);
    const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
    const pixels = document.querySelectorAll('.progress-pixel');
    const litPixels = Math.round((percent / 100) * pixels.length);
    pixels.forEach((pixel, index) => pixel.classList.toggle('is-lit', index < litPixels));

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
    this._setTapeCounter(0, true);
    document.querySelectorAll('.progress-pixel').forEach(pixel => pixel.classList.remove('is-lit'));
    const remEl = document.getElementById('progress-remaining');
    if (remEl) remEl.textContent = '-00:00';
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = '0%';
  }

  /* ─── Play/Pause/Stop düğmeleri ─── */
  setPlayState(isPlaying) {
    const btn  = document.getElementById('btn-play');
    const btnStop = document.getElementById('btn-stop');

    btn?.classList.toggle('is-latched', isPlaying);
    if (isPlaying) {
      btn?.setAttribute('aria-pressed', 'true');
      btnStop?.setAttribute('aria-pressed', 'false');
    } else {
      btn?.setAttribute('aria-pressed', 'false');
      btnStop?.setAttribute('aria-pressed', 'false');
    }
  }

  /* ─── Transport butonları ─── */
  _bindTransport() {
    const actions = [
      ['btn-prev', () => this._app.prev()],
      ['btn-stop', () => this._app.stop()],
      ['btn-play', () => this._app.togglePlay()],
      ['btn-next', () => this._app.next()]
    ];
    actions.forEach(([id, action]) => {
      const button = document.getElementById(id);
      if (!button) return;
      button.addEventListener('click', action);
      button.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        action();
      });
    });
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
      const statusText = health?.healthy === true ? 'Çevrimiçi' : health?.healthy === false ? 'Çevrimdışı' : s.isCustom ? 'Kişisel kanal' : 'Bağlantı kontrol ediliyor';
      btn.classList.toggle('is-offline', health?.healthy === false);
      btn.setAttribute('aria-label', `${s.frequency.toFixed(1)} MHz – ${s.name}${s.genre ? ` - ${s.genre}` : ''} - ${statusText}`);

      btn.innerHTML = `
        <span class="station-freq">${s.frequency.toFixed(1)}</span>
        <span class="station-info">
          <span class="station-info-name">${this._esc(s.name || '')}</span>
          ${s.genre ? `<span class="station-info-separator" aria-hidden="true">-</span><span class="station-info-genre">${this._esc(s.genre)}</span>` : ''}
        </span>
        <span class="station-health-badge ${health?.healthy === true ? 'is-online' : health?.healthy === false ? 'is-offline' : ''}" title="${this._esc(health?.message || (s.isCustom ? 'Kişisel kaset kanalına bağlı istasyon.' : 'İstasyon bağlantı kontrolü bekleniyor.'))}">${health?.healthy === true ? 'ONLINE' : health?.healthy === false ? 'OFFLINE' : s.isCustom ? 'KİŞİSEL' : 'TEST'}</span>
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
      const statusText = health?.healthy === true ? 'Çevrimiçi' : health?.healthy === false ? 'Çevrimdışı' : station.isCustom ? 'Kişisel kanal' : 'Bağlantı kontrol ediliyor';
      button.classList.toggle('is-offline', health?.healthy === false);
      button.setAttribute('aria-label', `${station.frequency.toFixed(1)} MHz – ${station.name}${station.genre ? ` - ${station.genre}` : ''} - ${statusText}`);
      if (badge) {
        badge.textContent = health?.healthy === true ? 'ONLINE' : health?.healthy === false ? 'OFFLINE' : station.isCustom ? 'KİŞİSEL' : 'TEST';
        badge.title = health?.message || (station.isCustom ? 'Kişisel kaset kanalına bağlı istasyon.' : 'İstasyon bağlantı kontrolü bekleniyor.');
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

  renderCassetteShelf(tapes, activeTapeIdx) {
    const activeTape = tapes[activeTapeIdx];
    const cassetteName = document.getElementById('cassette-set-name');
    if (cassetteName) cassetteName.textContent = activeTape?.label || 'Kaset seç';

    const svg = document.querySelector('.cassette-rack-svg');
    if (!svg) return;

    const MAX_SHELF_TAPES = 12;
    const allEntries = tapes.map((tape, tapeIndex) => ({ tape, tapeIndex }));
    const shelfTapes = [
      ...allEntries.filter(entry => entry.tape?.isCustom),
      ...allEntries.filter(entry => !entry.tape?.isCustom),
    ].slice(0, MAX_SHELF_TAPES);
    const cassetteColors = ['#8ab097','#c4515c','#467599','#814785','#d4a04a','#637368','#4a7c59','#9b4a6e'];
    const fallbackTextColors = ['#1d2d24','#fff5f5','#f0f7ff','#fdf4ff','#1a120b','#f1f5f2','#f0fff4','#fff0f7'];
    const getCassetteColors = (tape, tapeIndex) => {
      const color = /^#[0-9a-f]{6}$/i.test(tape.color || '')
        ? tape.color
        : cassetteColors[tapeIndex % cassetteColors.length];
      if (!/^#[0-9a-f]{6}$/i.test(tape.color || '')) {
        return { color, labelColor: fallbackTextColors[tapeIndex % fallbackTextColors.length] };
      }
      const channels = color.slice(1).match(/.{2}/g).map(channel => parseInt(channel, 16));
      const brightness = channels[0] * 0.299 + channels[1] * 0.587 + channels[2] * 0.114;
      return { color, labelColor: brightness > 150 ? '#1a120b' : '#fff5f5' };
    };
    svg.setAttribute('viewBox', '0 0 340 165');

    const rackSlots = Array.from(svg.querySelectorAll('.svg-tape'));
    const usedTapeIds = new Set();
    const slotAssignments = rackSlots.map((_, slotIndex) => shelfTapes[slotIndex] || null);

    rackSlots.forEach((cassette, slotIndex) => {
      const assignment = slotAssignments[slotIndex];
      const tape = assignment?.tape || null;
      const tapeIndex = assignment?.tapeIndex ?? -1;
      const label = cassette.querySelector('.svg-tape-label');
      cassette.dataset.tape = tape?.id || '';
      if (label) {
        label.textContent = tape ? (tape.label.length > 22 ? `${tape.label.slice(0, 21)}…` : tape.label) : '';
      }
      cassette.classList.toggle('is-empty', !tape);
      cassette.classList.toggle('active-tape', Boolean(tape) && tapeIndex === activeTapeIdx);
      cassette.setAttribute('aria-disabled', String(!tape));
      if (tape) {
        const fill = Array.from(cassette.querySelectorAll('rect')).find(rect =>
          rect.getAttribute('x') === '2' && rect.getAttribute('y') === '7'
        );
        const colors = getCassetteColors(tape, tapeIndex);
        if (fill) fill.setAttribute('fill', colors.color);
        if (label) label.setAttribute('fill', colors.labelColor);
        usedTapeIds.add(tape.id);
        cassette.setAttribute('role', 'button');
        cassette.setAttribute('tabindex', '0');
        cassette.setAttribute('aria-label', `${tape.label} kasetini seç`);
        cassette.setAttribute('title', tape.label);
      } else {
        cassette.removeAttribute('role');
        cassette.removeAttribute('tabindex');
        cassette.removeAttribute('aria-label');
        cassette.removeAttribute('title');
      }
    });

    // ── SVG'de slotu olmayan kasetleri dinamik olarak ekle ──
    const existingIds = new Set(usedTapeIds);

    // Sabit kasetlerden sonraki tek sıra yuvaları için x konumunu bul.
    const existingSlots = svg.querySelectorAll('.svg-tape[data-tape]');
    let maxX = 26; // ilk kaset x=26; kasetler arası adım 24px
    existingSlots.forEach(el => {
      const t = el.getAttribute('transform') || '';
      const m = t.match(/translate\((\d+),\s*10\)/);
      if (m) maxX = Math.max(maxX, Number(m[1]));
    });

    // Eksik kasetleri tek sıraya dik olarak ekle; raf kapasitesi 12 ile sınırlı.
    shelfTapes.forEach(({ tape, tapeIndex }) => {
      if (existingIds.has(tape.id)) return; // zaten var

      // Yeni dik kaset slotu oluştur
      const nextX = maxX + 24;
      maxX = nextX;

      const ns = 'http://www.w3.org/2000/svg';
      const { color: tapeColor, labelColor } = getCassetteColors(tape, tapeIndex);

      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', `svg-tape${tapeIndex === activeTapeIdx ? ' active-tape' : ''}`);
      g.setAttribute('data-tape', tape.id);
      g.setAttribute('transform', `translate(${nextX}, 10)`);
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', `${tape.label} kasetini seç`);
      g.setAttribute('title', tape.label);

      // Dış kutu
      const outer = document.createElementNS(ns, 'rect');
      outer.setAttribute('x','0'); outer.setAttribute('y','0');
      outer.setAttribute('width','22'); outer.setAttribute('height','124');
      outer.setAttribute('rx','2'); outer.setAttribute('fill','#e8eaed');
      outer.setAttribute('fill-opacity','0.45');
      outer.setAttribute('stroke','#2b2d42'); outer.setAttribute('stroke-width','0.8');
      // Renk dolgu
      const fill = document.createElementNS(ns, 'rect');
      fill.setAttribute('x','2'); fill.setAttribute('y','7');
      fill.setAttribute('width','18'); fill.setAttribute('height','113');
      fill.setAttribute('fill', tapeColor);
      // Parlak üst şerit
      const shine = document.createElementNS(ns, 'rect');
      shine.setAttribute('x','2'); shine.setAttribute('y','1.5');
      shine.setAttribute('width','18'); shine.setAttribute('height','4');
      shine.setAttribute('rx','0.5');
      shine.setAttribute('fill','#ffffff'); shine.setAttribute('fill-opacity','0.55');
      // Etiket
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('class','svg-tape-label');
      text.setAttribute('x','11'); text.setAttribute('y','65');
      text.setAttribute('fill', labelColor);
      text.setAttribute('font-family',"'Courier New', monospace");
      text.setAttribute('font-size','8.5');
      text.setAttribute('font-weight','bold');
      text.setAttribute('text-anchor','middle');
      text.setAttribute('transform','rotate(90, 11, 65)');
      text.setAttribute('letter-spacing','0.5');
      const shelfLabel = tape.label.length > 22 ? `${tape.label.slice(0, 21)}…` : tape.label;
      text.textContent = shelfLabel;

      g.append(outer, fill, shine, text);

      svg.insertBefore(g, svg.querySelector('.shelf-front'));
      existingIds.add(tape.id);
    });
  }

  /** HTML escape */
  _esc(str) {
    return str
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  /**
   * Duvar çerçevesindeki resmi albüm kapağıyla değiştirir.
   * artworkUrl: null veya boş string → orijinal oda resmini geri yükle
   */
  setWallArtwork(artworkUrl) {
    const img = document.getElementById('wall-picture-right');
    if (!img) return;

    if (artworkUrl) {
      // Yeni resmi yükle — yüklenene kadar mevcut görüntü kalsın
      const temp = new Image();
      temp.onload = () => {
        img.src = artworkUrl;
        img.classList.add('wall-artwork-active');
        img.alt = 'Albüm kapağı';
      };
      temp.onerror = () => {
        // Yüklenemezse orijinal odaya dön
        this._restoreRoomPicture(img);
      };
      temp.src = artworkUrl;
    } else {
      this._restoreRoomPicture(img);
    }
  }

  _restoreRoomPicture(img) {
    img.classList.remove('wall-artwork-active');
    img.alt = '';
    // setRandomRoomPictures() global fonksiyonunu tekrar çağır
    if (typeof setRandomRoomPictures === 'function') setRandomRoomPictures();
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
    this._defaultStations = [];
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

  /** Yönetim panosundaki canlı kart için "95.0 MHz · Power FM" etiketi */
  _radioLabel(station) {
    if (!station) return '';
    const freq = Number(station.frequency);
    const freqText = Number.isFinite(freq) && freq > 0 ? `${freq.toFixed(1)} MHz` : '';
    return [freqText, station.name || 'Radyo'].filter(Boolean).join(' · ');
  }

  async init() {
    const [stations, tapes] = await Promise.all([
      DataLoader.fetchStations(),
      DataLoader.fetchTapes()
    ]);
    this._stations = stations;
    this._tapes    = tapes;
    this._defaultStations = stations.slice();

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
        Heartbeat.start('radio', this._radioLabel(this._radio.currentStation));
      } else {
        this._stopNowPlaying();
        Heartbeat.stop();
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
      // Albüm kapağını duvara yansıt
      this._ui.setWallArtwork(this._activeTrack?.artworkUrl || null);
      // Dinleyici heartbeat başlat
      Heartbeat.start('tape', this._activeTrack?.title || 'Kaset');
    };
    this._tape.onPause = () => {
      this._tapeIsPlaying = false;
      this._spectrum.setTapePlaying(false);
      this._ui.setPlayState(false);
      this._ui.updateTapeStatus(false, this._activeTrack);
      // Duraklayınca dinleyici sayısından düş
      Heartbeat.stop();
      // Duraklayınca kapak kalsın (silinmesin)
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
      Heartbeat.stop();
      this._errorTracks.add(this._errKey(this._tapeIdx, this._trackIdx));
      this._ui.renderTrackList(this._activeTracks, this._trackIdx, this._errorTracks, this._tapeIdx);

      // Hatalı parçadan sonraki erişilebilir parçayı bul (ardışık hataları atla)
      const tracks = this._activeTracks;
      const total  = tracks.length;
      if (!total) return;

      let next = (this._trackIdx + 1) % total;
      let tries = 0;
      // _errorTracks içinde olmayan ilk parçayı bul (tam tur hariç)
      while (
        tries < total - 1 &&
        this._errorTracks.has(this._errKey(this._tapeIdx, next))
      ) {
        next = (next + 1) % total;
        tries++;
      }

      // Kasetteki tüm parçalar hatalıysa dur
      if (tries >= total - 1 && this._errorTracks.has(this._errKey(this._tapeIdx, next))) {
        showToast('Bu kasetteki tüm parçalar yüklenemedi.');
        this._tapeIsPlaying = false;
        this._spectrum.setTapePlaying(false);
        this._ui.setPlayState(false);
        return;
      }

      setTimeout(() => this._selectTape(this._tapeIdx, next, true), 800);
    };
    this._tape.onAutoplayBlocked = () => {
      showToast('Tarayıcı otomatik oynatmayı engelledi. Çal düğmesine dokunun.');
    };

    this._ui.renderStationList(stations, -1, false);
    this._ui.renderCassetteShelf(this._tapes, this._tapeIdx);
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
    const station = this._stations[index];
    if (station?.cassetteId) {
      const tapeIndex = this._tapes.findIndex(tape => tape.id === station.cassetteId);
      const tape = tapeIndex >= 0 ? this._tapes[tapeIndex] : null;
      const trackIndex = tape?.tracks?.findIndex(track => track.streamUrl === station.streamUrl) ?? -1;
      if (tape && trackIndex >= 0) {
        this._tapeIdx = tapeIndex;
        this._trackIdx = trackIndex;
        this._ui.renderCassetteShelf(this._tapes, tapeIndex);
        this._ui.renderTrackList(tape.tracks, trackIndex, this._errorTracks, tapeIndex);
      }
    }
    if (this._tapeIsPlaying) {
      this._tape.pause();
      this._tapeIsPlaying = false;
      this._spectrum.setTapePlaying(false);
      this._ui.updateTapeStatus(false);
      this._ui.setPlayState(false);
    }
    // Radyoya geçince albüm kapağını kaldır, orijinal odaya dön
    this._ui.setWallArtwork(null);
    this._mode = 'radio';
    this._spectrum.setMode('radio');
    this._staticPlaying = false;
    await this._radio.selectStation(index);
    this._ui.setPlayState(true);
  }

  setCustomCassettes(cassettes, activeId = null, autoPlay = false) {
    const previousActiveId = this._mode === 'tape' && this._activeTape?.isCustom ? this._activeTape.id : null;
    const previousTrackIndex = this._trackIdx;
    const wasPlaying = this._tapeIsPlaying;
    const hadCustomActive = Boolean(previousActiveId);
    if (hadCustomActive) {
      this._tape.pause();
      this._tapeIsPlaying = false;
      this._spectrum.setTapePlaying(false);
      this._ui.setPlayState(false);
    }

    if (this._radio?.currentStation?.isCustom) this._radio.stop();

    const uniqueCassettes = [];
    const seenIds = new Set();
    (Array.isArray(cassettes) ? cassettes : []).forEach(tape => {
      if (!tape || typeof tape.id !== 'string' || !Array.isArray(tape.tracks) || seenIds.has(tape.id)) return;
      seenIds.add(tape.id);
      uniqueCassettes.push({ ...tape, isCustom: true });
    });
    const personalStations = [];
    uniqueCassettes.forEach(tape => tape.tracks.filter(track => track?.type === 'radio' && track.streamUrl).forEach(track => {
      if (personalStations.some(station => station.streamUrl === track.streamUrl)) return;
      personalStations.push({
        frequency: Number(track.frequency) || 88,
        name: track.title || 'Kişisel radyo',
        genre: track.subtitle || 'Kişisel kaset',
        streamUrl: track.streamUrl,
        isCustom: true,
        cassetteId: tape.id,
        cassetteLabel: tape.label || 'Kişisel kaset',
      });
    }));
    const visibleStations = personalStations.length ? personalStations : this._defaultStations;
    this._stations.splice(0, this._stations.length, ...visibleStations);
    if (this._radio) this._radio._stations = this._stations;
    this._radioIdx = -1;
    this._tapes = this._tapes.filter(tape => !tape.isCustom).concat(uniqueCassettes);
    this._ui.renderStationList(this._stations, this._radioIdx, this._radio?.isOn === true);
    this._ui._renderRadioCollection?.();
    this._errorTracks.clear();

    if (hadCustomActive) {
      this._tapeIdx = 0;
      this._trackIdx = 0;
    }
    const preferredActiveId = activeId || (uniqueCassettes.some(tape => tape.id === previousActiveId) ? previousActiveId : null);
    const selectedIndex = preferredActiveId ? this._tapes.findIndex(tape => tape.id === preferredActiveId) : -1;
    if (selectedIndex >= 0 && this._powered) {
      const preserveCurrent = !activeId && preferredActiveId === previousActiveId;
      const trackCount = this._tapes[selectedIndex].tracks?.length || 1;
      const selectedTrack = preserveCurrent ? Math.min(previousTrackIndex, trackCount - 1) : 0;
      this._selectTape(selectedIndex, selectedTrack, activeId ? autoPlay : preserveCurrent && wasPlaying);
    } else if (hadCustomActive && this._tapes.length && this._powered) {
      this._selectTape(0, 0, false);
    } else {
      this._ui.renderCassetteShelf(this._tapes, this._tapeIdx);
    }
    return uniqueCassettes;
  }

  switchToTapeBySelector(tapeIdx) {
    this._selectTape(tapeIdx, 0, true);
  }

  switchToTape(trackIdx) {
    this._selectTape(this._tapeIdx, trackIdx, true);
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

    this._ui.renderCassetteShelf(this._tapes, tapeIdx);
    this._ui.renderTrackList(tape?.tracks || [], trackIdx, this._errorTracks, tapeIdx);
    this._ui.scrollTrackIntoView(trackIdx);
    this._ui.updateTapeStatus(false, track);
    this._ui.resetTapeCounter();

    if (track?.type === 'radio' && track.streamUrl) {
      const stationIndex = this._stations.findIndex(station => station.streamUrl === track.streamUrl);
      if (stationIndex < 0) return;
      if (this._tapeIsPlaying) {
        this._tape.pause();
        this._tapeIsPlaying = false;
        this._spectrum.setTapePlaying(false);
      }
      this._mode = 'radio';
      this._spectrum.setMode('radio');
      this._radioIdx = stationIndex;
      this._radio._currentIndex = stationIndex;
      this._radio._isOn = false;
      this._ui.updateRadioStatus(false, this._stations[stationIndex]);
      if (autoPlay) this._radio.selectStation(stationIndex);
      return;
    }

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

/* ═══════════════════════════════════════════════════════
   DİNLEYİCİ HEARTBEAT
   Oynatma aktifken 20 sn'de bir sunucuya bildirim gönderir.
   Sunucu 75 sn içinde heartbeat gelmezse dinleyiciyi düşürür
   (arka plan sekmesinde tarayıcı zamanlayıcıları seyrekleştirdiği
   için TTL bilinçli olarak geniş tutuldu).
   ═══════════════════════════════════════════════════════ */
const Heartbeat = (() => {
  const INTERVAL_MS = 20_000;

  // Tarayıcı sekmesine özgü rastgele oturum kimliği
  let _id = sessionStorage.getItem('kk_hb_id');
  if (!_id) {
    _id = crypto.randomUUID?.() || `kk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem('kk_hb_id', _id);
  }

  let _timer = null;
  let _mode  = null;   // 'radio' | 'tape' | null
  let _label = '';

  function _send(mode, label) {
    fetch('/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: _id, mode, label }),
      keepalive: true,
    }).catch(() => {});
  }

  function _clearTimer() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  /** Sunucudan dinleyiciyi hemen düşür (sayfadan çıkış, duraklatma) */
  function _leave() {
    if (!_mode) return;
    _mode = null;
    _label = '';
    fetch('/api/heartbeat', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: _id }),
      keepalive: true,
    }).catch(() => {});
  }

  // Arka plan sekmesinde ses çalmaya devam ettiği için heartbeat sürer;
  // sekme öne geldiğinde sayaç gecikmesin diye anında tazelenir.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _mode) _send(_mode, _label);
  });
  window.addEventListener('pagehide', () => { _clearTimer(); _leave(); });

  return {
    start(mode, label) {
      const nextLabel = String(label || '').slice(0, 120);
      const changed = _mode !== mode || _label !== nextLabel;
      _mode  = mode;
      _label = nextLabel;
      if (!_timer) {
        _timer = setInterval(() => { if (_mode) _send(_mode, _label); }, INTERVAL_MS);
      }
      if (changed) _send(_mode, _label);
    },
    stop() {
      _clearTimer();
      _leave();
    },
  };
})();

const app = new App();
app.init().catch(err => {
  console.error('[App] Başlatılamadı:', err);
  showToast('Uygulama başlatılamadı: ' + err.message);
});
