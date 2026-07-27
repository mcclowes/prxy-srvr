#!/usr/bin/env bash
# Deploys this repo to several Vercel projects in turn.
#   ./scripts/deploy-all.sh prxy-srvr-a prxy-srvr-b prxy-srvr-c
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <project-name> [project-name ...]" >&2
  exit 1
fi

for project in "$@"; do
  echo "==> $project"
  vercel link --project "$project" --yes
  vercel deploy --prod
done
