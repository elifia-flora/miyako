#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
music-atlas 启动器 —— 让 start.cmd 能被固定到 Windows 任务栏。

为什么 start.cmd 固定不了
--------------------------
Windows 任务栏上的一「项」= 可执行文件 + AppUserModelID(AUMID)。
批处理的宿主是 conhost.exe，图标和窗口分组全归它；应用自己顶不出独立身份。
就算手动给 .cmd 建快捷方式，任务栏上出现的也永远是「命令提示符」。

本脚本
------
1. 构建检查 —— 缺 `out/main/index.js` 就先 `electron-vite build`；
2. 拉起 start.cmd，全程 `CREATE_NEW_PROCESS_GROUP` 且**不开新控制台**，
   从任务栏点进来不会闪一个黑框；
3. 启动后查 `logs/boot.log` —— 没有控制台时 start.cmd 末尾的 `pause` 直接返回，
   「启动失败」和「启动成功」在这里长得一模一样，必须主动验；
4. `--install-shortcut` 生成带正确图标的 .lnk 到桌面 / 开始菜单 / 任务栏固定目录。

快捷方式为什么直接指向 electron.exe
-----------------------------------
任务栏的窗口归组规则是「先比 AUMID，再比可执行文件路径」。
所以最省事、也最不容易出岔子的做法是让快捷方式**直接指向 electron.exe**
（路径一致 → 必定归到一个图标下），图标单独用 IconLocation 指定。

如果让快捷方式指向 pythonw.exe + 本脚本，就得让 .lnk 带上 AUMID 才能归组，
而写 AUMID 必须走 IShellLink + IPropertyStore 的 COM 互操作 —— 复杂且容易静默失败。
直接指向 electron.exe 换来的稳定，值得放弃「点快捷方式时自动构建」这一步
（`python start.py` 仍然带构建检查，日常开发用它即可）。

用法
----
    python start.py                      # 启动（等价于双击 start.cmd）
    python start.py --install-shortcut   # 生成快捷方式（桌面 / 开始菜单 / 任务栏）
    python start.py --uninstall-shortcut
    python start.py --rebuild            # 重新构建后再启动
    python start.py --launcher <路径>    # 指定被拉起的脚本（默认 start.cmd）
