# 生成 HarmonyOS 分层应用图标与启动窗图标（复刻 public/icon.svg 品牌标志）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File gen-icon.ps1
# 规范依据: developer.huawei.com 应用图标资源规范 —— 1024x1024 正方形分层 PNG，
# 背景不允许透明像素，前景元素远离四角，遮罩由系统生成
param([string]$Root = "$PSScriptRoot")

if ([string]::IsNullOrEmpty($Root)) { $Root = $PSScriptRoot }

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

# 品牌色（public/icon.svg）
$NAVY   = [System.Drawing.Color]::FromArgb(255, 0x0b, 0x0e, 0x1a)
$BLUE   = [System.Drawing.Color]::FromArgb(255, 0x5b, 0x8c, 0xff)
$PURPLE = [System.Drawing.Color]::FromArgb(255, 0xb4, 0x8c, 0xff)
$CYAN   = [System.Drawing.Color]::FromArgb(255, 0x7d, 0xcf, 0xff)

# icon.svg 坐标: 圆环 r=40 sw=10, 辐条 r18→r40 sw=10, 中心点 r=12
function New-Canvas([int]$Size) {
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  return @($bmp, $g)
}

function Add-RoundedRect([System.Drawing.Drawing2D.GraphicsPath]$p, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
}

# $Scale: svg 单位缩放; $Size: 画布边长; 圆心恒为画布中心
function Draw-Logo([System.Drawing.Graphics]$g, [int]$Size, [double]$Scale, [bool]$Plate, [bool]$Rounded) {
  $c = $Size / 2.0
  if ($Plate) {
    if ($Rounded) {
      $path = New-Object System.Drawing.Drawing2D.GraphicsPath
      Add-RoundedRect $path 0 0 $Size $Size ($Size * 28 / 128.0)
      $b = New-Object System.Drawing.SolidBrush($NAVY)
      $g.FillPath($b, $path)
      $b.Dispose(); $path.Dispose()
    } else {
      $g.Clear($NAVY)
    }
  }
  $ringR = 40 * $Scale; $sw = 10 * $Scale
  if ($Scale -le 0) { return }
  $gradRect = [System.Drawing.RectangleF]::new([float]($c - 45 * $Scale), [float]($c - 45 * $Scale), [float](90 * $Scale), [float](90 * $Scale))
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($gradRect, $BLUE, $PURPLE, [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $pen = New-Object System.Drawing.Pen($grad, [float]$sw)
  $g.DrawEllipse($pen, [float]($c - $ringR), [float]($c - $ringR), [float](2 * $ringR), [float](2 * $ringR))
  foreach ($spoke in @(@(-1, 0), @(1, 0), @(0, -1), @(0, 1))) {
    $dx = $spoke[0]; $dy = $spoke[1]
    $x1 = [float]($c + $dx * 40 * $Scale); $y1 = [float]($c + $dy * 40 * $Scale)
    $x2 = [float]($c + $dx * 18 * $Scale); $y2 = [float]($c + $dy * 18 * $Scale)
    $g.DrawLine($pen, $x1, $y1, $x2, $y2)
  }
  $pen.Dispose(); $grad.Dispose()
  $dot = 12 * $Scale
  $dotBrush = New-Object System.Drawing.SolidBrush($CYAN)
  $g.FillEllipse($dotBrush, [float]($c - $dot), [float]($c - $dot), [float](2 * $dot), [float](2 * $dot))
  $dotBrush.Dispose()
}

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$Path) {
  $dir = Split-Path $Path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

# --- 前景: 仅准星图形，透明底，外缘半径 310px（占 1024 的 61%，远离四角） ---
$fg = New-Canvas 1024
Draw-Logo $fg[1] 1024 (310 / 45.0) $false $false
Save-Png $fg[0] (Join-Path $Root 'AppScope\resources\base\media\foreground.png')
$fg[1].Dispose(); $fg[0].Dispose()

# --- 背景: 品牌深色底整幅填充，无透明像素 ---
$bg = New-Canvas 1024
Draw-Logo $bg[1] 1024 0 $true $false
Save-Png $bg[0] (Join-Path $Root 'AppScope\resources\base\media\background.png')
$bg[1].Dispose(); $bg[0].Dispose()

# --- 启动窗图标: 完整复刻 icon.svg（含圆角底板），152x152 ---
$st = New-Canvas 152
Draw-Logo $st[1] 152 (152 / 128.0) $true $true
Save-Png $st[0] (Join-Path $Root 'entry\src\main\resources\base\media\startIcon.png')
$st[1].Dispose(); $st[0].Dispose()

# --- 同步 entry 模块副本（module.json5 引用的是 entry 的 $media:layered_image） ---
Copy-Item (Join-Path $Root 'AppScope\resources\base\media\foreground.png') (Join-Path $Root 'entry\src\main\resources\base\media\foreground.png') -Force
Copy-Item (Join-Path $Root 'AppScope\resources\base\media\background.png') (Join-Path $Root 'entry\src\main\resources\base\media\background.png') -Force

# --- 预览: 合成前后景，供人工检查 ---
$prev = [System.Drawing.Bitmap]::FromFile((Join-Path $Root 'AppScope\resources\base\media\background.png'))
$g2 = [System.Drawing.Graphics]::FromImage($prev)
$fgImg = [System.Drawing.Bitmap]::FromFile((Join-Path $Root 'AppScope\resources\base\media\foreground.png'))
$g2.DrawImage($fgImg, 0, 0, 1024, 1024)
$g2.Dispose(); $fgImg.Dispose()
Save-Png $prev (Join-Path $Root 'icon_preview.png')
$prev.Dispose()
Write-Host 'icon resources regenerated'
