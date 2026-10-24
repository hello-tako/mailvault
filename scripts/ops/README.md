# scripts/ops — the resources a deploy cannot create

Everything here is idempotent: safe to run when the resource already exists. Each script
names its own inputs and prints what it did. They codify the commands DEPLOYMENT.md used
to describe as one-time manual steps, so "rebuild from scratch" is a run of the folder
rather than a reading exercise.

Common inputs (environment variables):

- `CF_API_TOKEN` — an API token (the CI token's scopes are enough)
- `CF_ACCOUNT_ID` — the account both resources live in

| Script | Creates | Docs |
|--------|---------|------|
| `queues-subscription.sh` | the `email.sending` event subscription for one zone's delivery events | DEPLOYMENT.md, "The delivery-event subscription" |
| `portal-route.sh` | the portal hostname's DNS record + Worker service route | DEPLOYMENT.md, "The customer code portal" |
