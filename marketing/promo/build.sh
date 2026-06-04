#!/usr/bin/env bash
# Build the Duckle promo video (silent, 1080p, ~30s).
# Inputs: existing logo PNG + 4 real screenshots from docs/assets.
# Output: marketing/promo/out/duckle-promo.mp4
#
# Run from anywhere; the script cd's into its own dir so ffmpeg filter
# strings can reference fonts by bare filename (avoids colon-in-path
# escaping issues with Windows absolute paths inside filter graphs).

set -euo pipefail

cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
ASSETS="$ROOT/docs/assets/real-life-screenshot"
LOGO="$ROOT/apps/desktop/icons/icon-source.png"
OUTDIR="out"
SCENES="scenes"

mkdir -p "$OUTDIR" "$SCENES"

# Copy fonts in if not already present (avoids colon in path)
[ -f font-reg.ttf ] || cp /c/Windows/Fonts/segoeui.ttf font-reg.ttf
[ -f font-bold.ttf ] || cp /c/Windows/Fonts/segoeuib.ttf font-bold.ttf

W=1920
H=1080
FPS=30

TEXT="0xecf0f7"
MUTED="0xaab3c5"
ACCENT="0x18d4e0"

FR="font-reg.ttf"
FB="font-bold.ttf"

FF="ffmpeg -y -hide_banner -loglevel error"

# ---- Scene 1: Logo + brand (4s)
$FF -f lavfi -i "color=c=#07090f:s=${W}x${H}:r=${FPS}:d=4" \
    -loop 1 -t 4 -i "$LOGO" \
    -filter_complex "
      [1:v]scale=420:420[lg];
      [0:v][lg]overlay=(W-w)/2:(H-h)/2-120:enable='between(t,0.2,4)',
      drawtext=fontfile=${FB}:text='Duckle':fontcolor=${TEXT}:fontsize=120:x=(w-tw)/2:y=h/2+180:alpha='if(lt(t,0.8),0,if(lt(t,1.6),(t-0.8)/0.8,1))',
      drawtext=fontfile=${FR}:text='Open-source ETL that runs locally':fontcolor=${MUTED}:fontsize=40:x=(w-tw)/2:y=h/2+330:alpha='if(lt(t,1.4),0,if(lt(t,2.2),(t-1.4)/0.8,1))',
      fade=t=out:st=3.5:d=0.5
    " -c:v libx264 -pix_fmt yuv420p -preset medium -crf 18 "$SCENES/01_logo.mp4"

# Reusable filter prelude for screenshot scenes: scale to >= 1080 high keeping
# aspect, crop to exact 1920x1080 centered, slow zoom via crop expression.
SHOT_FILTER='[0:v]scale=-2:1216,crop=1920:1080:(iw-1920)/2:(ih-1080)/2'

# ---- Scene 2: Screenshot 1 (canvas) (5s)
$FF -loop 1 -t 5 -framerate ${FPS} -i "$ASSETS/1.png" \
    -filter_complex "
      ${SHOT_FILTER},
      drawbox=y=ih-180:color=0x000000@0.65:width=iw:height=180:t=fill,
      drawtext=fontfile=${FB}:text='Drag-drop pipelines':fontcolor=${TEXT}:fontsize=58:x=80:y=h-150,
      drawtext=fontfile=${FR}:text='Compiled to native DuckDB SQL. Sub-second runs.':fontcolor=${MUTED}:fontsize=34:x=80:y=h-80,
      fade=t=in:st=0:d=0.4,fade=t=out:st=4.6:d=0.4
    " -c:v libx264 -pix_fmt yuv420p -preset medium -crf 18 -t 5 "$SCENES/02_canvas.mp4"

