# Dynamic L7 API Gateway and Reverse Proxy Virtual Lab

## Purpose

Build a 20-30 minute browser lab where learners configure a real Layer 7 reverse proxy, send bounded synthetic traffic through it, inject faults, and measure the effect on routing, availability, and tail latency. The lab teaches through repeatable experiments with request traces, percentile measurements, traffic controls, and failure injection. It is an original focused lab inspired by [Breakscale](https://github.com/xevrion/breakscale/blob/main/README.md), not a port of its simulator.

## Implementation status

The initial vertical slice now includes the Vite/React workbench, Fastify session/config/fault/reset/run APIs, three loopback HTTP upstreams, a real HTTP proxy endpoint, deterministic weighted catalog requests, actual measured run results, the canary weight editor, latency/status traces, report download, project design/UX context, health-aware ejection and recovery thresholds, idempotent proxy retries, per-session token-bucket admission limits, route priority/specificity matching, progress/completion SSE events, server-side report checks and SLO scoring, Docker Compose, Render, and Vercel configuration. Remaining plan milestones include richer lesson-specific controls and content, resilient cold-start/session recovery, and deployed smoke checks.

## Learning outcomes

Learners will distinguish an L4 load balancer from an L7 gateway and reverse proxy; configure host, method, path, and header routing; measure weighted canary distribution; explain health checks, failover, timeouts, safe retries, and rate limits; diagnose behavior through traces, status codes, throughput, and p95/p99; and recognize retry amplification.

## Student experience

The primary editing surface is a calm network-engineering workbench: lesson rail, live client-to-gateway-to-service topology, contextual configuration inspector, and an observability deck for latency, status, traffic, and traces. SVG flow animation reflects sampled real requests. Health uses text and icons as well as color. Support keyboard navigation, visible focus, reduced motion, WCAG 2.2 AA contrast, and mobile reading and prepared runs.

Every activity follows **Predict -> Configure -> Run -> Observe -> Explain**:

1. HTTP routing: route catalog and checkout paths; explore methods, prefix rewrites, and forwarded headers.
2. Canary release: split 200 deterministic catalog requests 80/20, add an `X-Beta-User: true` route to v2, and compare configured and observed distribution.
3. Failure and recovery: inject v2 latency/errors, observe percentiles, failures, health, and retries, then tune policies and compare gateway timeouts with upstream 5xx.
4. Final SLO challenge: handle a fixed profile with one slow upstream. Pass at >=99% admitted success, p95 <300 ms, no traffic to unhealthy upstreams, and no checkout POST retries.

The report is downloadable HTML with optional student name/roll number, experiment configurations, before/after metrics, checks, representative traces, score, and completion timestamp.

## Architecture and interfaces

Use a TypeScript monorepo: React/Vite student app, SVG topology, Node/Fastify lab server, real HTTP reverse-proxy data plane, validated dynamic configuration, bounded traffic generator, and synthetic catalog v1, catalog v2, and checkout services. SSE carries metrics, traces, health changes, and run progress. Vitest covers unit/integration behavior and Playwright covers browser flows.

Local Docker Compose runs frontend, gateway, and upstream services separately. The free hosted lab runs the control API, gateway, and mock upstreams as loopback HTTP services in one Render instance. The public server binds to `$PORT`; synthetic services bind only to `127.0.0.1`.

Sessions have cryptographically random IDs, in-memory state, a 60-minute TTL, no accounts or database, bounded run duration/rate, reset, and report export. A process restart invalidates sessions and the UI offers a restart. Configuration references only predefined upstream IDs to prevent SSRF; invalid updates are atomic and retain the last valid configuration. Retries are limited to two additional attempts and idempotent methods by default.

Configuration consists of prioritized route rules (host, method, path prefix, exact header match, destination pool, optional prefix rewrite, timeout, retries), weighted-round-robin upstream pools, health-check thresholds, and an optional token-bucket rate limit.

HTTP API:

- `POST /api/sessions`, `GET /api/sessions/:id`
- `PUT /api/sessions/:id/config`
- `POST /api/sessions/:id/runs`, `GET /api/sessions/:id/report`
- `POST /api/sessions/:id/faults`, `DELETE /api/sessions/:id/faults`
- `POST /api/sessions/:id/reset`, `GET /api/sessions/:id/events` (SSE)
- `ANY /proxy/:sessionId/*` for browser and curl traffic
- `GET /healthz`

## Deployment

The intended evaluation deployment is Vercel Hobby for the static Vite app and one Render Free web service for the API, proxy, generator, and loopback upstreams. No database, object storage, worker, paid service, or persistent report/session data. Hobby is for personal/non-commercial use. Render free instances may sleep after 15 minutes and have ephemeral storage; do not use an uptime pinger.

Render configuration will set production mode, a single allowed Vercel CORS origin, 60-minute sessions, bounded runs (30 seconds, 100 RPS maximum), and loopback service URLs on ports 9101-9103. `/healthz` is the deployment check. Vercel uses the Vite build and `dist`, with `VITE_LAB_API_URL` pointing to Render. On cold start, the browser checks health, shows a clear startup state, retries with bounded backoff up to 90 seconds, and permits manual retry. A restart requires a new session.

Acceptance: both URLs use HTTPS; only Render `$PORT` is public; internal ports are inaccessible externally; CORS permits production and local origins only; expired/restarted sessions can be recreated; sessions are isolated; runs cannot exceed configured bounds; and the production-origin flow covers create, SSE, proxy, faults, reset, and report.

## Verification and delivery sequence

1. Add this plan, workspace structure, design context, and local Docker setup.
2. Build synthetic services and actual HTTP proxy forwarding.
3. Add sessions, validated dynamic config, and tracing.
4. Build topology, inspector, traffic controls, and metrics.
5. Add canary routing, health, timeouts, safe retries, rate limits, and faults.
6. Add guided experiments, evaluation, and HTML report.
7. Add Render/Vercel configuration.
8. Verify unit/integration behavior, browser scenarios, accessibility, load, cold start, and deployed smoke flows.

Test coverage will include rule ordering/matching, rewrites and forwarded headers, deterministic weighting, health transitions, token bucket, timeout/retry safety, allowlisting, actual HTTP forwarding, canary tolerance, fault/ejection/recovery, atomic updates, session isolation/expiry, SSE reconnect, full lessons/challenge, reset/recovery, keyboard/reduced motion/responsive layout, and 25 concurrent bounded sessions.

## Assumptions

All traffic and services are synthetic; sessions are anonymous and ephemeral; hosted use is academic/non-commercial; local Compose is the authoritative service-isolation demonstration; free hosted deployment is for evaluation and classroom demos, not production or large simultaneous exams.
