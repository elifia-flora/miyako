/**
 * 波形引擎
 * 1) createPeaks()   —— 把 AudioBuffer 压成多级 min/max 金字塔，缩放时按像素密度选层，
 *                      任何缩放级别下每像素都只做常数级聚合。
 * 2) WaveView        —— canvas 绘制 + 视图（起始秒 / 跨度）+ 刻度尺 + 标记层 + 播放头。
 *
 * 性能要点：波形本体只在「视图变化 / 尺寸变化 / 换曲」时重绘，并且预生成
 * 未播放（灰）与已播放（琥珀）两张离屏位图；每帧只做两次 drawImage + 一次裁剪，
 * 播放头则是 DOM transform，完全不进 canvas。
 */
(function (global) {
  'use strict';

  const BASE_BUCKET = 16;

  /** 计算峰值金字塔 */
  function createPeaks(audioBuffer) {
    const sr = audioBuffer.sampleRate;
    const len = audioBuffer.length;
    const chs = audioBuffer.numberOfChannels;
    const data = new Float32Array(len);

    // 混成单声道（多声道取平均，波形更接近听感）
    for (let c = 0; c < chs; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < len; i++) data[i] += ch[i] / chs;
    }

    let absMax = 0;
    for (let i = 0; i < len; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > absMax) absMax = v;
    }

    const levels = [];
    let bucket = BASE_BUCKET;
    let count = Math.ceil(len / bucket);
    let min = new Float32Array(count);
    let max = new Float32Array(count);

    for (let b = 0; b < count; b++) {
      let lo = 1, hi = -1;
      const start = b * bucket;
      const end = Math.min(len, start + bucket);
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo > hi ? 0 : lo;
      max[b] = hi < lo ? 0 : hi;
    }
    levels.push({ bucket, min, max });

    while (count > 256) {
      const pMin = min, pMax = max;
      count = Math.ceil(count / 2);
      min = new Float32Array(count);
      max = new Float32Array(count);
      for (let b = 0; b < count; b++) {
        const i0 = b * 2;
        const i1 = Math.min(pMin.length - 1, i0 + 1);
        min[b] = Math.min(pMin[i0], pMin[i1]);
        max[b] = Math.max(pMax[i0], pMax[i1]);
      }
      bucket *= 2;
      levels.push({ bucket, min, max });
    }

    return {
      duration: audioBuffer.duration,
      sampleRate: sr,
      channels: chs,
      peaksAbsMax: absMax || 1,
      levels,
    };
  }

  /* ------------------------------------------------------------------ *
   * 原生采样率探针
   * decodeAudioData 会把音频重采样到 AudioContext 的采样率，所以「采样数」
   * 读数必须知道文件本身的采样率。对无损/未压缩容器直接读头部，最准。
   * ------------------------------------------------------------------ */
  const ascii = (b, off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i] || 0);
    return s;
  };

  function probeSampleRate(bytes) {
    try {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const head = ascii(bytes, 0, 4);

      // WAV / RIFF
      if (head === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
        let p = 12;
        while (p + 8 <= bytes.length) {
          const id = ascii(bytes, p, 4);
          const size = dv.getUint32(p + 4, true);
          if (id === 'fmt ') {
            const rate = dv.getUint32(p + 12, true);
            return rate > 0 ? rate : 0;
          }
          if (size <= 0) break;
          p += 8 + size + (size & 1);
        }
        return 0;
      }

      // AIFF / AIFC
      if (head === 'FORM' && /AIFF|AIFC/.test(ascii(bytes, 8, 4))) {
        let p = 12;
        while (p + 8 <= bytes.length) {
          const id = ascii(bytes, p, 4);
          const size = dv.getUint32(p + 4, false);
          if (id === 'COMM') {
            const off = p + 8 + 8; // 跳过 channels(2) + frames(4) + bits(2)
            const exp = dv.getInt16(off, false);
            const hi = dv.getUint32(off + 2, false);
            const lo = dv.getUint32(off + 6, false);
            if (!exp && !hi && !lo) return 0;
            return Math.round((hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63));
          }
          if (size <= 0) break;
          p += 8 + size + (size & 1);
        }
        return 0;
      }

      // FLAC：STREAMINFO 里的 20 bit 采样率
      if (head === 'fLaC') {
        const b0 = bytes[18], b1 = bytes[19], b2 = bytes[20];
        const rate = (b0 << 12) | (b1 << 4) | (b2 >> 4);
        return rate > 0 ? rate : 0;
      }
    } catch {
      /* 头部结构不符合预期就走兜底 */
    }
    return 0;
  }

  /** 视觉刻度阶梯（秒） */  const TICK_LADDER = [
    0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300,
    600, 900, 1800, 3600,
  ];

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /** 指针捕获兜底：合成事件或指针已释放时 setPointerCapture 会抛异常 */
  const capture = (el, id) => {
    try {
      el.setPointerCapture(id);
    } catch {
      /* ignore */
    }
  };
  const release = (el, id) => {
    try {
      el.releasePointerCapture(id);
    } catch {
      /* ignore */
    }
  };

  class WaveView {
    constructor(opts) {
      this.wrap = opts.wrap; // 容器（含 ruler + body + scrollbar）
      this.canvas = opts.canvas;
      this.ruler = opts.ruler;
      this.overlay = opts.overlay;
      this.playheadEl = opts.playheadEl;
      this.loopEl = opts.loopEl;
      this.scroller = opts.scroller;
      this.thumb = opts.thumb;

      this.ctx = this.canvas.getContext('2d');
      this.rctx = this.ruler.getContext('2d');

      this.peaks = null;
      this.duration = 0;
      this.viewStart = 0;
      this.viewSpan = 1;

      this.playheadTime = 0;
      this.loop = null; // {start,end}
      this.markers = [];

      this.width = 0;
      this.height = 0;
      this.dpr = window.devicePixelRatio || 1;

      this.layerGrey = document.createElement('canvas');
      this.layerHot = document.createElement('canvas');

      this.onSeek = null; // (time, {commit}) => void
      this.onAddMarkerAt = null;
      this.onViewChange = null;

      this._bindResize();
      this._bindPointer();
      this._bindWheel();
      this._bindScroller();
    }

    /* ---------- 尺寸 ---------- */
    _bindResize() {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.canvas.parentElement);
      this.resize();
    }

    resize() {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      this.width = Math.max(1, Math.floor(rect.width));
      this.height = Math.max(1, Math.floor(rect.height));
      this.dpr = window.devicePixelRatio || 1;

      for (const c of [this.canvas, this.ruler, this.layerGrey, this.layerHot]) {
        c.width = Math.floor(this.width * this.dpr);
        c.height = Math.floor((c === this.ruler ? 30 : this.height) * this.dpr);
      }
      this.ruler.style.width = this.width + 'px';
      this.ruler.style.height = '30px';
      this.canvas.style.width = this.width + 'px';
      this.canvas.style.height = this.height + 'px';

      this.redraw();
    }

    /* ---------- 数据 ---------- */
    setPeaks(peaks) {
      this.peaks = peaks;
      this.duration = peaks ? peaks.duration : 0;
      this.viewStart = 0;
      this.viewSpan = this.duration || 1;
      this.redraw();
      this.emitView();
    }

    clear() {
      this.peaks = null;
      this.duration = 0;
      this.viewStart = 0;
      this.viewSpan = 1;
      this.playheadTime = 0;
      this.loop = null;
      this.markers = [];
      this.renderMarkers();
      this.redraw();
      this.emitView();
    }

    setMarkers(list) {
      this.markers = list || [];
      this.renderMarkers();
    }

    setLoop(loop) {
      this.loop = loop;
      this.paintLoop();
    }

    setPlayhead(t) {
      this.playheadTime = t;
      const x = this.timeToX(t);
      this.playheadEl.style.transform = `translate3d(${x}px,0,0)`;
      this.playheadEl.style.opacity = this.peaks ? '1' : '0.25';
      this.paintHot();
    }

    /* ---------- 坐标 ---------- */
    timeToX(t) {
      if (!this.viewSpan) return 0;
      return ((t - this.viewStart) / this.viewSpan) * this.width;
    }
    xToTime(x) {
      return this.viewStart + (x / this.width) * this.viewSpan;
    }

    /* ---------- 视图控制 ---------- */
    setView(start, span) {
      const dur = this.duration || 1;
      span = clamp(span, 0.01, Math.max(dur, 0.01));
      start = clamp(start, 0, Math.max(0, dur - span));
      this.viewStart = start;
      this.viewSpan = span;
      this.redraw();
      this.paintThumb();
      this.emitView();
    }

    zoomAt(factor, anchorRatio) {
      if (!this.peaks) return;
      const anchorT = this.viewStart + anchorRatio * this.viewSpan;
      const span = clamp(this.viewSpan / factor, 0.01, this.duration);
      const start = anchorT - anchorRatio * span;
      this.setView(start, span);
    }

    fit() {
      if (!this.peaks) return;
      this.setView(0, this.duration);
    }

    panBy(seconds) {
      this.setView(this.viewStart + seconds, this.viewSpan);
    }

    zoomPercent() {
      if (!this.duration) return 100;
      return (this.duration / this.viewSpan) * 100;
    }

    emitView() {
      if (this.onViewChange) this.onViewChange(this.zoomPercent());
    }

    /* ---------- 交互 ---------- */
    _bindPointer() {
      const body = this.canvas.parentElement;
      let dragging = false;

      const seekTo = (clientX, commit) => {
        const rect = this.canvas.getBoundingClientRect();
        const t = clamp(this.xToTime(clientX - rect.left), 0, this.duration || 0);
        this.onSeek && this.onSeek(t, { commit });
      };

      body.addEventListener('pointerdown', (e) => {
        if (!this.peaks || e.button !== 0) return;
        if (e.target.closest('.pin')) return; // 交给标记自己处理
        dragging = true;
        capture(body, e.pointerId);
        body.classList.add('scrubbing');
        seekTo(e.clientX, false);
      });

      body.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        seekTo(e.clientX, false);
      });

      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        body.classList.remove('scrubbing');
        release(body, e.pointerId);
        seekTo(e.clientX, true);
      };
      body.addEventListener('pointerup', end);
      body.addEventListener('pointercancel', end);

      body.addEventListener('dblclick', (e) => {
        if (!this.peaks) return;
        if (e.target.closest('.pin')) return;
        const rect = this.canvas.getBoundingClientRect();
        const t = clamp(this.xToTime(e.clientX - rect.left), 0, this.duration);
        this.onAddMarkerAt && this.onAddMarkerAt(t);
      });
    }

    _bindWheel() {
      const body = this.canvas.parentElement;
      body.addEventListener(
        'wheel',
        (e) => {
          if (!this.peaks) return;
          e.preventDefault();
          const rect = this.canvas.getBoundingClientRect();
          if (e.shiftKey) {
            this.panBy((e.deltaY / 400) * this.viewSpan);
          } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
            this.panBy((e.deltaX / 600) * this.viewSpan);
          } else {
            const ratio = clamp((e.clientX - rect.left) / this.width, 0, 1);
            this.zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, ratio);
          }
        },
        { passive: false }
      );
    }

    _bindScroller() {
      const bar = this.scroller;
      let drag = null;
      bar.addEventListener('pointerdown', (e) => {
        if (!this.peaks) return;
        const rect = bar.getBoundingClientRect();
        const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        if (e.target === this.thumb) {
          drag = { offset: e.clientX - this.thumb.getBoundingClientRect().left };
        } else {
          // 点击轨道：把视图中心对齐到点击处
          this.setView(ratio * this.duration - this.viewSpan / 2, this.viewSpan);
          drag = { offset: (this.viewSpan / this.duration) * rect.width / 2 };
        }
        bar.setPointerCapture(e.pointerId);
      });

      bar.addEventListener('pointermove', (e) => {
        if (!drag || !this.peaks) return;
        const rect = bar.getBoundingClientRect();
        const thumbW = (this.viewSpan / this.duration) * rect.width;
        const left = e.clientX - rect.left - drag.offset;
        const ratio = clamp(left / Math.max(1, rect.width - thumbW), 0, 1);
        this.setView(ratio * (this.duration - this.viewSpan), this.viewSpan);
      });
      const stop = (e) => {
        drag = null;
        try {
          bar.releasePointerCapture(e.pointerId);
        } catch {}
      };
      bar.addEventListener('pointerup', stop);
      bar.addEventListener('pointercancel', stop);
    }

    paintThumb() {
      if (this.scroller) this.scroller.classList.toggle('disabled', !this.peaks);
      if (!this.duration || !this.thumb) return;
      const ratio = this.viewSpan / this.duration;
      const left = (this.viewStart / this.duration) * 100;
      this.thumb.style.width = Math.max(2, ratio * 100) + '%';
      this.thumb.style.left = left + '%';
    }

    /* ---------- 绘制 ---------- */
    redraw() {
      this.drawRuler();
      this.buildLayers();
      this.blit();
      this.paintHot();
      this.paintLoop();
      this.positionMarkers();
      this.paintThumb();
    }

    /** 刻度尺 */
    drawRuler() {
      const ctx = this.rctx;
      const W = this.width, H = 30;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!this.peaks) {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, H - 1.5);
        ctx.lineTo(W, H - 1.5);
        ctx.stroke();
        return;
      }

      const pxPerSec = W / this.viewSpan;
      let step = TICK_LADDER[TICK_LADDER.length - 1];
      for (const s of TICK_LADDER) {
        if (s * pxPerSec >= 86) {
          step = s;
          break;
        }
      }

      ctx.font = '500 10px "Cascadia Mono", Consolas, ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.lineWidth = 1;

      const first = Math.ceil(this.viewStart / step) * step;
      // 次级刻度
      const minor = step / 4;
      const firstMinor = Math.ceil(this.viewStart / minor) * minor;
      ctx.beginPath();
      for (let t = firstMinor; t <= this.viewStart + this.viewSpan; t += minor) {
        const x = Math.round(this.timeToX(t)) + 0.5;
        if (x < -2 || x > W + 2) continue;
        ctx.moveTo(x, H - 6);
        ctx.lineTo(x, H);
      }
      ctx.stroke();

      ctx.beginPath();
      for (let t = first; t <= this.viewStart + this.viewSpan + step * 0.001; t += step) {
        const x = Math.round(this.timeToX(t)) + 0.5;
        if (x < -2 || x > W + 2) continue;
        ctx.moveTo(x, H - 12);
        ctx.lineTo(x, H);
        ctx.fillText(this.tickLabel(t, step), x + 5, 11);
      }
      ctx.stroke();
    }

    tickLabel(t, step) {
      const h = Math.floor(t / 3600);
      const m = Math.floor(t / 60) % 60;
      const s = Math.floor(t) % 60;
      const p2 = (n) => String(n).padStart(2, '0');
      if (step < 1) {
        const frac = Math.round((t - Math.floor(t)) * 1000);
        return h > 0
          ? `${h}:${p2(m)}:${p2(s)}.${String(frac).padStart(3, '0')}`
          : `${p2(m)}:${p2(s)}.${String(frac).padStart(3, '0')}`;
      }
      if (h > 0) return `${h}:${p2(m)}:${p2(s)}`;
      return `${m}:${p2(s)}`;
    }

    /** 逐像素上下包络（独立成方法，便于自检与复用） */
    envelope() {
      const W = this.width, H = this.height;
      const mid = H / 2;
      const tops = [];
      const bots = [];
      if (!this.peaks) return { tops, bots, mid, amp: 1, bucket: 0 };

      const spp = (this.viewSpan * this.peaks.sampleRate) / W;
      const levels = this.peaks.levels;
      let lv = levels[0];
      for (const l of levels) {
        if (l.bucket <= spp) lv = l;
        else break;
      }
      const { bucket, min, max } = lv;
      const amp = (mid - 10) / (this.peaks.peaksAbsMax || 1);

      for (let x = 0; x < W; x += 1) {
        const t0 = this.viewStart + (x / W) * this.viewSpan;
        const t1 = this.viewStart + ((x + 1) / W) * this.viewSpan;
        const s0 = Math.max(0, Math.floor(t0 * this.peaks.sampleRate));
        const s1 = Math.max(s0 + 1, Math.ceil(t1 * this.peaks.sampleRate));
        const b0 = Math.floor(s0 / bucket);
        let b1 = Math.min(min.length - 1, Math.floor((s1 - 1) / bucket));
        if (b0 > b1) b1 = b0;
        if (b0 >= min.length) continue;
        let lo = min[b0];
        let hi = max[b0];
        for (let b = b0 + 1; b <= b1; b++) {
          if (min[b] < lo) lo = min[b];
          if (max[b] > hi) hi = max[b];
        }
        tops.push([x + 0.5, mid - Math.max(0.6, hi * amp), hi]);
        bots.push([x + 0.5, mid + Math.max(0.6, -lo * amp), lo]);
      }
      return { tops, bots, mid, amp, bucket };
    }

    /** 选层 + 生成灰/热两张离屏位图 */
    buildLayers() {
      const W = this.width, H = this.height;
      const dpr = this.dpr;
      for (const c of [this.layerGrey, this.layerHot]) {
        c.width = Math.floor(W * dpr);
        c.height = Math.floor(H * dpr);
      }
      if (!this.peaks) return;

      const gctx = this.layerGrey.getContext('2d');
      const hctx = this.layerHot.getContext('2d');
      gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gctx.clearRect(0, 0, W, H);
      hctx.clearRect(0, 0, W, H);

      const mid = H / 2;
      const { tops, bots } = this.envelope();

      const path = new Path2D();
      const build = (ctx, fill) => {
        if (!tops.length) return;
        path.moveTo(tops[0][0], mid);
        for (let i = 0; i < tops.length; i++) path.lineTo(tops[i][0], tops[i][1]);
        for (let i = bots.length - 1; i >= 0; i--) path.lineTo(bots[i][0], bots[i][1]);
        path.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, fill[0]);
        grad.addColorStop(0.5, fill[1]);
        grad.addColorStop(1, fill[0]);
        ctx.fillStyle = grad;
        ctx.fill(path);
      };

      build(gctx, ['rgba(120,132,144,0.48)', 'rgba(160,174,188,0.68)']);
      build(hctx, ['rgba(226,140,18,0.52)', 'rgba(255,193,86,0.86)']);

      // 中线
      for (const ctx of [gctx, hctx]) {
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid + 0.5);
        ctx.lineTo(W, mid + 0.5);
        ctx.stroke();
      }
    }

    blit() {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.layerGrey, 0, 0);
    }

    /** 已播放区域叠琥珀层 */
    paintHot() {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (this.peaks) {
        // 先恢复灰色底，再画热层（避免播放头回拖时残留）
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.drawImage(this.layerGrey, 0, 0);
        const x = Math.max(0, Math.min(this.canvas.width, this.timeToX(this.playheadTime) * this.dpr));
        if (x > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, x, this.canvas.height);
          ctx.clip();
          ctx.drawImage(this.layerHot, 0, 0);
          ctx.restore();
        }
      }
    }

    paintLoop() {
      const el = this.loopEl;
      if (!this.loop || !this.peaks) {
        el.style.display = 'none';
        return;
      }
      const x1 = this.timeToX(this.loop.start);
      const x2 = this.timeToX(this.loop.end);
      el.style.display = 'block';
      el.style.left = Math.min(x1, x2) + 'px';
      el.style.width = Math.abs(x2 - x1) + 'px';
    }

    /* ---------- 标记层 ---------- */
    renderMarkers() {
      // 清空旧 pin
      this.overlay.querySelectorAll('.pin').forEach((n) => n.remove());
      const frag = document.createDocumentFragment();
      this.markers.forEach((m, i) => {
        const pin = document.createElement('div');
        pin.className = 'pin pin-' + m.type;
        pin.dataset.id = m.id;
        pin.innerHTML =
          `<div class="flag"><span class="num">${i + 1}</span><span class="name"></span></div>` +
          `<div class="stem"></div>`;
        pin.querySelector('.name').textContent = m.name || '';
        pin.title = '';
        // 拖动标记
        const flag = pin.querySelector('.flag');
        flag.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const body = this.canvas.parentElement;
          capture(body, e.pointerId);
          const move = (ev) => {
            const rect = this.canvas.getBoundingClientRect();
            const t = clamp(this.xToTime(ev.clientX - rect.left), 0, this.duration);
            if (this.onMarkerDrag) this.onMarkerDrag(m.id, t, false);
          };
          const up = (ev) => {
            const rect = this.canvas.getBoundingClientRect();
            const t = clamp(this.xToTime(ev.clientX - rect.left), 0, this.duration);
            if (this.onMarkerDrag) this.onMarkerDrag(m.id, t, true);
            body.removeEventListener('pointermove', move);
            body.removeEventListener('pointerup', up);
            try {
              body.releasePointerCapture(ev.pointerId);
            } catch {}
          };          body.addEventListener('pointermove', move);
          body.addEventListener('pointerup', up);
        });
        flag.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (this.onMarkerActivate) this.onMarkerActivate(m.id);
        });
        flag.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.onMarkerJump) this.onMarkerJump(m.id);
        });
        frag.appendChild(pin);
      });
      this.overlay.appendChild(frag);
      this.positionMarkers();
    }

    positionMarkers() {
      const pins = Array.from(this.overlay.querySelectorAll('.pin'));
      const W = this.width;
      const placed = [];

      for (const pin of pins) {
        const m = this.markers.find((x) => x.id === pin.dataset.id);
        if (!m) continue;
        const x = this.timeToX(m.time);
        const visible = x >= -40 && x <= W + 40;
        pin.style.display = visible ? 'flex' : 'none';
        pin.style.transform = `translateX(${x}px)`;
        // 靠右边界时旗帜翻到左侧，避免出框
        pin.classList.toggle('flip', x > W - 96);
        if (visible) placed.push({ pin, x });
      }

      // 空间足够就把标记名直接写出来，免得非要悬停才看得见
      for (let i = 0; i < placed.length; i++) {
        const cur = placed[i];
        const next = placed[i + 1];
        const room = (next ? next.x : W) - cur.x;
        cur.pin.classList.toggle('wide', room > 92);
      }
    }
  }

  global.WaveEngine = { createPeaks, WaveView, TICK_LADDER, probeSampleRate };
})(window);
