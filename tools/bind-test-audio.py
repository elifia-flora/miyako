#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 assets/ 里的试听素材挂到几部作品下面，方便验证「多版本树 / 调顺序 / 双击试听」。

只做 INSERT，不改也不删任何已有行；跑第二遍会因为 id 已存在而全部跳过（幂等）。

用法（**必须先退出应用**，否则 SQLite 是 WAL 活跃态、写入会 SQLITE_BUSY，
而且应用内的旧连接看不到外部改动）：

    python tools/bind-test-audio.py            # 绑定
    python tools/bind-test-audio.py --dry-run  # 只打印要做什么

素材现状：assets/ 里只有 4 个 ringtone-*.mp3（接听 / 来电 / 拨出 / 挂断），
真正的音乐文件是 2 个 .flac（已经在库里了）。所以这里是「拿铃声占位」，
目的是让界面出现 3 版 / 2 版 / 单版本的树，不是真的音乐分析。
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import struct
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "data", "atlas.db")
ASSETS = os.path.join(ROOT, "assets")

# ---- 挂载方案：(曲名, 要追加的音频文件, 版本名) ---------------------------------
# 曲名用的是库里的 track.title；找不到就跳过并报告，不猜。
PLAN: list[tuple[str, str, str]] = [
    ("神鹿谣", "ringtone-accept.mp3", "铃声素材 · 接听"),
    ("神鹿谣", "ringtone-caller.mp3", "铃声素材 · 拨出"),
    ("The deepest nightmare of Sibyl", "ringtone-callee.mp3", "铃声素材 · 来电"),
    ("灰ト祈リ", "ringtone-hangup.mp3", "铃声素材 · 挂断"),
    ("虚构测试数据 · 定音鼓的滚奏", "ringtone-accept.mp3", "铃声素材 · 接听"),
    ("虚构测试数据 · 定音鼓的滚奏", "ringtone-caller.mp3", "铃声素材 · 拨出"),
]

