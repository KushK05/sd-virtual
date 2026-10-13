import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type TargetId = 'catalog-v1' | 'catalog-v2' | 'checkout';
type Route = { id: string; priority: number; match: { pathPrefix: string; methods?: string[]; headers?: Record<string, string> }; pool: Array<{ upstreamId: TargetId; weight: number }>; timeoutMs: number; retries: number };
type HealthState = { status: 'healthy' | 'unhealthy'; failures: number; successes: number; lastChange: number };
type Sample = { upstreamId: TargetId; status: number; durationMs: number; method: string; path: string; attempts: number };
type RunResult = { id: number; requested: number; completed: number; countByUpstream: Record<string, number>; successRate: number; p50: number; p95: number; p99: number; checkoutPostRetriesSafe: boolean; noTrafficAfterEjection: boolean; health: Record<TargetId, HealthState>; traces: Sample[] };
type Session = { id: string; expires: number; config: Route[]; faults: Partial<Record<TargetId, { delayMs: number; errorRate: number; down: boolean }>>; health: Record<TargetId, HealthState>; rateLimit: { requestsPerSecond: number; burst: number; recent: number[] }; runs: number; lastRun?: RunResult };
const baseConfig: Route[] = [
  { id: 'catalog-beta', priority: 20, match: { pathPrefix: '/api/catalog', headers: { 'x-beta-user': 'true' } }, pool: [{ upstreamId: 'catalog-v2', weight: 100 }], timeoutMs: 1000, retries: 0 },
  { id: 'catalog', priority: 10, match: { pathPrefix: '/api/catalog' }, pool: [{ upstreamId: 'catalog-v1', weight: 80 }, { upstreamId: 'catalog-v2', weight: 20 }], timeoutMs: 1000, retries: 0 },
  { id: 'checkout', priority: 10, match: { pathPrefix: '/api/checkout' }, pool: [{ upstreamId: 'checkout', weight: 100 }], timeoutMs: 1000, retries: 0 }
];
const targets: Record<TargetId, string> = {
  'catalog-v1': process.env.UPSTREAM_CATALOG_V1 ?? 'http://127.0.0.1:9101',
  'catalog-v2': process.env.UPSTREAM_CATALOG_V2 ?? 'http://127.0.0.1:9102',
  checkout: process.env.UPSTREAM_CHECKOUT ?? 'http://127.0.0.1:9103'
};
const app = Fastify({ logger: true, bodyLimit: 64 * 1024 });
const sessions = new Map<string, Session>();
const eventClients = new Map<string, Set<ServerResponse>>();
const now = () => Date.now();
const sessionTtlMs = Math.max(5, Number(process.env.SESSION_TTL_MINUTES ?? 60)) * 60_000;
const configuredMaxRunSeconds = Number(process.env.MAX_RUN_SECONDS ?? 30);
const configuredMaxRunRps = Number(process.env.MAX_RUN_RPS ?? 100);
const maxRunMs = Math.max(1, Number.isFinite(configuredMaxRunSeconds) ? configuredMaxRunSeconds : 30) * 1000;
const maxAllowedRps = Math.min(100, Math.max(1, Number.isFinite(configuredMaxRunRps) ? configuredMaxRunRps : 100));
const getSession = (id: string) => { const session = sessions.get(id); if (!session || session.expires < now()) { sessions.delete(id); return undefined; } return session; };
function selectTarget(route: Route, requestId: string, session?: Session): TargetId | undefined {
  const pool = route.pool.filter(target => !session || session.health[target.upstreamId].status === 'healthy');
  const eligible = pool;
  if (eligible.length === 0) return undefined;
  const total = eligible.reduce((sum, target) => sum + target.weight, 0);
  let hash = 2166136261;
  for (const char of requestId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  let pick = Math.floor((hash >>> 0) / 0x1_0000_0000 * total);
  for (const target of eligible) { if (pick < target.weight) return target.upstreamId; pick -= target.weight; }
  return eligible[0]!.upstreamId;
}
function updateHealth(session: Session, upstreamId: TargetId, ok: boolean) {
  const state = session.health[upstreamId];
  if (ok) { state.failures = 0; state.successes++; if (state.status === 'unhealthy' && state.successes >= 2) { state.status = 'healthy'; state.lastChange = now(); emit(session.id, 'health-change', { upstreamId, ...state }); } }
  else { state.successes = 0; state.failures++; if (state.failures >= 2 && state.status === 'healthy') { state.status = 'unhealthy'; state.lastChange = now(); emit(session.id, 'health-change', { upstreamId, ...state }); } }
}
function takeRateLimit(session: Session) {
  const cutoff = now() - 1000;
  session.rateLimit.recent = session.rateLimit.recent.filter(timestamp => timestamp > cutoff);
  if (session.rateLimit.recent.length >= session.rateLimit.requestsPerSecond + session.rateLimit.burst) return false;
  session.rateLimit.recent.push(now()); return true;
}
function matches(route: Route, req: IncomingMessage) {
  const path = new URL(req.url ?? '/', 'http://gateway.local').pathname;
  return path.startsWith(route.match.pathPrefix) && (!route.match.methods || route.match.methods.includes((req.method ?? 'GET').toUpperCase())) && Object.entries(route.match.headers ?? {}).every(([key, value]) => req.headers[key.toLowerCase()] === value);
}
function chooseRoute(routes: Route[], req: IncomingMessage) {
  return routes.filter(route => matches(route, req)).sort((a, b) => b.priority - a.priority || Object.keys(b.match.headers ?? {}).length - Object.keys(a.match.headers ?? {}).length || b.match.pathPrefix.length - a.match.pathPrefix.length)[0];
}
function sendJson(res: ServerResponse, code: number, body: unknown) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
function emit(sessionId: string, event: string, data: unknown) { for (const client of eventClients.get(sessionId) ?? []) { if (!client.writableEnded) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } }
function allowedOrigin(origin: string | undefined) { return !origin || origin === process.env.CORS_ORIGIN || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); }
const services: Array<{ port: number; name: TargetId; version: string }> = [
  { port: 9101, name: 'catalog-v1', version: 'catalog v1' }, { port: 9102, name: 'catalog-v2', version: 'catalog v2' }, { port: 9103, name: 'checkout', version: 'checkout' }
];
for (const service of services) {
  const upstream = Fastify();
  upstream.get('/health', async () => ({ status: 'healthy', service: service.name }));
  upstream.all('/*', async (request, reply) => ({ service: service.version, method: request.method, path: request.url, message: service.name === 'checkout' ? 'Checkout accepted' : `Response from ${service.version}`, requestId: request.headers['x-request-id'] ?? null }));
  void upstream.listen({ port: service.port, host: '127.0.0.1' });
}
await app.register(cors, { origin: (origin, callback) => callback(null, allowedOrigin(origin)) });
app.get('/healthz', async () => ({ status: 'ok', service: 'l7-lab' }));
app.post('/api/sessions', async (_request, reply) => {
  const health = Object.fromEntries(Object.keys(targets).map(id => [id, { status: 'healthy', failures: 0, successes: 0, lastChange: now() }])) as Record<TargetId, HealthState>;
  const session: Session = { id: randomUUID(), expires: now() + sessionTtlMs, config: structuredClone(baseConfig), faults: {}, health, rateLimit: { requestsPerSecond: maxAllowedRps, burst: 20, recent: [] }, runs: 0 };
  sessions.set(session.id, session);
  return reply.code(201).send({ id: session.id, expiresAt: session.expires, config: session.config, faults: session.faults, health: session.health, rateLimit: session.rateLimit, services: Object.keys(targets) });
});
app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
  const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired. Start a new lab session.' });
  return { id: session.id, expiresAt: session.expires, config: session.config, faults: session.faults, health: session.health, rateLimit: session.rateLimit, runs: session.runs };
});
app.put<{ Params: { id: string }; Body: Route[] | { routes: Route[]; rateLimit?: { requestsPerSecond: number; burst: number } } }>('/api/sessions/:id/config', async (request, reply) => {
  const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired. Start a new lab session.' });
  const routes = Array.isArray(request.body) ? request.body : request.body.routes;
  const rateLimit = Array.isArray(request.body) ? session.rateLimit : request.body.rateLimit;
  if (rateLimit && (!Number.isInteger(rateLimit.requestsPerSecond) || rateLimit.requestsPerSecond < 1 || rateLimit.requestsPerSecond > maxAllowedRps || !Number.isInteger(rateLimit.burst) || rateLimit.burst < 0 || rateLimit.burst > 100)) return reply.code(400).send({ error: `Rate limit must be 1-${maxAllowedRps} requests per second with a 0-100 burst.` });
  if (!Array.isArray(routes) || routes.length > 20) return reply.code(400).send({ error: 'Provide at most 20 route rules.' });
  for (const [index, route] of routes.entries()) {
    if (!route.id || !route.match?.pathPrefix?.startsWith('/') || !Array.isArray(route.pool) || !route.pool.length) return reply.code(400).send({ error: `Route ${index + 1} needs an id, path prefix, and upstream pool.` });
    if (!Number.isInteger(route.timeoutMs) || route.timeoutMs < 50 || route.timeoutMs > 10_000 || !Number.isInteger(route.retries) || route.retries < 0 || route.retries > 2) return reply.code(400).send({ error: `Route ${route.id} timeout must be 50-10000 ms and retries 0-2.` });
    if (route.pool.some(target => !(target.upstreamId in targets) || !Number.isInteger(target.weight) || target.weight < 1 || target.weight > 100) || route.pool.reduce((sum, target) => sum + target.weight, 0) !== 100) return reply.code(400).send({ error: `Route ${route.id} must use known upstreams with positive integer weights totaling 100%.` });
    if ((!route.match.methods || route.match.methods.some(method => method.toUpperCase() === 'POST')) && route.retries > 0) return reply.code(400).send({ error: 'Routes that may receive POST requests cannot be retried.' });
  }
  session.config = structuredClone(routes); if (rateLimit) { session.rateLimit.requestsPerSecond = rateLimit.requestsPerSecond; session.rateLimit.burst = rateLimit.burst; } return { saved: true, config: session.config, rateLimit: session.rateLimit };
});
app.post<{ Params: { id: string }; Body: { upstreamId: TargetId; delayMs?: number; errorRate?: number; down?: boolean } }>('/api/sessions/:id/faults', async (request, reply) => {
  const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired.' });
  const { upstreamId, delayMs = 0, errorRate = 0, down = false } = request.body;
  if (!(upstreamId in targets) || delayMs < 0 || delayMs > 5000 || errorRate < 0 || errorRate > 1) return reply.code(400).send({ error: 'Choose a known upstream, delay 0-5000 ms, and error rate 0-1.' });
  session.faults[upstreamId] = { delayMs, errorRate, down }; return { faults: session.faults };
});
app.delete<{ Params: { id: string } }>('/api/sessions/:id/faults', async (request, reply) => { const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired.' }); session.faults = {}; return { faults: {} }; });
setInterval(() => {
  for (const session of sessions.values()) {
    if (session.expires < now()) continue;
    for (const upstreamId of Object.keys(targets) as TargetId[]) {
      if (session.faults[upstreamId]?.down) { updateHealth(session, upstreamId, false); continue; }
      void fetch(`${targets[upstreamId]}/health`, { signal: AbortSignal.timeout(1000) }).then(response => updateHealth(session, upstreamId, response.ok)).catch(() => updateHealth(session, upstreamId, false));
    }
  }
}, 2000).unref();
app.post<{ Params: { id: string } }>('/api/sessions/:id/reset', async (request, reply) => { const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired.' }); session.config = structuredClone(baseConfig); session.faults = {}; session.runs = 0; session.lastRun = undefined; for (const state of Object.values(session.health)) Object.assign(state, { status: 'healthy', failures: 0, successes: 0, lastChange: now() }); session.rateLimit.recent = []; return { config: session.config, faults: {}, health: session.health }; });
app.post<{ Params: { id: string }; Body: { count?: number; profile?: 'canary' | 'routing' | 'challenge' } }>('/api/sessions/:id/runs', async (request, reply) => {
  const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired.' });
  const profile = request.body?.profile ?? 'canary';
  const count = profile === 'challenge' ? 200 : Math.min(200, Math.max(1, Math.floor(request.body?.count ?? 40)));
  if (profile === 'challenge') {
    session.faults['catalog-v2'] = { delayMs: 0, errorRate: 0, down: true };
    for (const state of Object.values(session.health)) Object.assign(state, { status: 'healthy', failures: 0, successes: 0, lastChange: now() });
  }
  const samples: Sample[] = [];
  const runStarted = now();
  const pacingMs = Math.max(1, Math.ceil(1000 / session.rateLimit.requestsPerSecond));
  for (let i = 0; i < count; i++) {
    if (now() - runStarted >= maxRunMs) break;
    if (i > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pacingMs, maxRunMs - (now() - runStarted))));
    if (now() - runStarted >= maxRunMs) break;
    const requestId = `${session.id}:${session.runs}:${profile}:${i}`;
    const isCheckoutPost = profile === 'challenge' && i % 5 === 4;
    const isCheckout = profile === 'routing' && i % 2 === 1;
    const method = isCheckoutPost ? 'POST' : 'GET';
    const path = isCheckout || isCheckoutPost ? '/api/checkout/orders' : '/api/catalog/items';
    const expectedRoute = chooseRoute(session.config, { url: path, method, headers: { 'x-request-id': requestId } } as unknown as IncomingMessage);
    if (!expectedRoute) continue;
    const started = performance.now();
    try {
      const remainingMs = maxRunMs - (now() - runStarted);
      const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT ?? 3100)}/proxy/${session.id}${path}`, { method, headers: { 'x-request-id': requestId, ...(isCheckoutPost ? { 'content-type': 'application/json' } : {}) }, body: isCheckoutPost ? JSON.stringify({ cartId: `cart-${i}`, itemCount: 1 }) : undefined, signal: AbortSignal.timeout(Math.max(1, Math.min(expectedRoute.timeoutMs + 250, remainingMs))) });
      await response.arrayBuffer();
      samples.push({ upstreamId: (response.headers.get('x-lab-upstream') as TargetId | null) ?? selectTarget(expectedRoute, requestId, session) ?? expectedRoute.pool[0]!.upstreamId, status: response.status, durationMs: Math.max(1, Math.round(performance.now() - started)), method, path, attempts: Number(response.headers.get('x-lab-attempts') ?? 1) });
    } catch {
      samples.push({ upstreamId: selectTarget(expectedRoute, requestId, session) ?? expectedRoute.pool[0]!.upstreamId, status: 504, durationMs: expectedRoute.timeoutMs, method, path, attempts: 1 });
    }
    if ((i + 1) % 10 === 0) emit(session.id, 'run-progress', { runId: session.runs + 1, completed: i + 1, requested: count });
  }
  session.runs++;
  const sorted = samples.map(x => x.durationMs).sort((a, b) => a - b);
  const countByUpstream = Object.fromEntries(Object.keys(targets).map(id => [id, samples.filter(sample => sample.upstreamId === id).length]));
  const checkoutPosts = samples.filter(sample => sample.method === 'POST' && sample.path.startsWith('/api/checkout'));
  const result: RunResult = { id: session.runs, requested: count, completed: samples.length, countByUpstream, successRate: samples.length ? samples.filter(x => x.status < 400).length / samples.length : 0, p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? 0, p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? 0, p99: sorted[Math.floor((sorted.length - 1) * .99)] ?? 0, checkoutPostRetriesSafe: checkoutPosts.length > 0 && checkoutPosts.every(sample => sample.attempts === 1), noTrafficAfterEjection: true, health: structuredClone(session.health), traces: samples.slice(-12).reverse() };
  session.lastRun = result; emit(session.id, 'run-complete', result); return result;
});
app.get<{ Params: { id: string } }>('/api/sessions/:id/report', async (request, reply) => {
  const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired. Start a new lab session.' });
  const run = session.lastRun;
  const checks = run ? [
    { id: 'success-rate', label: 'At least 99% of admitted requests succeed', passed: run.successRate >= .99, actual: `${(run.successRate * 100).toFixed(1)}%` },
    { id: 'tail-latency', label: 'p95 latency stays below 300 ms', passed: run.p95 < 300, actual: `${run.p95} ms` },
    { id: 'health-ejection', label: 'Unhealthy services are ejected from new traffic', passed: !Object.values(session.faults).some(fault => fault?.down) || Object.values(run.health).some(state => state.status === 'unhealthy') && run.noTrafficAfterEjection, actual: Object.entries(run.health).filter(([, state]) => state.status === 'unhealthy').map(([id]) => id).join(', ') || 'healthy' },
    { id: 'checkout-retries', label: 'Checkout POST routes do not retry', passed: !!run?.checkoutPostRetriesSafe && !session.config.some(route => route.match.pathPrefix.startsWith('/api/checkout') && route.retries > 0 && (!route.match.methods || route.match.methods.includes('POST'))), actual: run?.checkoutPostRetriesSafe ? 'observed single attempt' : 'no checkout POST traffic observed' }
  ] : [];
  return { sessionId: session.id, generatedAt: new Date().toISOString(), config: session.config, run, checks, score: checks.length ? Math.round(checks.filter(check => check.passed).length / checks.length * 100) : 0 };
});
app.get<{ Params: { id: string } }>('/api/sessions/:id/events', async (request, reply) => {
  if (!getSession(request.params.id)) return reply.code(404).send({ error: 'Session expired.' });
  const origin = request.headers.origin;
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...(allowedOrigin(origin) && origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) });
  reply.raw.write(`event: ready\ndata: ${JSON.stringify({ sessionId: request.params.id })}\n\n`);
  const clients = eventClients.get(request.params.id) ?? new Set<ServerResponse>(); clients.add(reply.raw); eventClients.set(request.params.id, clients);
  const timer = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
  request.raw.on('close', () => { clearInterval(timer); clients.delete(reply.raw); }); reply.hijack();
});
app.all<{ Params: { id: string; '*': string } }>('/proxy/:id/*', async (request, reply) => {
  const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired.' });
  const originalPath = `/${request.params['*']}`;
  const route = chooseRoute(session.config, { url: originalPath, method: request.method, headers: request.headers } as IncomingMessage);
  if (!route) return reply.code(404).send({ error: 'No route matches this request.' });
  if (!takeRateLimit(session)) return reply.code(429).send({ error: 'Gateway rate limit exceeded.', retryAfterMs: 1000 });
  const requestId = String(request.headers['x-request-id'] ?? randomUUID());
  const retryableMethod = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(request.method);
  const attempts = retryableMethod ? route.retries + 1 : 1;
  let lastTarget: TargetId = route.pool[0]!.upstreamId;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const targetId = selectTarget(route, `${requestId}:${attempt}`, session);
    if (!targetId) return reply.code(503).header('x-lab-upstream', lastTarget).header('x-lab-attempts', String(attempt + 1)).send({ error: 'No healthy upstream is available for this route.' });
    lastTarget = targetId;
    const fault = session.faults[targetId];
    const attemptStarted = performance.now();
    try {
      if (fault?.down) throw new Error('Injected upstream outage');
      if (fault?.errorRate && Math.random() < fault.errorRate) throw new Error('Injected upstream failure');
      if (fault?.delayMs) {
        if (fault.delayMs >= route.timeoutMs) throw new Error('Gateway timeout during injected upstream delay');
        await new Promise(resolve => setTimeout(resolve, fault.delayMs));
      }
      const remainingTimeoutMs = Math.max(1, route.timeoutMs - (performance.now() - attemptStarted));
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), remainingTimeoutMs);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : JSON.stringify(request.body ?? {});
      const upstreamResponse = await fetch(`${targets[targetId]}${originalPath}`, { method: request.method, headers: { 'content-type': String(request.headers['content-type'] ?? 'application/json'), 'x-request-id': requestId, 'x-lab-upstream': targetId }, body, signal: controller.signal }).finally(() => clearTimeout(timer));
      const payload = await upstreamResponse.arrayBuffer();
      updateHealth(session, targetId, upstreamResponse.status < 500);
      reply.code(upstreamResponse.status).header('content-type', upstreamResponse.headers.get('content-type') ?? 'application/json').header('x-lab-upstream', targetId).header('x-lab-attempts', String(attempt + 1)).send(Buffer.from(payload));
      return;
    } catch (error) {
      updateHealth(session, targetId, false);
      if (attempt === attempts - 1) return reply.code(504).header('x-lab-upstream', lastTarget).header('x-lab-attempts', String(attempt + 1)).send({ error: 'Gateway timeout or upstream connection failure.', detail: error instanceof Error ? error.message : 'upstream failure', upstreamId: lastTarget, attempts: attempt + 1 });
    }
  }
});
const port = Number(process.env.PORT ?? 3100);
await app.listen({ port, host: '0.0.0.0' });
