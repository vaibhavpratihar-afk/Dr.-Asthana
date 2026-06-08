#!/usr/bin/env bash
#
# Auto Dev Agent launcher — the only non-markdown piece.
#
# The agent itself is `agent.md`, executed by Claude. This script exists only for the one thing the
# agent structurally cannot do for itself: capture its own run transcript. It runs Claude, tees the
# full transcript to a file, uploads it to Pixelbin (so any run can be inspected after the fact), and
# DMs the log link to Slack. Point ghanta-ghar / cron at this script.
#
# Capability gaps used (things Claude can't do natively): pixelbin-upload (CDN upload). Everything
# else — JIRA, git, gh/az, Slack — Claude does itself per agent.md.

set -uo pipefail
cd "$(dirname "$0")"

CONFIG="config.json"
MODEL="$(node -e 'try{process.stdout.write(require("./config.json").claude?.model||"")}catch{}' 2>/dev/null)"
LOG="$(mktemp -t adt-run-XXXXXX).log"

echo "Auto Dev Agent — log: $LOG"

# Run the agent. agent.md is the system prompt; Claude runs one full cycle.
claude -p "Run one auto-dev cycle now, following your instructions." \
  --append-system-prompt "$(cat agent.md)" \
  --output-format stream-json --verbose \
  --dangerously-skip-permissions \
  ${MODEL:+--model "$MODEL"} \
  2>&1 | tee "$LOG"

# Upload the transcript for post-mortem (best-effort).
URL="$(pixelbin-upload --json --no-progress --format raw --unique --filename adt-run.log "$LOG" 2>/dev/null \
  | sed -n 's/.*"cdnUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
echo "run transcript: ${URL:-<upload failed>}"

# DM the log link to Slack (best-effort).
TOKEN="$(node -e 'try{process.stdout.write(require("./config.json").slack?.botToken||"")}catch{}' 2>/dev/null)"
USER_ID="$(node -e 'try{process.stdout.write(require("./config.json").slack?.userId||"")}catch{}' 2>/dev/null)"
if [ -n "$TOKEN" ] && [ -n "$USER_ID" ] && [ -n "${URL:-}" ]; then
  CH="$(curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-type: application/json' \
    -d "{\"users\":\"$USER_ID\"}" https://slack.com/api/conversations.open \
    | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$CH" ] && curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" -H 'Content-type: application/json' \
    -d "{\"channel\":\"$CH\",\"text\":\"🧾 auto-dev run transcript: $URL\"}" https://slack.com/api/chat.postMessage
fi

rm -f "$LOG"