# ---- MP3 帧头解析（与 src/shared/audiofile.js 的 probeMp3 同一套表） -------------
BITRATES = {
    "v1l1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    "v1l2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    "v1l3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    "v2l1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    "v2l2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    # MPEG2 / 2.5 的 Layer II 与 Layer III 共用这张表
    "v2l3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def probe_mp3(path: str) -> dict:
    """返回 {duration_ms, sample_rate, channels}；解析不出来就给 0，不抛。"""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        head = f.read(65536)
    b = head
    p = 0
    tag = 0
    if b[0:3] == b"ID3" and len(b) > 10:
        tag = 10 + ((b[6] & 0x7F) << 21) + ((b[7] & 0x7F) << 14) + ((b[8] & 0x7F) << 7) + (b[9] & 0x7F)
        p = tag
    while p + 4 < len(b) and not (b[p] == 0xFF and (b[p + 1] & 0xE0) == 0xE0):
        p += 1
    if p + 4 >= len(b):
        return {"duration_ms": 0, "sample_rate": 0, "channels": 0}

    h1, h2, h3 = b[p + 1], b[p + 2], b[p + 3]
    ver = (h1 >> 3) & 0x03
    layer_bits = (h1 >> 1) & 0x03
    br_idx = (h2 >> 4) & 0x0F
    sr_idx = (h2 >> 2) & 0x03
    ch_mode = (h3 >> 6) & 0x03

    rates = RATES.get(ver)
    sample_rate = rates[sr_idx] if rates and sr_idx < len(rates) else 0
    group = "v1" if ver == 3 else "v2"
    layer = "l1" if layer_bits == 3 else "l2" if layer_bits == 2 else "l3"
    table = BITRATES.get(group + layer, BITRATES.get(group + "l3"))
    kbps = table[br_idx] if table and 0 < br_idx < 15 else 0

    duration = 0
    if sample_rate and kbps:
        duration = round((size - tag) * 8 * 1000 / (kbps * 1000))
    return {
        "duration_ms": duration,
        "sample_rate": sample_rate,
        "channels": 1 if ch_mode == 3 else 2,
    }


def slug(text: str) -> str:
    """稳定 id 片段：同名同曲目重跑会得到同一个 id，靠它做幂等。"""
    keep = [c for c in text.lower() if c.isalnum()]
    return "".join(keep)[:24] or "x"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写库")
    args = ap.parse_args()

    if not os.path.exists(DB):
        print(f"找不到数据库：{DB}", file=sys.stderr)
        return 2

    # timeout 是给 WAL 锁用的：应用还开着就明确报错，不静默重试
    try:
        db = sqlite3.connect(DB, timeout=5)
    except sqlite3.Error as e:
        print(f"打不开数据库（应用还开着？先退出）：{e}", file=sys.stderr)
        return 3
    db.row_factory = sqlite3.Row

    now = int(time.time() * 1000)
    added = skipped = missing_track = missing_file = 0

    for title, filename, label in PLAN:
        src = os.path.join(ASSETS, filename)
        if not os.path.exists(src):
            print(f"  跳过：素材不存在 {filename}")
            missing_file += 1
            continue

        row = db.execute(
            "SELECT id FROM track WHERE title = ? AND deleted_at IS NULL", (title,)
        ).fetchone()
        if not row:
            print(f"  跳过：库里没有曲目「{title}」")
            missing_track += 1
            continue
        track_id = row["id"]

        rec_id = f"rec-bind-{slug(title)}-{slug(filename)}"
        if db.execute("SELECT 1 FROM recording WHERE id = ?", (rec_id,)).fetchone():
            print(f"  已存在：{title} ← {label}")
            skipped += 1
            continue

        info = probe_mp3(src)
        # 追加到末尾：用 MAX+1，不是 COUNT —— 顺序被调整过之后 seq_order 会有空号，
        # 用条数当序号会把新版本插到第一条前面（踩过：铃声版顶掉了原来的 flac）
        last = db.execute(
            "SELECT MAX(seq_order) m FROM recording WHERE track_id = ? AND deleted_at IS NULL",
            (track_id,),
        ).fetchone()["m"]
        seq = (last + 1) if isinstance(last, int) else 0

        print(
            f"  + {title} ← {label}  ({filename}, {info['duration_ms']} ms, seq_order={seq})"
        )
        if args.dry_run:
            added += 1
            continue

        db.execute(
            """INSERT INTO recording
                 (id, track_id, performers, credits_json, orchestra, conductor, soloist,
                  recording_place, recorded_year, mix_engineer, mastering_engineer, label,
                  catalog_no, release_year, file_path, duration_ms, format, sample_rate,
                  channels, bits, is_default, note, link, seq_order, added_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                rec_id, track_id, "[]", "{}", "", "", "", "", None, "", "", label,
                "", None, src.replace("\\", "/"), info["duration_ms"], "mp3",
                info["sample_rate"], info["channels"], 0, 0, "", "", seq, now, now,
            ),
        )
        added += 1

    if args.dry_run:
        print(f"\n[dry-run] 将新增 {added} 条；已存在 {skipped}；缺曲目 {missing_track}；缺素材 {missing_file}")
        return 0

    # ---- 按新规则重算「主播放位」：顺序里第一条有文件的 ----
    # 只有真的新增过才动，避免无谓地改 track.updated_at
    if added:
        tracks = {r["track_id"] for r in db.execute(
            "SELECT track_id FROM recording WHERE id LIKE 'rec-bind-%' AND deleted_at IS NULL"
        )}
        for track_id in tracks:
            recs = db.execute(
                """SELECT id, file_path FROM recording
                    WHERE track_id = ? AND deleted_at IS NULL ORDER BY seq_order, seq""",
                (track_id,),
            ).fetchall()
            first = next(
                (r for r in recs if r["file_path"] and os.path.exists(r["file_path"])), recs[0]
            )
            # 先清零再置 1：is_default 上有 partial unique index，一条 CASE WHEN 会撞索引
            db.execute(
                "UPDATE recording SET is_default = 0 WHERE track_id = ? AND is_default = 1",
                (track_id,),
            )
            db.execute("UPDATE recording SET is_default = 1 WHERE id = ?", (first["id"],))
            # 主文件指针只在「第一首确实有文件」时写；否则保留原值，别把能播的歌弄成不能播
            if first["file_path"] and os.path.exists(first["file_path"]):
                db.execute(
                    "UPDATE track SET file_path = ?, updated_at = ? WHERE id = ?",
                    (first["file_path"], now, track_id),
                )
        db.commit()

    print(
        f"\n完成：新增 {added} 条，跳过 {skipped} 条；缺曲目 {missing_track}，缺素材 {missing_file}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
