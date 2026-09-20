# Generates the AutoRefresh icon set into src/assets/icons/.
#
# Zero-dependency (System.Drawing ships with Windows), so there is no npm
# install standing between you and a rebuilt icon. Run it from anywhere:
#
#     powershell -ExecutionPolicy Bypass -File scripts/gen-icons.ps1
#
# The glyph is drawn from primitives rather than downscaled from a raster
# master on purpose: a plain downscale of detailed art turns to mush at 16px,
# and the toolbar icon is 16px. Stroke weight and radius are tuned per size
# (see $specs) so the ring stays legible all the way down, and the clock hands
# are dropped below 32px where they would only add noise.
#
# Two colorways: idle (teal) and active (amber). The service worker swaps to
# the active set per-tab while a job is running -- see background/badge.js.

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'src\assets\icons'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# size -> ring radius, stroke width, arrowhead scale (all as a fraction of the
# canvas) and whether to draw the clock hands.
$specs = @{
  16  = @{ R = 0.345; W = 0.200; Head = 1.00; Hands = $false }
  32  = @{ R = 0.335; W = 0.170; Head = 1.05; Hands = $true  }
  48  = @{ R = 0.330; W = 0.160; Head = 1.10; Hands = $true  }
  128 = @{ R = 0.325; W = 0.150; Head = 1.10; Hands = $true  }
}

$colorways = @{
  # idle: extension installed, nothing refreshing in this tab
  ''        = @{ Ring = '#0EA5C4'; Hands = '#0B7C93' }
  # active: a job is running in this tab
  '-active' = @{ Ring = '#F59E0B'; Hands = '#B45309' }
}

function ConvertFrom-Hex([string]$hex) {
  [System.Drawing.ColorTranslator]::FromHtml($hex)
}

function New-Icon([int]$size, [hashtable]$spec, [hashtable]$colors, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $c = $size / 2.0
    $r = $size * $spec.R
    $w = $size * $spec.W

    $ringColor = ConvertFrom-Hex $colors.Ring

    # --- ring: an open arc, leaving a gap for the arrowhead to sit in ---
    # GDI+ angles: 0 deg = east, positive = clockwise (y grows downward).
    $startAngle = 30.0
    $sweep      = 290.0

    $pen = New-Object System.Drawing.Pen($ringColor, [single]$w)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    try {
      $rect = New-Object System.Drawing.RectangleF(
        [single]($c - $r), [single]($c - $r), [single]($r * 2), [single]($r * 2))
      $g.DrawArc($pen, $rect, [single]$startAngle, [single]$sweep)
    } finally { $pen.Dispose() }

    # --- arrowhead at the sweep end, pointing along the clockwise tangent ---
    $end = ($startAngle + $sweep) * [Math]::PI / 180.0
    $cos = [Math]::Cos($end)
    $sin = [Math]::Sin($end)

    # point on the arc, radial (outward) unit vector, tangent unit vector
    $px = $c + $r * $cos
    $py = $c + $r * $sin
    $tx = -$sin
    $ty =  $cos

    $half   = $w * 1.05 * $spec.Head   # half-width of the arrowhead base
    $height = $w * 1.90 * $spec.Head   # base -> apex

    $brush = New-Object System.Drawing.SolidBrush($ringColor)
    try {
      $pts = @(
        (New-Object System.Drawing.PointF([single]($px + $tx * $height), [single]($py + $ty * $height))),
        (New-Object System.Drawing.PointF([single]($px + $cos * $half),  [single]($py + $sin * $half))),
        (New-Object System.Drawing.PointF([single]($px - $cos * $half),  [single]($py - $sin * $half)))
      )
      $g.FillPolygon($brush, $pts)
    } finally { $brush.Dispose() }

    # --- clock hands, omitted at 16px where they would only smear ---
    if ($spec.Hands) {
      $handColor = ConvertFrom-Hex $colors.Hands
      $hw = $w * 0.62
      $hp = New-Object System.Drawing.Pen($handColor, [single]$hw)
      $hp.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $hp.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
      try {
        # minute hand pointing up, hour hand pointing right: an unambiguous
        # "clock" read that stays distinct from the ring at small sizes.
        $g.DrawLine($hp, [single]$c, [single]$c, [single]$c, [single]($c - $r * 0.52))
        $g.DrawLine($hp, [single]$c, [single]$c, [single]($c + $r * 0.40), [single]$c)
      } finally { $hp.Dispose() }
    }

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}

foreach ($suffix in $colorways.Keys) {
  foreach ($size in ($specs.Keys | Sort-Object)) {
    $path = Join-Path $outDir ("icon{0}-{1}.png" -f $suffix, $size)
    New-Icon -size $size -spec $specs[$size] -colors $colorways[$suffix] -path $path
    "  wrote $(Split-Path -Leaf $path)"
  }
}

"Done -> $outDir"
