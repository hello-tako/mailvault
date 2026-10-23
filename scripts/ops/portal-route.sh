#!/usr/bin/env bash
# Attach the portal hostname to the Worker through the account-level service-routes API.
# wrangler's zone lookup cannot see this zone with the usual credential, which is why the
# route stays out of wrangler.jsonc and is created here instead (DEPLOYMENT.md, "The
# customer code portal"). Idempotent: an existing route is left exactly as it is.
#
# Usage: CF_API_TOKEN=… CF_ACCOUNT_ID=… ./portal-route.sh <zone-id> <portal-hostname>
#   e.g. ./portal-route.sh <zone-id-of-tungjp.store> code.tungjp.store
set -euo pipefail

: "${CF_API_TOKEN:?set CF_API_TOKEN to an API token with DNS edit + Workers routes edit}"
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
ZONE_ID="${1:?usage: portal-route.sh <zone-id> <portal-hostname>}"
HOST="${2:?usage: portal-route.sh <zone-id> <portal-hostname>}"
WORKER="mail-vault"
API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json")

# 1. The DNS record: a proxied AAAA pointing into the Worker's anycast. An existing
#    record for the name is reused, not duplicated.
record_id=$(curl -fsS "${AUTH[@]}" "$API/zones/$ZONE_ID/dns_records?name=$HOST&type=AAAA" | jq -r '.result[0].id // empty')
if [ -z "$record_id" ]; then
  record_id=$(curl -fsS "${AUTH[@]}" -X POST "$API/zones/$ZONE_ID/dns_records" \
    --data "{\"type\":\"AAAA\",\"name\":\"$HOST\",\"content\":\"100::\",\"proxied\":true}" | jq -r '.result.id')
  echo "created DNS record $record_id for $HOST"
else
  echo "DNS record for $HOST already exists ($record_id)"
fi

# 2. The service route. PUT is the whole-list truth for production routes, so the current
#    list is read, this pattern appended only when absent, and the rest preserved verbatim.
patterns=$(curl -fsS "${AUTH[@]}" "$API/accounts/$CF_ACCOUNT_ID/workers/services/$WORKER/environments/production/routes" | jq -c '.result.patterns // []')
echo "$patterns" | jq -e --arg h "$HOST/*" 'index($h) != null' >/dev/null && {
  echo "route $HOST/* already attached to $WORKER"
  exit 0
}
curl -fsS "${AUTH[@]}" -X PUT "$API/accounts/$CF_ACCOUNT_ID/workers/services/$WORKER/environments/production/routes" \
  --data "$(jq -c --arg h "$HOST/*" '{patterns: (. + [$h])}' <<<"$patterns")" >/dev/null
echo "attached $HOST/* to $WORKER"