# ---- Scene 3: Duckie AI (5s)
$FF -loop 1 -t 5 -framerate ${FPS} -i "$ASSETS/duckie.png" \
    -filter_complex "
      ${SHOT_FILTER},
      drawbox=y=ih-180:color=0x000000@0.65:width=iw:height=180:t=fill,
      drawtext=fontfile=${FB}:text='Duckie AI Assistant':fontcolor=${TEXT}:fontsize=58:x=80:y=h-150,
      drawtext=fontfile=${FR}:text='Local LLM. No API key. Inserts pipelines straight into the canvas.':fontcolor=${MUTED}:fontsize=34:x=80:y=h-80,
      fade=t=in:st=0:d=0.4,fade=t=out:st=4.6:d=0.4
    " -c:v libx264 -pix_fmt yuv420p -preset medium -crf 18 -t 5 "$SCENES/03_duckie.mp4"

# ---- Scene 4: Screenshot 2 (5s)
$FF -loop 1 -t 5 -framerate ${FPS} -i "$ASSETS/2.png" \
    -filter_complex "
      ${SHOT_FILTER},
      drawbox=y=ih-180:color=0x000000@0.65:width=iw:height=180:t=fill,
      drawtext=fontfile=${FB}:text='200+ components':fontcolor=${TEXT}:fontsize=58:x=80:y=h-150,
      drawtext=fontfile=${FR}:text='Sources. Transforms. Sinks. Streaming. AI. Code blocks.':fontcolor=${MUTED}:fontsize=34:x=80:y=h-80,
      fade=t=in:st=0:d=0.4,fade=t=out:st=4.6:d=0.4
    " -c:v libx264 -pix_fmt yuv420p -preset medium -crf 18 -t 5 "$SCENES/04_components.mp4"

# ---- Scene 5: Screenshot 3 (5s)
$FF -loop 1 -t 5 -framerate ${FPS} -i "$ASSETS/3.png" \
    -filter_complex "
      ${SHOT_FILTER},
      drawbox=y=ih-180:color=0x000000@0.65:width=iw:height=180:t=fill,
      drawtext=fontfile=${FB}:text='In-app Git + CI':fontcolor=${TEXT}:fontsize=58:x=80:y=h-150,
      drawtext=fontfile=${FR}:text='Commit, push, pull. GitHub + GitLab pipeline status in the topbar.':fontcolor=${MUTED}:fontsize=34:x=80:y=h-80,
      fade=t=in:st=0:d=0.4,fade=t=out:st=4.6:d=0.4
    " -c:v libx264 -pix_fmt yuv420p -preset medium -crf 18 -t 5 "$SCENES/05_git.mp4"

# ---- Scene 6: End card (6s)
$FF -f lavfi -i "color=c=#07090f:s=${W}x${H}:r=${FPS}:d=6" \
    -loop 1 -t 6 -i "$LOGO" \
    -filter_complex "
      [1:v]scale=300:300[lg];
      [0:v][lg]overlay=(W-w)/2:(H-h)/2-220,
      drawtext=fontfile=${FB}:text='Duckle':fontcolor=${TEXT}:fontsize=92:x=(w-tw)/2:y=h/2+120,
      drawtext=fontfile=${FR}:text='Free  /  Open source  /  30 MB single binary':fontcolor=${MUTED}:fontsize=36:x=(w-tw)/2:y=h/2+240,
      drawtext=fontfile=${FB}:text='github.com/SouravRoy-ETL/duckle':fontcolor=${ACCENT}:fontsize=44:x=(w-tw)/2:y=h/2+320,
      fade=t=in:st=0:d=0.5,fade=t=out:st=5.5:d=0.5
    " -c:v libx264 -pix_fmt yuv420p -preset medium -crf 18 "$SCENES/06_end.mp4"

# ---- Concat into final
cat > "$SCENES/concat.txt" <<EOF
file '01_logo.mp4'
file '02_canvas.mp4'
file '03_duckie.mp4'
file '04_components.mp4'
file '05_git.mp4'
file '06_end.mp4'
EOF

$FF -f concat -safe 0 -i "$SCENES/concat.txt" -c copy "$OUTDIR/duckle-promo.mp4"

echo "Done: $OUTDIR/duckle-promo.mp4"
ls -lh "$OUTDIR/duckle-promo.mp4"
