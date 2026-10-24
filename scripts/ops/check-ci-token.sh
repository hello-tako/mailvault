#!/usr/bin/env bash
# Verify a Cloudflare API token's scopes without touching GitHub Actions — the read-only
# calls the CI deploy and backup jobs actually make. Run on the owner's machine:
#
#   CF_API_TOKEN=<token> ./scripts/ops/check-ci-token.sh
#
# Exits non-zero on the first missing permission, naming it.
set -euo pipefail

: "${CF_API_TOKEN:?set CF_API_TOKEN to the token being checked}"
ACCOUNT="ef250a88911fd24073cb73d1c07e0218"
cd "$(dirname "$0")/../../apps/worker"

check() {
  local label="$1"; shift
  if out=$(CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" "$@" 2>&1); then
    echo "OK    $label"
  else
    echo "FAIL  $label"
    echo "$out" | grep -m1 -i "error\|fail" || true
    exit 1
  fi
}

# Workers Scripts (read is enough to prove the scope): list versions of this Worker.
check "Workers Scripts (deploy)" npx wrangler versions list --config wrangler.jsonc
# D1: list unapplied migrations on the production database.
check "D1 (migrations + export)" npx wrangler d1 migrations list mail-vault-db --remote --config wrangler.jsonc
# Queues: read the ingest queue's info.
check "Queues (consumer config)" npx wrangler queues info mail-ingest
# R2 on the storage bucket (deploy validates the binding).
check "R2 mail-vault-storage" npx wrangler r2 bucket info mail-vault-storage
# R2 on the backups bucket (the backup workflow creates/reads/writes it).
check "R2 mail-vault-backups" npx wrangler r2 bucket info mail-vault-backups

echo "token has every scope CI needs"
