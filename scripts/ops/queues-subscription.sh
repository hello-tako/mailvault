#!/usr/bin/env bash
# Point one zone's Email Sending delivery events at the mail-delivery-events queue.
# An account-level resource, created once per sending zone — a deploy neither creates
# nor repairs it (see DEPLOYMENT.md, "The delivery-event subscription").
#
# Usage: CF_API_TOKEN=… CF_ACCOUNT_ID=… ./queues-subscription.sh <zone-id>
set -euo pipefail

: "${CF_API_TOKEN:?set CF_API_TOKEN to an API token with Queues + Email Sending edit}"
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
ZONE_ID="${1:?usage: queues-subscription.sh <zone-id>}"
QUEUE="mail-delivery-events"

# `queues subscription create` fails with "already exists" when the zone is subscribed —
# which is the success case for an idempotent script, so it is checked rather than fatal.
if npx --yes wrangler@4 queues subscription list --source email.sending 2>/dev/null | grep -q "$ZONE_ID"; then
  echo "zone $ZONE_ID already subscribed"
  exit 0
fi

npx --yes wrangler@4 queues subscription create "$QUEUE" \
  --source email.sending \
  --zone-id "$ZONE_ID" \
  --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained

echo "subscribed zone $ZONE_ID to $QUEUE"
