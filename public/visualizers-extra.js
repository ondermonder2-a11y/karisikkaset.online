/* visualizers-extra.js
 * 3 yeni ekolayzer modu: WATERFALL, RADIAL, VECTORSCOPE
 *
 * Kullanım:
 *   const v = EXTRA_VIZ.waterfall;           // veya radial / vectorscope
 *   v.init(ctx, w, h);                       // mod seçilince 1 kez
 *   v.draw(ctx, w, h, data, t, themeIndex);  // her karede (requestAnimationFrame)
 *
 * data = { freq: Uint8Array(0-255), timeL: Uint8Array(128 merkezli), timeR: Uint8Array }
 * Gerçek veri: AnalyserNode.getByteFrequencyData / getByteTimeDomainData
 * Veri yoksa (örn. SoundCloud) EXTRA_VIZ.fakeData(t) kullan.
 */
(function () {
  // ---------- Yardımcılar ----------
  function lut(stops) {              // [[pos 0-1,[r,g,b]],...] -> 256 renk
    const out = [];
    for (let i = 0; i < 256; i++) {
      const p = i / 255;
      let a = stops[0], b = stops[stops.length - 1];
      for (let s = 0; s < stops.length - 1; s++) {
        if (p >= stops[s][0] && p <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
      }
      const k = (p - a[0]) / ((b[0] - a[0]) || 1);
      const c = a[1].map((v, j) => Math.round(v + (b[1][j] - v) * k));
      out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
    return out;
  }

  // Sadece ses analizi yoksa kullanılan sahte veri (SoundCloud iframe'inden ses okunamaz)
  function fakeData(t) {
    const freq = new Uint8Array(512), timeL = new Uint8Array(256), timeR = new Uint8Array(256);
    const beat = Math.pow(Math.max(0, Math.sin(t * 0.008)), 6);
    for (let i = 0; i < 512; i++) {
      const env = Math.exp(-i / 110);
      const n = 0.55 + 0.45 * Math.sin(i * 0.31 + t * 0.004 * (1 + (i % 7)));
      freq[i] = Math.min(255, 255 * env * n * (0.55 + 0.6 * beat) + Math.random() * 12);
    }
    for (let i = 0; i < 256; i++) {
      const p = i / 256 * Math.PI * 2;
      const a = 60 + 50 * beat;
      timeL[i] = 128 + a * Math.sin(p * 3 + t * 0.01) + 20 * Math.sin(p * 11 + t * 0.003);
      timeR[i] = 128 + a * Math.sin(p * 3 + t * 0.01 + 0.9 + 0.5 * Math.sin(t * 0.002)) + 20 * Math.cos(p * 7);
    }
    return { freq, timeL, timeR };
  }

  // ---------- 1) WATERFALL (spektrogram) ----------
  const WF_THEMES = [
    { label: 'THERMAL', lut: lut([[0, [0, 0, 8]], [0.3, [70, 10, 120]], [0.6, [230, 90, 20]], [0.85, [255, 210, 60]], [1, [255, 255, 230]]]) },
    { label: 'P1 GREEN', lut: lut([[0, [0, 6, 2]], [0.5, [0, 120, 50]], [1, [150, 255, 170]]]) },
  ];
  const waterfall = {
    name: 'WATERFALL',
    themes: WF_THEMES.map(t => t.label),
    readout: { left: 'MODE: SPECTROGRAM', mid: 'SCROLL: DOWN', right: 'RANGE: 20Hz-16kHz' },
    init(ctx, w, h) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); },
    draw(ctx, w, h, data, t, th) {
      const L = WF_THEMES[th || 0].lut;
      const speed = 2;                                   // piksel/kare
      ctx.drawImage(ctx.canvas, 0, 0, w, h - speed, 0, speed, w, h - speed); // aşağı kaydır
      const bins = Math.floor(data.freq.length * 0.75), cw = 2;
      for (let x = 0; x < w; x += cw) {
        // log ölçek: bas tarafı daha geniş
        const f = Math.pow(x / w, 1.8);
        const v = data.freq[Math.min(bins - 1, Math.floor(f * bins))];
        ctx.fillStyle = L[v];
        ctx.fillRect(x, 0, cw, speed);
      }
      // hafif tarama çizgisi
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    },
  };

  // ---------- 2) RADIAL (dairesel spektrum) ----------
  const RAD_THEMES = [
    { label: 'SUNSET', a: [255, 140, 30], b: [255, 40, 120], peak: '#fff3d0' },
    { label: 'MINT', a: [40, 255, 190], b: [40, 140, 255], peak: '#e8fff8' },
  ];
  const radialPeaks = new Float32Array(72);
  const radial = {
    name: 'RADIAL',
    themes: RAD_THEMES.map(t => t.label),
    readout: { left: 'MODE: POLAR 72', mid: 'PEAK HOLD: ON', right: 'REFRESH: 60Hz' },
    init() { radialPeaks.fill(0); },
    draw(ctx, w, h, data, t, th) {
      const T = RAD_THEMES[th || 0];
      ctx.fillStyle = '#04060a'; ctx.fillRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, N = 72;
      const rx0 = w * 0.16, ry0 = h * 0.16;
      const rxMax = w * 0.47, ryMax = h * 0.43;
      const bins = Math.floor(data.freq.length * 0.7);
      // Ekranın genişliğini kullanan yatay fosfor halkaları
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
      [0, 0.5, 1].forEach(k => {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx0 + (rxMax - rx0) * k, ry0 + (ryMax - ry0) * k, 0, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.lineCap = 'round'; ctx.lineWidth = Math.max(2, (Math.PI * (rx0 + ry0)) / N * 0.55);
      let sum = 0;
      for (let i = 0; i < N; i++) {
        const half = i < N / 2 ? i : N - 1 - i;           // sol-sağ simetri
        const idx = Math.floor(Math.pow(half / (N / 2), 1.6) * bins);
        const v = data.freq[idx] / 255; sum += v;
        const ang = (i / N) * Math.PI * 2 - Math.PI / 2 + t * 0.0002;
        const c = [0, 1, 2].map(j => Math.round(T.a[j] + (T.b[j] - T.a[j]) * v));
        ctx.strokeStyle = `rgb(${c})`;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * rx0, cy + Math.sin(ang) * ry0);
        ctx.lineTo(cx + Math.cos(ang) * (rx0 + v * (rxMax - rx0)), cy + Math.sin(ang) * (ry0 + v * (ryMax - ry0)));
        ctx.stroke();
        radialPeaks[i] = Math.max(v, radialPeaks[i] - 0.015);
        if (radialPeaks[i] > 0.025) {
          ctx.fillStyle = T.peak;
          ctx.fillRect(cx + Math.cos(ang) * (rx0 + radialPeaks[i] * (rxMax - rx0) + 3) - 1.5,
                       cy + Math.sin(ang) * (ry0 + radialPeaks[i] * (ryMax - ry0) + 3) - 1.5, 3, 3);
        }
      }
      // orta "bas" nabzı
      const bass = sum / N;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx0, ry0));
      g.addColorStop(0, `rgba(${T.a},${0.15 + bass * 0.6})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, cy, rx0, ry0, 0, 0, Math.PI * 2); ctx.fill();
    },
  };

  // ---------- 3) VECTORSCOPE (Lissajous, XY) ----------
  const VEC_THEMES = [
    { label: 'P7 BLUE', col: '120,190,255', glow: '#4aa3ff' },
    { label: 'P4 WHITE', col: '235,235,225', glow: '#ffffff' },
  ];
  const vectorscope = {
    name: 'VECTORSCOPE',
    themes: VEC_THEMES.map(t => t.label),
    readout: { left: 'MODE: X-Y LISSAJOUS', mid: 'PHASE: L/R', right: 'PERSIST: MED' },
    init(ctx, w, h) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); },
    draw(ctx, w, h, data, t, th) {
      const T = VEC_THEMES[th || 0];
      // fosfor kalıcılığı
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,4,8,0.22)'; ctx.fillRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, extentX = w * 0.45, extentY = h * 0.42;
      // grafik (graticule): çarpı ve M/S etiketleri
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - extentX, cy + extentY); ctx.lineTo(cx + extentX, cy - extentY);
      ctx.moveTo(cx - extentX, cy - extentY); ctx.lineTo(cx + extentX, cy + extentY);
      ctx.moveTo(cx, cy - extentY); ctx.lineTo(cx, cy + extentY);
      ctx.moveTo(cx - extentX, cy); ctx.lineTo(cx + extentX, cy);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.font = '9px monospace';
      ctx.fillText('L', cx - extentX + 2, cy + 10); ctx.fillText('R', cx + extentX - 8, cy + 10);
      ctx.fillText('M', cx - 3, cy - extentY + 10);
      // İz: X/Y noktaları geniş ve kısa fosfor ekrana ayrı ayrı ölçeklenir.
      const n = Math.min(data.timeL.length, data.timeR.length);
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowBlur = 8; ctx.shadowColor = T.glow;
      ctx.strokeStyle = `rgba(${T.col},0.85)`; ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const l = (data.timeL[i] - 128) / 128, r = (data.timeR[i] - 128) / 128;
        const x = cx + (l - r) * 0.5 * extentX;
        const y = cy - (l + r) * 0.5 * extentY;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0; ctx.globalCompositeOperation = 'source-over';
    },
  };

  window.EXTRA_VIZ = { waterfall, radial, vectorscope, fakeData };
})();
