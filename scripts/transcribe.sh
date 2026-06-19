#!/bin/bash
# Transcribe Zoom recording(s) with whisper.cpp.
#
# Usage:
#   ./transcribe.sh                          # opens a folder picker (multi-select OK)
#   ./transcribe.sh /path/to/recording-folder [more ...]
#   ./transcribe.sh /path/to/video.mp4       # individual files still work via CLI
#
# Any folder is accepted and normalized automatically:
#   - a Zoom recording folder        -> transcribed
#   - its "Audio Record" subfolder   -> resolved up to the recording folder
#   - an umbrella folder (e.g. "Zoom Recordings") -> every recording inside it
#     is transcribed; recordings that already have a transcript are skipped
#
# Speaker handling is decided by the number of per-participant tracks in
# "Audio Record/" (Zoom's "separate audio file per participant" setting):
#
#   2+ tracks: each track transcribed independently (with silero VAD, since
#              solo tracks are mostly silence and whisper hallucinates on
#              silence), then merged by timestamp into a speaker-labeled
#              transcript.
#   1 track:   transcribed with VAD, output still speaker-labeled.
#   0 tracks:  the mixed mp4/m4a is transcribed as one stream, no labels.
#
# Outputs into the recording folder, where <name> is the folder name:
#   <name>_transcript.txt   "[HH:MM:SS] Speaker: text" (labeled modes)
#   <name>_transcript.srt

set -euo pipefail

WHISPER_DIR="$HOME/whisper.cpp"
WHISPER_BIN="$WHISPER_DIR/build/bin/whisper-cli"
MODEL="$WHISPER_DIR/models/ggml-large-v3-turbo.bin"
VAD_MODEL="$WHISPER_DIR/models/ggml-silero-v6.2.0.bin"

err() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

# NOTE: pin compilers explicitly — ~/.local/bin/cc (the iMac sync script) shadows
# the system C compiler and breaks cmake's auto-detection.
[ -x "$WHISPER_BIN" ] || err "whisper-cli not found at $WHISPER_BIN — build it: cd ~/whisper.cpp && cmake -B build -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++ && cmake --build build -j --config Release"
[ -f "$MODEL" ] || err "model not found at $MODEL — download it: cd ~/whisper.cpp && ./models/download-ggml-model.sh large-v3-turbo"
command -v ffmpeg >/dev/null || err "ffmpeg not found (brew install ffmpeg)"
command -v python3 >/dev/null || err "python3 not found"

VAD_FLAGS=()
if [ -f "$VAD_MODEL" ]; then
    VAD_FLAGS=(--vad --vad-model "$VAD_MODEL")
else
    echo "WARNING: VAD model missing ($VAD_MODEL) — solo tracks may hallucinate text during silence." >&2
    echo "         Fix: cd ~/whisper.cpp && bash models/download-vad-model.sh silero-v6.2.0" >&2
fi

# --- transcribe one audio/video file -> srt+txt at $2 (output base path) ----
transcribe_file() {
    local src="$1" out_base="$2"; shift 2
    local wav
    wav=$(mktemp -t transcribe).wav
    ffmpeg -y -loglevel error -i "$src" -ar 16000 -ac 1 -c:a pcm_s16le "$wav"
    "$WHISPER_BIN" -m "$MODEL" -f "$wav" -l en "$@" \
        --output-txt --output-srt --output-file "$out_base" --print-progress
    rm -f "$wav"
}

# --- speaker label from a Zoom track filename: audioJaneDoe1234567.m4a ------
speaker_from_track() {
    local b
    b=$(basename "$1")
    b="${b%.*}"            # drop extension
    b="${b#audio}"         # drop leading "audio"
    b=$(printf '%s' "$b" | sed -E 's/[0-9]+$//')   # drop trailing stream id
    [ -n "$b" ] && printf '%s' "$b" || printf 'speaker'
}

# --- merge per-track srt files into speaker-labeled txt + srt ---------------
merge_tracks() {
    local out_base="$1"; shift
    python3 - "$out_base" "$@" <<'PYEOF'
import re, sys

out_base, pairs = sys.argv[1], sys.argv[2:]
# pairs alternate: speaker name, srt path
segs = []
for speaker, path in zip(pairs[0::2], pairs[1::2]):
    text = open(path, encoding="utf-8").read()
    for m in re.finditer(
        r"(\d{2}:\d{2}:\d{2}),(\d{3}) --> (\d{2}:\d{2}:\d{2}),(\d{3})\n(.*?)(?:\n\n|\Z)",
        text, re.S,
    ):
        start = m.group(1) + "," + m.group(2)
        end = m.group(3) + "," + m.group(4)
        seg_text = " ".join(m.group(5).split())
        if seg_text:
            segs.append((start, end, speaker, seg_text))

segs.sort(key=lambda s: s[0])

with open(out_base + ".txt", "w", encoding="utf-8") as f:
    for start, end, speaker, text in segs:
        f.write(f"[{start[:8]}] {speaker}: {text}\n")

with open(out_base + ".srt", "w", encoding="utf-8") as f:
    for i, (start, end, speaker, text) in enumerate(segs, 1):
        f.write(f"{i}\n{start} --> {end}\n{speaker}: {text}\n\n")

print(f"merged {len(segs)} segments from {len(pairs)//2} tracks")
PYEOF
}

# --- does this folder look like a single Zoom recording? --------------------
is_recording_dir() {
    [ -d "$1/Audio Record" ] && return 0
    [ -f "$1/recording.conf" ] && return 0
    [ -n "$(find "$1" -maxdepth 1 \( -name "*.mp4" -o -name "*.m4a" \) -print -quit)" ]
}

