# prxy-srvr

A small CORS proxy that runs as a Vercel function. Deploy it three times, give each deployment its own key and name, and rotate between them from the consuming project to spread load against an upstream's rate limits.

It's a single function with no dependencies beyond the Node runtime. Requests come in, get checked against a shared secret and an optional host allowlist, and go out via `fetch`.

## Request format

Two forms. The query form is recommended, because Vercel's router collapses `//` in a path and the query string survives untouched.

```
GET https://your-proxy.vercel.app/?url=https%3A%2F%2Fapi.example.com%2Fthings%3Fpage%3D2
GET https://your-proxy.vercel.app/https://api.example.com/things?page=2
```

Every request needs an `x-proxy-key` header matching that deployment's `PROXY_KEY`. Without it you get a 401. Preflight `OPTIONS` requests skip the check, since browsers won't send custom headers on a preflight.

The method, body, and headers pass straight through, so `authorization` reaches the upstream and you can proxy authenticated APIs. Cookies are stripped in both directions.

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

Each deployment is its own Vercel project pointing at this same repo. Pushing to `master` redeploys all three.

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
