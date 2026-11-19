#!/usr/bin/env bash
# Simple keep‑alive heartbeat for a Codespace
# Writes a timestamp to stdout every 5 minutes (300 seconds)
while true; do
  echo "$(date '+%Y-%m-%d %H:%M:%S') – keep‑alive ping"
  sleep 300
done
