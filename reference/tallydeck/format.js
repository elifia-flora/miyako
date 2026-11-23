/**
 * 时间格式化引擎
 * 所有读数都由「秒」这一个真值推导，保证各格式之间永不错位。
 *
 * 时间码实现说明：
 *  - NDF（非丢帧）：按标称帧率直接取整，长时间会相对钟表漂移，这是 NDF 的固有特性。
 *  - DF（丢帧）：29.97 / 59.94 下，每到第 1、2…9 分钟时跳过起始的 2（或 4）个帧号，
 *    因此 TC 标签与钟表对齐。实现上以「钟表时间」为基准，仅在该分钟的第一秒内把帧号
 *    加上丢帧数——这与广播行业 DF 标签的观感一致（00:01:00;02 而不是 ;00）。
 */
(function (global) {
  'use strict';

  const pad = (n, w) => String(Math.floor(n)).padStart(w === undefined ? 2 : w, '0');

  const FRAME_PRESETS = [
    { id: '23.976', fps: 23.976, label: '23.976', note: '23.98' },
    { id: '24', fps: 24, label: '24', note: '电影' },
    { id: '25', fps: 25, label: '25', note: 'PAL' },
    { id: '29.97ndf', fps: 29.97, label: '29.97 NDF', note: '' },
    { id: '29.97df', fps: 29.97, label: '29.97 DF', note: '' },
    { id: '30', fps: 30, label: '30', note: 'NTSC' },
    { id: '48', fps: 48, label: '48', note: '' },
    { id: '50', fps: 50, label: '50', note: 'PAL' },
    { id: '59.94ndf', fps: 59.94, label: '59.94 NDF', note: '' },
    { id: '59.94df', fps: 59.94, label: '59.94 DF', note: '' },
    { id: '60', fps: 60, label: '60', note: '' },
    { id: 'custom', fps: 24, label: '自定义…', note: '' },
  ];

  function presetById(id) {
    return FRAME_PRESETS.find((p) => p.id === id) || FRAME_PRESETS[1];
  }

  /** 解析当前生效的帧率参数 { fps, drop, label } */
  function resolveFps(settings) {
    const p = presetById(settings.fpsPreset || '24');
    if (p.id === 'custom') {
      let fps = Number(settings.customFps);
      if (!isFinite(fps) || fps <= 0) fps = 24;
      fps = Math.min(240, Math.max(1, fps));
      return { fps, drop: Boolean(settings.customDrop), label: `${+fps.toFixed(3)} 自定义` };
    }
    return { fps: p.fps, drop: p.id.endsWith('df'), label: p.label };
  }

  /* ---------------- 单格式实现 ---------------- */

  // 00:00:00.000
  function hhmmssms(t) {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
  }

  // 00:00.000
  function mmssms(t) {
    const ms = Math.round(t * 1000);
    const m = Math.floor(ms / 60000);
    const s = Math.floor(ms / 1000) % 60;
    return `${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
  }

  // 123.456 s
  function seconds(t) {
    return `${t.toFixed(3)} s`;
  }

  /**
   * 时间码 HH:MM:SS:FF
   *
   * NDF：按真实帧数计数，用标称帧率（round(fps)）做进制换算。23.976 / 29.97 下
   *      会相对钟表缓慢漂移——这正是非丢帧时间码的真实行为，剪过片子的人都认这个。
   * DF ：每到第 1、2…9 分钟，跳过 ;00 ;01 两个帧号（59.94 跳 4 个），因此标签与钟表对齐。
   *      实现上把该分钟的第一秒均分成 (标称帧率 - 丢帧数) 个槽位，标签自然落在 ;02…;29，
   *      既不会溢出也不会出现非法帧号。
   */
  function timecode(t, fps, drop) {
    if (!isFinite(t) || t < 0) t = 0;
    const nominal = Math.max(1, Math.round(fps));
    const dropCount = drop ? Math.round(fps * 0.066666) : 0; // 29.97→2, 59.94→4
    let h, m, s, f;

    if (dropCount > 0) {
      const whole = Math.floor(t);
      const frac = t - whole;
      h = Math.floor(whole / 3600);
      m = Math.floor(whole / 60) % 60;
      s = whole % 60;
      if (s === 0 && m % 10 !== 0) {
        f = Math.floor(frac * (nominal - dropCount)) + dropCount;
      } else {
        f = Math.floor(frac * nominal);
      }
    } else {
      const totalFrames = Math.floor(t * fps + 1e-9);
      h = Math.floor(totalFrames / (nominal * 3600));
      m = Math.floor(totalFrames / (nominal * 60)) % 60;
      s = Math.floor(totalFrames / nominal) % 60;
      f = totalFrames % nominal;
    }

    f = Math.min(nominal - 1, Math.max(0, f));
    return `${pad(h)}:${pad(m)}:${pad(s)}${dropCount ? ';' : ':'}${pad(f)}`;
  }

  /** 总帧数 */
  function frameCount(t, fps) {
    return Math.round(t * fps).toLocaleString('en-US');
  }

  /** 小节.拍.tick（1/480 拍），方便配乐对格子 */
  function barsBeats(t, bpm, beatsPerBar, offset) {
    const safeBpm = bpm > 0 ? bpm : 120;
    const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
    const beats = ((t - (offset || 0)) * safeBpm) / 60;
    const totalBeats = Math.floor(beats);
    const bar = Math.floor(totalBeats / bpb) + 1;
    const beat = totalBeats % bpb + 1;
    const tick = Math.floor((beats - totalBeats) * 480);
    const sign = beats < 0 ? '-' : '';
    return `${sign}${pad(Math.abs(bar), 3)}.${beat}.${pad(tick, 3)}`;
  }

  /** 采样数 */
  function samples(t, sampleRate) {
    if (!sampleRate) return '—';
    return Math.round(t * sampleRate).toLocaleString('en-US');
  }

  /** 35mm 4 孔影片：英尺+格（16 格 = 1 英尺） */
  function feetFrames(t, fps) {
    const frames = Math.round(t * fps);
    const feet = Math.floor(frames / 16);
    return `${feet.toLocaleString('en-US')}+${pad(frames % 16)}`;
  }

  /* ---------------- 格式注册表 ---------------- */
  const FORMATS = {
    tc: {
      label: '时间码',
      hint: (ctx) => `${ctx.fpsLabel}${ctx.drop ? ' DF' : ''}`,
      fn: (t, ctx) => timecode(t, ctx.fps, ctx.drop),
    },
    hms: {
      label: '时:分:秒.毫秒',
      hint: () => '',
      fn: (t) => hhmmssms(t),
    },
    ms: {
      label: '分:秒.毫秒',
      hint: () => '',
      fn: (t) => mmssms(t),
    },
    sec: {
      label: '秒',
      hint: () => '十进制',
      fn: (t) => seconds(t),
    },
    frames: {
      label: '总帧数',
      hint: (ctx) => `${ctx.fps} fps`,
      fn: (t, ctx) => frameCount(t, ctx.fps),
    },
    bars: {
      label: '小节.拍.tick',
      hint: (ctx) => `${ctx.bpm} BPM · ${ctx.beatsPerBar}/4`,
      fn: (t, ctx) => barsBeats(t, ctx.bpm, ctx.beatsPerBar, ctx.bpmOffset),
    },
    samples: {
      label: '采样',
      hint: (ctx) => (ctx.sampleRate ? `${(ctx.sampleRate / 1000).toFixed(1)} kHz` : '待载入'),
      fn: (t, ctx) => samples(t, ctx.sampleRate),
    },
    feet: {
      label: '英尺+格',
      hint: () => '35mm',
      fn: (t, ctx) => feetFrames(t, ctx.fps),
    },
  };

  /** 从 settings 组装上下文，避免每帧重复解析 */
  function buildContext(settings, sampleRate) {
    const f = resolveFps(settings);
    return {
      fps: f.fps,
      drop: f.drop,
      fpsLabel: f.label,
      bpm: settings.bpm || 120,
      beatsPerBar: settings.beatsPerBar || 4,
      bpmOffset: settings.bpmOffset || 0,
      sampleRate: sampleRate || 0,
    };
  }

  /** 当前主格式的标题（含 fps 提示），用于 HUD 抬头 */
  function primaryTitle(settings, ctx) {
    const id = settings.primaryFormat || 'tc';
    const f = FORMATS[id] || FORMATS.tc;
    if (id === 'tc') return `TIMECODE · ${ctx.fpsLabel}${ctx.drop ? ' DF' : ''}`;
    return `${f.label} · ${f.hint(ctx)}`;
  }

  global.TDFormat = {
    FRAME_PRESETS,
    FORMATS,
    presetById,
    resolveFps,
    buildContext,
    primaryTitle,
    timecode,
    hhmmssms,
    mmssms,
  };
})(window);