"""

from __future__ import annotations

import argparse
import ctypes
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
START_CMD = ROOT / "start.cmd"
ELECTRON_EXE = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
BUILD_ENTRY = ROOT / "out" / "main" / "index.js"
ICON = ROOT / "assets" / "app.ico"
SHORTCUT_NAME = "music·atlas.lnk"


# --------------------------------------------------------------------------- 报错

def _msgbox(text: str, title: str = "music-atlas", *, error: bool = True) -> None:
    """无控制台环境下唯一的报错通道。任务栏启动时 stderr 是空的，不弹窗等于静默失败。"""
    try:
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x10 if error else 0x40)
    except Exception:
        print(text, file=sys.stderr)


def die(text: str, code: int = 1) -> None:
    _msgbox(text)
    sys.exit(code)


# ----------------------------------------------------------------------- 环境检查

def _is_running() -> bool:
    """是否已有 electron 实例在跑。在跑就再启一次 —— 单实例锁负责把老窗口抬到前台。

    只看进程名，不解码内容：tasklist 的输出是系统 ANSI 代码页（中文机器 GBK），
    用 utf-8 去解会抛 UnicodeDecodeError，顺手把整个启动器带崩。
    """
    try:
        proc = subprocess.run(
            ["tasklist", "/fi", "IMAGENAME eq electron.exe", "/nh"],
            capture_output=True, timeout=10,
        )
    except Exception:
        return False
    return b"electron.exe" in proc.stdout.lower()


def _run_text(argv: list[str], cwd: Path, timeout: int) -> tuple[int, str]:
    """跑一个命令并把输出读成文本。

    不用 text=True：子进程按系统 ANSI 代码页输出（中文机器 GBK），
    而 Python 会按 encoding 参数去解 —— 解不动就在读取线程里抛
    UnicodeDecodeError，proc.stdout 直接变成 None，调用方跟着 AttributeError。
    errors='replace' + 自己解，是唯一不会崩的写法。
    """
    proc = subprocess.run(argv, cwd=str(cwd), capture_output=True, timeout=timeout)
    out = (proc.stdout or b"").decode("utf-8", "replace")
    err = (proc.stderr or b"").decode("utf-8", "replace")
    return proc.returncode, out + err


def ensure_electron() -> None:
    """Electron 42 起，二进制是**按需下载**的：`npm install` 之后 `dist/` 可能还不存在。

    这一步替用户把它下下来（一次性，约 100MB）。不这么做的话，双击快捷方式只会看到
    一个 `FileNotFoundError` —— 而那行报错完全看不出「少了个下载」。
    """
    if ELECTRON_EXE.exists():
        return
    installer = ROOT / "node_modules" / "electron" / "install.js"
    if not installer.exists():
        die("[music-atlas] 缺少 electron，请先在项目目录执行：\n\n    npm install\n")
    print("[music-atlas] 首次运行，正在下载 Electron（约 100MB，只这一次）…", flush=True)
    rc, text = _run_text(["node", str(installer)], ROOT, timeout=1800)
    if rc != 0 or not ELECTRON_EXE.exists():
        die("[music-atlas] Electron 下载失败：\n\n" + text[-1500:])


def ensure_build(force: bool = False) -> None:
    """out/main/index.js 是 electron-vite 的产物，缺了就先构建。"""
    if BUILD_ENTRY.exists() and not force:
        return
    ensure_electron()
    print("[music-atlas] 正在构建…", flush=True)
    rc, text = _run_text(["npx.cmd", "electron-vite", "build"], ROOT, timeout=600)
    if rc != 0:
        die("[music-atlas] 构建失败：\n\n" + text[-2500:])
    if not BUILD_ENTRY.exists():
        die("[music-atlas] 构建结束但没有产出 out/main/index.js，请检查上面的输出。")


# ------------------------------------------------------------------------- 启动

def launch(script: Path) -> None:
    """拉起指定的启动脚本。"""
    ensure_electron()
    env = dict(os.environ)
    # 编辑器 / 终端常注入 ELECTRON_RUN_AS_NODE=1，泄漏进去 electron.exe 会退化成纯 Node，
    # 报 "whenReady of undefined"。start.cmd 里也清了，这里保持一致。
    env.pop("ELECTRON_RUN_AS_NODE", None)

    if _is_running():
        # 已在运行：不走 start.cmd，直接再拉一次，单实例锁会把老窗口抬到前台
        subprocess.Popen([str(ELECTRON_EXE), str(ROOT)], cwd=str(ROOT), env=env, close_fds=True)
        return

    try:
        subprocess.Popen(
            ["cmd.exe", "/c", str(script)],
            cwd=str(ROOT), env=env, close_fds=True,
            # 只开新进程组，**不开新控制台**：从任务栏点进来不该闪一个黑框
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    except OSError as e:
        die(f"[music-atlas] 无法启动 {script.name}：\n\n{e}")

    time.sleep(3.2)
    log = ROOT / "logs" / "boot.log"
    if not log.exists():
        return
    try:
        text = log.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    if "shown visible=true" not in text:
        die("[music-atlas] 启动失败，窗口没有出现。日志：\n\n" + text[-2500:])


# ------------------------------------------------------------------- 快捷方式

def _dirs() -> list[Path]:
    appdata = Path(os.environ.get("APPDATA", ""))
    userprofile = Path(os.environ.get("USERPROFILE", ""))
    return [
        ROOT,
        userprofile / "Desktop",
        appdata / "Microsoft" / "Windows" / "Start Menu" / "Programs",
        # shell:User Pinned\TaskBar —— 「固定到任务栏」写的就是这个目录
        appdata / "Microsoft" / "Internet Explorer" / "Quick Launch" / "User Pinned" / "TaskBar",
    ]


def _ps_quote(s) -> str:
    """PowerShell 单引号串：内部单引号写成两个。"""
    return "'" + str(s).replace("'", "''") + "'"


def _powershell(script: str, timeout: int = 60) -> str:
    """跑一段 PowerShell 并回传输出。

    两个坑都在这里：
    1. 写临时文件而非 -Command —— 命令行引号转义地狱；
    2. **必须带 BOM**（utf-8-sig）。PowerShell 5.1 在没有 BOM 时按系统 ANSI 代码页
       （中文机器是 GBK）读 .ps1，脚本里的 '·'(U+00B7) 会被解成 '路'(U+8DEF)，
       快捷方式就悄悄存成了 music路atlas.lnk —— 看起来「创建成功」，其实名字全错。
    """
    with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False, encoding="utf-8-sig") as f:
        f.write(script)
        path = f.name
    try:
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-File", path],
            capture_output=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return "PowerShell 超时"
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    # PowerShell 自己也按 ANSI 代码页写输出，同样不能交给 Python 去按 utf-8 解
    return ((proc.stdout or b"").decode("utf-8", "replace")
            + (proc.stderr or b"").decode("utf-8", "replace")).strip()


def make_lnk(dest: Path) -> str:
    """建一个 .lnk：直接指向 electron.exe，参数是应用目录。

    这里不用「%~dp0.」那种尾点写法 —— 那是给 cmd.exe 用的（引号转义问题）；
    subprocess 走参数数组，不经 cmd 解析，直接传 ROOT 即可。
    """
    ps = f"""
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut({_ps_quote(str(dest))})
$sc.TargetPath       = {_ps_quote(str(ELECTRON_EXE))}
$sc.Arguments        = {_ps_quote(str(ROOT))}
$sc.WorkingDirectory = {_ps_quote(str(ROOT))}
$sc.WindowStyle      = 7
$sc.IconLocation     = {_ps_quote(str(ICON))}
$sc.Description      = 'music·atlas'
$sc.Save()
Write-Output 'OK'
"""
    return _powershell(ps)


def install_shortcut() -> None:
    if not ELECTRON_EXE.exists():
        die("[music-atlas] 缺少 electron 二进制。先跑一次 python start.py 让它自动下载，再建快捷方式。")
    if not BUILD_ENTRY.exists():
        die("[music-atlas] 还没有构建产物，请先执行：\n\n    python start.py\n")
    if not ICON.exists():
        die("[music-atlas] 找不到图标 assets/app.ico\n请先执行：python tools/make_icon.py")

    made, last = [], ""
    for folder in _dirs():
        if not folder.is_dir():
            continue
        dest = folder / SHORTCUT_NAME
        last = make_lnk(dest)
        if last.endswith("OK"):
            made.append(str(dest))
        else:
            print(f"[music-atlas] {dest} 创建失败：{last[-400:]}", file=sys.stderr)

    if not made:
        die("[music-atlas] 创建快捷方式失败：\n\n" + last[-1200:])

    print("[music-atlas] 已创建快捷方式：")
    for m in made:
        print("   ", m)
    print("\n任务栏上没出现图标的话：右键桌面上的 music·atlas.lnk → 固定到任务栏。")
    print("图标没刷新就重启一次 explorer.exe。")


def uninstall_shortcut() -> None:
    removed = []
    for folder in _dirs():
        p = folder / SHORTCUT_NAME
        if p.exists():
            try:
                p.unlink()
                removed.append(str(p))
            except OSError as e:
                print(f"[music-atlas] 无法删除 {p}：{e}", file=sys.stderr)
    for m in removed:
        print("removed", m)
    print("[music-atlas] 没有找到快捷方式，无需清理。" if not removed else "")
    if removed:
        # 固定项删掉后 explorer 可能还留着图标缓存
        _powershell("Stop-Process -Name explorer -Force; Start-Sleep -Milliseconds 900; "
                    "Start-Process explorer.exe")


# ---------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description="music-atlas 启动器")
    ap.add_argument("--install-shortcut", action="store_true", help="生成快捷方式并固定到任务栏")
    ap.add_argument("--uninstall-shortcut", action="store_true", help="移除快捷方式")
    ap.add_argument("--rebuild", action="store_true", help="重新构建后再启动")
    ap.add_argument("--launcher", default=str(START_CMD), help="被拉起的启动脚本")
    ap.add_argument("--no-build", action="store_true", help="跳过构建检查")
    args = ap.parse_args()

    if args.install_shortcut:
        install_shortcut()
        return 0
    if args.uninstall_shortcut:
        uninstall_shortcut()
        return 0

    script = Path(args.launcher).resolve()
    if not script.exists():
        die(f"[music-atlas] 找不到启动脚本：{script}")
    if not args.no_build:
        ensure_build(force=args.rebuild)
    launch(script)
    return 0


if __name__ == "__main__":
    sys.exit(main())