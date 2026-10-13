# Breakwater Lab

An interactive virtual lab for learning Layer 7 gateways through real HTTP requests and measured experiments.

## Start locally

Requires Node.js 20 or newer.

```sh
npm install
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). The API listens on `http://localhost:3100`; it starts three synthetic HTTP upstreams on loopback ports 9101-9103. No account or database is needed. Use the route inspector to change the catalog split, run up to 200 requests, inject a v2 fault, and inspect measured distributions, latency, and traces.

Set `VITE_LAB_API_URL` to point the web app at a different API origin. The server accepts local development origins and an optional production `CORS_ORIGIN`.

See [docs/PLAN.md](docs/PLAN.md) for the full product, architecture, testing, and deployment plan, and [DESIGN.md](DESIGN.md) for the visual system.

## Current implementation

The initial vertical slice includes anonymous in-memory sessions, atomic route configuration validation, weighted deterministic catalog routing for bounded runs, synthetic catalog/checkout HTTP upstreams, live proxy forwarding, bounded fault injection, periodic health probes with ejection and recovery, idempotent retries, per-session rate limiting, session reset, SSE progress/completion/health events, server-side report checks and SLO scoring, a mixed challenge profile with checkout POSTs, session restart recovery, the canary workbench, report export, Docker Compose, Render, Vercel, and project design/UX context. Rich rule editing and deployed smoke checks remain in the next implementation stages.
