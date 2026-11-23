# clean-junk.ps1 - 清理冒烟 / 调试留下的「可再生成」产物
#
# 这个脚本**只给用户手动跑**：自动化（AI）不执行任何删除，它只负责把清单写进 JUNK.md。
# 默认**只列清单**，一个文件都不动。加 -Apply 才真的删，而且默认送进回收站
# （不是硬删，误删还能捞回来）。清单与影响见仓库根目录的 JUNK.md。
#
#   .\tools\clean-junk.ps1                    只列清单
#   .\tools\clean-junk.ps1 -Apply              删除默认项（进回收站），**每种副本留最新 3 份**
#   .\tools\clean-junk.ps1 -Apply -All         连最新那几份一起清（`shots\` 仍要 -IncludeShots）
#   .\tools\clean-junk.ps1 -Apply -IncludeShots  连同 shots\ 的截图一起
#   .\tools\clean-junk.ps1 -Apply -HardDelete   不进回收站，直接删
#
# 白名单式实现：只认下面 $Items 里写死的名字，绝不接受外部传入的路径。

[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$IncludeShots,
  [switch]$HardDelete,
  [switch]$All
)

$ErrorActionPreference = 'Stop'

# 只在**输出被重定向**时才改成 UTF-8：
#   - 真实控制台窗口：Write-Host 走 Unicode 控制台 API，本来就对，别去动编码
#   - 重定向到文件 / 管道：默认按 OEM 代码页（中文机 936）编码，按 UTF-8 打开就是乱码
try {
  if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 }
} catch { }

# 仓库根目录 = 本脚本所在目录的上一级
$root = Split-Path -Parent $PSScriptRoot
$rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\')

function Get-SizeText([long]$bytes) {
  if ($bytes -ge 1MB) { return ('{0:N1} MB' -f ($bytes / 1MB)) }
  if ($bytes -ge 1KB) { return ('{0:N0} KB' -f ($bytes / 1KB)) }
  return ('{0} B' -f $bytes)
}

# kind: dir = 整个目录；dirglob = 目录名前缀（冒烟的 -2/-3 编号副本）；file = 单个文件
$Items = @(
  @{ Name = '.smoke-data';      Kind = 'dirglob'; Note = '冒烟时 data 的副本（含 -2/-3…）'; Default = $true;  Shots = $false },
  @{ Name = '.smoke-profile';   Kind = 'dirglob'; Note = '冒烟的独立 userData（含 -2/-3…）'; Default = $true;  Shots = $false },
  @{ Name = '.verify-profile';  Kind = 'dirglob'; Note = '一次性校验留下的 userData';       Default = $true;  Shots = $false },
  @{ Name = 'logs';             Kind = 'dir';     Note = '运行日志（boot.log 等）';         Default = $true;  Shots = $false },
  @{ Name = 'shots';            Kind = 'dir';     Note = '冒烟截图（可重新生成）';          Default = $false; Shots = $true  }
)

# 每族副本最多留几份（用户定的规矩：冒烟数据 / 配置各留 3 份）。
# 留的是**最新的**那几份 —— 刚跑过的那几轮才可能还要看。
$Keep = 3

# ---- 1) 盘点 ----
Write-Host ''
Write-Host 'music-atlas 可清理产物' -ForegroundColor Cyan
Write-Host ("仓库：{0}" -f $rootFull)
Write-Host ''

