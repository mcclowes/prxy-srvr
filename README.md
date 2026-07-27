# prxy-srvr

A small CORS proxy that runs as a Vercel function. Deploy it three times, give each deployment its own key and name, and rotate between them from the consuming project to spread load against an upstream's rate limits.

It's a single function with no dependencies beyond the Node runtime. Requests come in, get checked against a shared secret and an optional host allowlist, and go out via `fetch`.

## Request format

Two forms. Use the query form: it's unambiguous and costs one request.

```
GET https://your-proxy.vercel.app/?url=https%3A%2F%2Fapi.example.com%2Fthings%3Fpage%3D2
```

The cors-anywhere style path also works, but Vercel's router collapses `//` and 308s you to the single-slash version first, so it costs an extra round trip. Both of these land on the same place:

```
GET https://your-proxy.vercel.app/https://api.example.com/things   # 308, then 200
GET https://your-proxy.vercel.app/https:/api.example.com/things    # 200 directly
```

Every request needs an `x-proxy-key` header matching that deployment's `PROXY_KEY`. Without it you get a 401. Preflight `OPTIONS` requests skip the check, since browsers won't send custom headers on a preflight.

The method, body, and headers pass straight through, so `authorization` reaches the upstream and you can proxy authenticated APIs. Cookies are stripped in both directions.

## Batching

`POST /batch` fetches many targets in one invocation. Worth reaching for when the round trip to this proxy costs more than the upstream request does, which is usually the case for small responses over a long hop.

```
POST https://your-proxy.vercel.app/batch
x-proxy-key: <key>
content-type: application/json

{ "requests": ["https://api.example.com/a", "https://api.example.com/b"] }
```

Entries can be bare URL strings, or objects with `url` and optional `method` and `headers`. At most 200 per batch, since every result carries its upstream body and a serverless response has a hard size ceiling.

The response is always `200` when the batch itself was well formed. Each result stands alone:

```json
{
  "proxy": "prxy-a",
  "correlationId": "4b3a2c1d-…",
  "results": [
    { "index": 0, "status": 200, "headers": { "content-type": "application/json" }, "body": "{…}" },
    {
      "index": 1,
      "issues": [
        {
          "issue": "batch.upstream.timeout",
          "severity": "error",
          "correlationId": "4b3a2c1d-…",
          "dateTime": "2026-07-27T18:40:00.000Z",
          "message": { "title": "Upstream timed out", "detail": "No response within 20000ms." }
        }
      ]
    }
  ]
}
```

A result carries **either** `status` and `body`, or `issues`. The split is deliberate: an upstream answering `403` is a result, because the proxy did its job and that is the answer. `issues` means we never got that far — a rejected target, a timeout, a connection failure — so the caller can retry that one entry without replaying the batch.

Batch-level failures (`401`, `400`, `413`) return the same `issues` shape at the top level with no `results`. Issue codes read `{domain}.{class}.{reason}`; parse them by prefix rather than exact match, since the set will grow.

Send an `x-correlation-id` and it comes back on the response and on every issue, so your logs line up with the proxy's.

Targets in a batch go through exactly the same checks as the single-target route — protocol, private-network guard, and the allowlist — so batching is not a way around any of them.

## Environment variables

| Variable              | Required | Default         | What it does                                                                                                                           |
| --------------------- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `PROXY_KEY`           | Yes      | none            | Shared secret. Callers send it as `x-proxy-key`. The function returns 503 without one, so a deployment can't accidentally end up open. |
| `PROXY_ID`            | No       | `unnamed`       | Names this deployment in `/health` and the `x-proxy-id` response header. Give each of the three a different value.                     |
| `ALLOWED_TARGETS`     | No       | any public host | Comma separated hosts this deployment may reach. `*.example.com` matches subdomains and the apex.                                      |
| `ALLOWED_ORIGINS`     | No       | `*`             | Comma separated origins allowed to call the proxy from a browser.                                                                      |
| `UPSTREAM_TIMEOUT_MS` | No       | `20000`         | How long to wait for the upstream before returning 504.                                                                                |

Generate a key with `openssl rand -hex 32`. Use a different one per deployment so you can revoke a single proxy without touching the others.

## Deploying three of them

Each deployment is its own Vercel project pointing at this same repo. Pushing to `main` redeploys all three.

Every project needs its **Production Branch** (Settings → Git) set to `main`. If it's set to anything else, merges still build — they just come out as previews, with `"target": null`, and the live URL quietly keeps serving the older build. That's worth knowing because nothing about it looks like a failure: the merge is green, the deployment says `READY`, and the endpoint you just added 404s or falls through to a catch-all route.

Changing the setting doesn't retroactively promote a build that already exists, either. Push a new commit, or redeploy the latest one from the dashboard.

```sh
vercel link --project prxy-srvr-a --yes
vercel env add PROXY_KEY production
vercel env add PROXY_ID production   # prxy-a
vercel deploy --prod
```

Repeat with `prxy-srvr-b` and `prxy-srvr-c`. To connect them to GitHub so pushes deploy automatically, open each project in the Vercel dashboard and link the repo under settings.

`scripts/deploy-all.sh` wraps the loop once the projects exist:

```sh
./scripts/deploy-all.sh prxy-srvr-a prxy-srvr-b prxy-srvr-c
```

Note that `vercel link` rewrites `.vercel/project.json`, so whichever project you linked last is the one a bare `vercel deploy` will target.

### A caveat on rate limits

Three deployments only spread load if the upstream counts against something that differs between them. If it rate limits per API key or per account, use a different credential per deployment and you're set.

If it rate limits by source IP, three projects in the same Vercel region can share egress IPs, and you'll gain nothing. Set a different function region per project under settings, functions in the Vercel dashboard. Don't pin `regions` in `vercel.json`, since all three read the same file.

## Health checks

`GET /health` needs no key and reports which deployment answered:

```json
{ "ok": true, "id": "prxy-a", "region": "lhr1", "targetsAllowlisted": 1, "originsAllowlisted": 0 }
```

If `PROXY_KEY` is missing it returns 503 with `ok: false`, which is the quickest way to spot a deployment you forgot to configure.

## Using it from the consuming project

```ts
const PROXIES = [
  { url: 'https://prxy-srvr-a.vercel.app', key: process.env.PRXY_KEY_A! },
  { url: 'https://prxy-srvr-b.vercel.app', key: process.env.PRXY_KEY_B! },
  { url: 'https://prxy-srvr-c.vercel.app', key: process.env.PRXY_KEY_C! },
];

let next = 0;

export function proxiedFetch(target: string, init: RequestInit = {}) {
  const proxy = PROXIES[next++ % PROXIES.length]!;

  return fetch(`${proxy.url}/?url=${encodeURIComponent(target)}`, {
    ...init,
    headers: { ...init.headers, 'x-proxy-key': proxy.key },
  });
}
```

Read `x-proxy-id` off the response if you want to know which one served a given request.

## Security

The proxy refuses to start without `PROXY_KEY`, blocks private and link-local targets, and answers redirects by pointing the client back through itself so a 302 can't slip past the allowlist.

The private-address check reads the hostname, so it doesn't stop a public hostname whose DNS record points at a private IP. If you're proxying to a known set of upstreams, set `ALLOWED_TARGETS`. That's the gate that actually holds.

## Local development

```sh
npm install
npm run dev          # vercel dev, needs the Vercel CLI installed globally
```

Put `PROXY_KEY` in `.env.local` (see `.env.example`). `vercel dev` picks it up.

```sh
npm test             # vitest
npm run typecheck
npm run check        # format, types, and tests
```
