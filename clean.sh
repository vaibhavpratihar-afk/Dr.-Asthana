#!/usr/bin/env bash
# Clean temp working directories and logs.
# Usage: ./clean.sh

set -euo pipefail
cd "$(dirname "$0")"

rm -rf .tmp && echo "Deleted .tmp/" || true
rm -rf logs/*/ && echo "Deleted logs/*" || true

echo "Clean done."
