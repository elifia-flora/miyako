# 从 TallyDeck 搬过来的参考实现

这里放的是 `../../测试，试玩/music-player/`（TallyDeck 播放器）里已经验证过的两个模块，
**只是参考，还没接进构建**。等做音频播放时按这里的思路重写/改造。

| 文件 | 能复用什么 |
|---|---|
| `format.js` | 8 种时间格式（时间码 / 分:秒.毫秒 / 采样 / 小节.拍.tick）；DF/NDF 时间码算法（23.976、29.97 漂移是正确行为） |
| `wave.js` | 多级 min/max 峰值金字塔 + 灰/热两张离屏位图，每帧 2 次 drawImage；`probeSampleRate()` 读 WAV/AIFF/FLAC 头再解码，拿到文件自身采样数 |
| `TallyDeck-dev-report.md` | 11 个踩过的坑（Electron 32 移除 `File.path`、`decodeAudioData` 隐式重采样、`[hidden]` 被覆盖、CSP `media-src` 等） |

注意：TallyDeck 是「零框架、零构建」的原生 JS，这里是 Vue + Vite，
搬过来要改成 ES module 引入，DOM 操作部分换成 Vue 的 ref。
