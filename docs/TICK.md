# tick 是怎么算的（以及为什么不用毫秒）

> 代码：`src/shared/barbeat.js`（纯函数内核）、`src/renderer/src/audio/time.js`（渲染层唯一口径）
> 单测：`tests/barbeat.test.mjs`
> 数据结构：`docs/schema-log.md`、`data/tracks/*.json`

## 1. 三个坐标系

| 坐标 | 谁在用 | 单位 | 会不会随速度/拍号变 |
|---|---|---|---|
| **tick** | JSON 存的位置（事件、段落、调性、拍号标记） | 1/ppq 个四分音符 | 不变，是唯一真相 |
| **bar / beat / off** | 界面（刻度、状态栏、详情表） | 小节 / 拍 / 拍内 tick | 由 tick + 拍号算出来 |
| **ms** | 音频（播放头、波形、歌词时间轴） | 毫秒 | 由 tick + 速度表 + 偏移算出来 |

一句话：**JSON 里只存 tick；bar/beat 和 ms 都是「投影」**。这样换速度、换拍号、
换录音版本（只改 `audioOffsetMs`）都不需要动数据。

## 2. 依据的字段

| 字段 | 位置 | 作用 |
|---|---|---|
| `timeline.ppq` | 分析档案 | 每四分音符多少 tick，默认 **480**。整个换算的分辨率 |
| `basic.meter`（`3/4`）/ `markers[kind=meter]` | `num` / `den` | 一小节多少 tick。**未标注时整条链为空，按 4/4 兜底**（决定 56） |
| `basic.bpm` / `markers[kind=tempo].bpm` | 速度 | tick ↔ 毫秒。**未标注时按 120 兜底**（决定 56） |
| `timeline.audioOffsetMs`（逐录音版本） | 偏移 | 第 1 小节落在音频的哪个毫秒 |
| `timeline.sections[].tick` | 段落 | **只存 tick**（schema v4 起没有 `bar`） |
| `timeline.keys[].tick`、`events[].tick` / `durTicks` | 调性、事件 | 位置与长度 |

## 3. 一小节 / 一拍多长

```
beatTicks = ppq × 4 / den          // 一拍 = 一个「分母音符」
barLen    = beatTicks × num        // = ppq × num × 4 / den
```

`ppq = 480` 时：

| 拍号 | 一拍 | 一小节 |
|---|---|---|
| 4/4 | 480 | 1920 |
| 3/4 | 480 | **1440** |
| 2/4 | 480 | 960 |
| 6/8 | 240 | 1440 |
| 6/4 | 480 | 2880 |

注意：**分母决定「拍」是什么音符**。同样是 1440 tick，3/4 是「3 拍 × 480」，
6/8 是「6 拍 × 240」—— 这就是为什么 tick 比「拍序号」稳：它不随记谱单位改变。

## 4. 变拍号：先把每段起始小节算好

`computeStartBars(meters, ppq)`：

```
barLen_i   = ppq × num_i × 4 / den_i
startBar_1 = 1
startBar_i = startBar_{i-1} + ceil((tick_i − tick_{i−1}) / barLen_{i−1})
```

`ceil` 是刻意的：**中途变拍时，上一段末尾的残拍归上一段**，新拍号从整小节开始。
否则会出现「第 12 小节只有 2 拍」这种既画不准也算不清的状态。

> 神鹿谣**没有**变拍号：全程 3/4，只有一条 tick 0 的 meter 标记。
> 第 12 小节（tick 15840）是 **A1 段**的起点，不是「3/4 从这里开始」。

## 5. tick → bar / beat / 拍内偏移

```
m    = 最后一个 tick ≤ 目标 的拍号标记
rel  = max(0, tick − m.tick)
bar  = m.startBar + floor(rel / m.barLen)
beat = floor((rel % m.barLen) / beatTicks) + 1
off  = (rel % m.barLen) % beatTicks          // 0 … beatTicks−1
```

反查 `barToTick()`：取该小节所在段的拍号，

```
tick = m.tick + (bar − m.startBar) × m.barLen
```

## 6. tick ↔ 毫秒：必须分段积分

速度是分段常量，所以不能「整体乘一个 BPM」：

```
ms(tick) = Σ_段 (该段内的 tick 数 / ppq) × (60000 / 该段 bpm)
音频位置(ms) = audioOffsetMs + ms(tick)
```

`msToTick()` 是它的反函数（播放头落在哪一格全靠它），**允许返回负数**：
音频比第 1 小节晚开始时，播放头本来就该停在原点左侧。

## 7. 一个真实例子（神鹿谣）

```
ppq = 480，拍号 3/4（全程），bpm = 107，ppq 单位 = 四分音符
beatTicks = 480
barLen    = 480 × 3 × 4 / 4 = 1440
一拍     = 60000 / 107 ≈ 560.75 ms
一小节   = 3 × 560.75 ≈ 1682.24 ms
```

| tick | bar / beat | 相对音频（offset 0） |
|---|---|---|
| 0 | 1 / 1 | 0 ms |
| 1440 | 2 / 1 | 1682.2 ms |
| 15840 | 12 / 1（A1 段起点） | 18504.8 ms |
| 16320 | 12 / 2 | 19065.5 ms |
| 16800 | 12 / 3 | 19626.2 ms |

加上默认录音版本 `audioOffsetMs = −1630`（磁带转录版前面有走带声）：
第 12 小节首拍落在音频 **16874.8 ms**。**偏移是逐版本的**，换一版这个数就变，
而上面的 tick 一个都不动 —— 这正是把位置存成 tick 的价值。

## 8. 常见误解 / 坑

1. **「第 12 小节 = 15840」不是巧合**：`15840 = 11 × 1440`，只有在 3/4 下才成立。
   同一首若改成 4/4，第 12 小节就是 `11 × 1920 = 21120`。
2. **负偏移合法**：`audioOffsetMs < 0` 表示第 1 小节比音频开头晚 —— 播放头出现在原点左侧是对的，
   不要把它 clamp 到 0（那会让整条对齐整体偏掉）。
3. **ppq 不是随便写的**：导入器生成的档案是 480；手写 JSON 若写成 960，
   同一段音乐的 tick 数会翻倍，事件位置全部错位。
4. **段落不再存小节数**（schema v4）：`sections[].bar` 已经删掉，只剩 `tick`。
   小节号是「tick + 拍号链」的投影，写进档案就等于存了第二份真相 ——
   改了拍号之后它立刻过期，而没人会记得同步。写了 `bar` 的档案由
   `tests/trackjson.test.mjs` 直接判红，`seed` 也只认 `tick`（并在控制台点名那个文件）。
5. **播放头像素**：`x = (tick 相对视口起点) × pxPerTick`，缩放只改 `pxPerBar`，
   不要反过来用像素算 tick（会积累取整误差）。