# --- transcribe one recording folder (optionally a specific file in it) -----
process_recording() {
    local DIR="$1" SRC_FILE="${2:-}"
    local NAME OUT_BASE TMPD SPEAKER TRACK i
    NAME=$(basename "$DIR")
    OUT_BASE="$DIR/${NAME}_transcript"

    # Per-participant tracks (Zoom: "Audio Record" subfolder, audio<Name><id>.m4a)
    local TRACKS=()
    if [ -d "$DIR/Audio Record" ]; then
        while IFS= read -r -d '' t; do TRACKS+=("$t"); done \
            < <(find "$DIR/Audio Record" -maxdepth 1 -name "audio*.m4a" -print0 | sort -z)
    fi

    echo ""
    echo "=== $NAME ==="

    if [ "${#TRACKS[@]}" -ge 2 ]; then
        echo "Multi-track recording: ${#TRACKS[@]} speaker tracks found."
        TMPD=$(mktemp -d -t tracks)
        local MERGE_ARGS=()
        i=0
        for TRACK in "${TRACKS[@]}"; do
            SPEAKER=$(speaker_from_track "$TRACK")
            i=$((i+1))
            echo "[track $i/${#TRACKS[@]}] $SPEAKER ..."
            transcribe_file "$TRACK" "$TMPD/track$i" ${VAD_FLAGS[@]+"${VAD_FLAGS[@]}"}
            MERGE_ARGS+=("$SPEAKER" "$TMPD/track$i.srt")
        done
        echo "Merging tracks by timestamp..."
        merge_tracks "$OUT_BASE" "${MERGE_ARGS[@]}"
        rm -rf "$TMPD"
    elif [ "${#TRACKS[@]}" -eq 1 ]; then
        SPEAKER=$(speaker_from_track "${TRACKS[0]}")
        echo "Single speaker track found: $SPEAKER (output will be labeled)."
        TMPD=$(mktemp -d -t tracks)
        transcribe_file "${TRACKS[0]}" "$TMPD/track1" ${VAD_FLAGS[@]+"${VAD_FLAGS[@]}"}
        merge_tracks "$OUT_BASE" "$SPEAKER" "$TMPD/track1.srt"
        rm -rf "$TMPD"
    else
        # Single mixed stream. If given a folder, find the recording in it.
        if [ -z "$SRC_FILE" ]; then
            SRC_FILE=$(find "$DIR" -maxdepth 1 \( -name "*.mp4" -o -name "*.m4a" \) | sort | head -1)
            [ -n "$SRC_FILE" ] || { echo "SKIP (no mp4/m4a in $DIR)" >&2; return 0; }
        fi
        echo "Single mixed recording: $(basename "$SRC_FILE") (no speaker labels)."
        transcribe_file "$SRC_FILE" "$OUT_BASE"
    fi

    echo "Done → ${OUT_BASE}.txt"
    echo "       ${OUT_BASE}.srt"
}

# --- collect inputs: CLI args if given, otherwise a native folder picker ----
declare -a INPUTS=()
if [ $# -gt 0 ]; then
    INPUTS=("$@")
else
    echo "Select the Zoom recording folder(s) to transcribe (cmd-click for multiple)..."
    PICKED=$(osascript <<'EOF' 2>/dev/null || true
set chosen to choose folder with prompt "Select Zoom recording folder(s) to transcribe" with multiple selections allowed
set out to ""
repeat with f in chosen
    set out to out & POSIX path of f & "\n"
end repeat
return out
EOF
)
    if [ -z "$PICKED" ]; then
        # Picker cancelled or unavailable (e.g. SSH session) — fall back to typed path.
        read -rp "Paste full path to the recording folder or video file: " TYPED
        # Strip surrounding quotes Finder adds on drag-and-drop.
        TYPED="${TYPED%\'}"; TYPED="${TYPED#\'}"; TYPED="${TYPED%\"}"; TYPED="${TYPED#\"}"
        [ -n "$TYPED" ] || err "no recording selected"
        INPUTS=("$TYPED")
    else
        while IFS= read -r line; do
            [ -n "$line" ] && INPUTS+=("$line")
        done <<< "$PICKED"
    fi
fi

for INPUT in "${INPUTS[@]}"; do
    INPUT="${INPUT%/}"   # picker paths end with "/"

    if [ -f "$INPUT" ]; then
        process_recording "$(cd "$(dirname "$INPUT")" && pwd)" "$INPUT"
        continue
    fi
    if [ ! -d "$INPUT" ]; then
        echo "SKIP (not found): $INPUT" >&2
        continue
    fi

    # Picked the "Audio Record" subfolder itself — the recording is its parent.
    [ "$(basename "$INPUT")" = "Audio Record" ] && INPUT=$(dirname "$INPUT")
    DIR=$(cd "$INPUT" && pwd)

    if is_recording_dir "$DIR"; then
        process_recording "$DIR"
        continue
    fi

    # Umbrella folder: transcribe every recording inside, skip finished ones.
    FOUND=0
    for SUB in "$DIR"/*/; do
        SUB="${SUB%/}"
        [ -d "$SUB" ] || continue
        is_recording_dir "$SUB" || continue
        FOUND=1
        if [ -f "$SUB/$(basename "$SUB")_transcript.txt" ]; then
            echo "SKIP (transcript exists): $(basename "$SUB")"
            continue
        fi
        process_recording "$SUB"
    done
    [ "$FOUND" -eq 1 ] || echo "SKIP (no recordings found in): $INPUT" >&2
done

echo ""
echo "All transcriptions complete."