$plan = @()
$totalBytes = 0
foreach ($it in $Items) {
  $p = Join-Path $rootFull $it.Name
  $exists = $false
  $bytes = 0
  if ($it.Kind -eq 'dirglob') {
    # 前缀匹配：.smoke-data、.smoke-data-2、.smoke-data-3 …；新的排在前面
    $dirs = @(Get-ChildItem -LiteralPath $rootFull -Directory -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq $it.Name -or $_.Name.StartsWith($it.Name + '-') } |
      Sort-Object LastWriteTime -Descending)
    $idx = 0
    foreach ($d in $dirs) {
      $idx++
      $sum = Get-ChildItem -LiteralPath $d.FullName -Recurse -Force -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
      $b = if ($sum -and $sum.Sum) { [long]$sum.Sum } else { 0 }
      # 只有「排在第 Keep 名之后」的旧副本才删；-All 时全删
      $pick = $it.Default -and ($All -or $idx -gt $Keep)
      $note = $it.Note
      if (-not $pick -and $idx -le $Keep) { $note = '最新的一份，留着' }
      $plan += [pscustomobject]@{
        Name = $d.Name; Path = $d.FullName; Kind = 'dir'; Bytes = $b; Pick = $pick; Note = $note
      }
      if ($pick) { $totalBytes += $b }
    }
    continue
  }
  if ($it.Kind -eq 'dir') {
    $exists = Test-Path -LiteralPath $p -PathType Container
    if ($exists) {
      $sum = Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
      if ($sum -and $sum.Sum) { $bytes = [long]$sum.Sum }
    }
  } else {
    $exists = Test-Path -LiteralPath $p -PathType Leaf
    if ($exists) { $bytes = (Get-Item -LiteralPath $p).Length }
  }
  if (-not $exists) { continue }

  $picked = $it.Default
  if ($IncludeShots -and $it.Shots) { $picked = $true }

  $plan += [pscustomobject]@{
    Name   = $it.Name
    Path   = $p
    Kind   = $it.Kind
    Bytes  = $bytes
    Pick   = $picked
    Note   = $it.Note
  }
  if ($picked) { $totalBytes += $bytes }
}

if ($plan.Count -eq 0) {
  Write-Host '没有可清理的东西。' -ForegroundColor Green
  exit 0
}

# 不用 -f 定宽：中文是双宽字符，PadRight 出来的列在真控制台里照样歪
foreach ($row in $plan) {
  $mark = '跳过'
  $color = 'DarkGray'
  if ($row.Pick) { $mark = '删除'; $color = 'Yellow' }
  $size = Get-SizeText $row.Bytes
  $line = '  [' + $mark + '] ' + $row.Name + '  (' + $size + ')  ' + $row.Note
  Write-Host $line -ForegroundColor $color
}

Write-Host ''
Write-Host ("合计：{0}" -f (Get-SizeText $totalBytes)) -ForegroundColor Cyan
if (-not $IncludeShots -and -not ($plan | Where-Object { $_.Name -eq 'shots' -and $_.Pick })) {
  $hasShots = $plan | Where-Object { $_.Name -eq 'shots' }
  if ($hasShots) {
    Write-Host ("（shots\ 里的 {0} 张截图未计入；要一起清就加 -IncludeShots）" -f (Get-ChildItem -LiteralPath (Join-Path $rootFull 'shots') -File -ErrorAction SilentlyContinue).Count)
  }
}

# ---- 2) 除非 -Apply，到此为止 ----
if (-not $Apply) {
  Write-Host ''
  Write-Host '这是预演，什么都没删。真删：' -ForegroundColor Cyan
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File tools\clean-junk.ps1 -Apply'
  Write-Host '  （默认送回收站，误删能捞回来；加 -IncludeShots 连截图一起）'
  exit 0
}

# ---- 3) 删除 ----
$useRecycleBin = $true
if ($HardDelete) { $useRecycleBin = $false }
if ($useRecycleBin) {
  Add-Type -AssemblyName Microsoft.VisualBasic
}

$deleted = 0
$freed = 0
foreach ($row in $plan) {
  if (-not $row.Pick) { continue }
  # 兜底：目标必须真的在仓库目录里，且不等于仓库根
  $full = [System.IO.Path]::GetFullPath($row.Path)
  if (-not $full.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host ("跳过（不在仓库内）：{0}" -f $full) -ForegroundColor Red
    continue
  }

  try {
    if ($row.Kind -eq 'dir') {
      if ($useRecycleBin) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
          $full, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
          [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
      } else {
        Remove-Item -LiteralPath $full -Recurse -Force
      }
    } else {
      if ($useRecycleBin) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
          $full, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
          [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
      } else {
        Remove-Item -LiteralPath $full -Force
      }
    }
    $deleted++
    $freed += $row.Bytes
    Write-Host ("已删除 {0}（{1}）" -f $row.Name, (Get-SizeText $row.Bytes)) -ForegroundColor Green
  } catch {
    Write-Host ("删除失败 {0}：{1}" -f $row.Name, $_.Exception.Message) -ForegroundColor Red
  }
}

Write-Host ''
$where = '回收站'
if (-not $useRecycleBin) { $where = '永久删除' }
Write-Host ("完成：{0} 项，释放 {1}（{2}）" -f $deleted, (Get-SizeText $freed), $where) -ForegroundColor Cyan
if ($useRecycleBin) {
  Write-Host '删错了就到回收站里还原。'
}
