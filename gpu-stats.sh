#!/bin/bash
# Writes GPU stats JSON to /tmp/gpu_stats.json every 5 seconds
OUTPUT="/tmp/gpu_stats.json"
while true; do
  rocm-smi --showuse --showtemp --showpower --showclocks --showmeminfo vram --json 2>/dev/null > "$OUTPUT.tmp" && cat "$OUTPUT.tmp" > "$OUTPUT"
  sleep 5
done
