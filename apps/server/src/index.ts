import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type TargetId = 'catalog-v1' | 'catalog-v2' | 'checkout';
type Route = { id: string; priority: number; match: { pathPrefix: string; methods?: string[]; headers?: Record<string, string> }; pool: Array<{ upstreamId: TargetId; weight: number }>; timeoutMs: number; retries: number };
type HealthState = { status: 'healthy' | 'unhealthy'; failures: number; successes: number; lastChange: number };
type Sample = { upstreamId: TargetId; status: number; durationMs: number };
type RunResult = { id: number; requested: number; completed: number; countByUpstream: Record<string, number>; successRate: number; p50: number; p95: number; p99: number; health: Record<TargetId, HealthState>; traces: Sample[] };
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
const maxRunMs = Math.max(1, Number(process.env.MAX_RUN_SECONDS ?? 30)) * 1000;
const getSession = (id: string) => { const session = sessions.get(id); if (!session || session.expires < now()) { sessions.delete(id); return undefined; } return session; };
function selectTarget(route: Route, requestId: string, session?: Session): TargetId {
  const pool = route.pool.filter(target => !session || session.health[target.upstreamId].status === 'healthy');
  const eligible = pool.length ? pool : route.pool;
  const total = eligible.reduce((sum, target) => sum + target.weight, 0);
  let hash = 2166136261;
  for (const char of requestId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  let pick = (hash >>> 0) % total;
  for (const target of eligible) { if (pick < target.weight) return target.upstreamId; pick -= target.weight; }
  return eligible[0]!.upstreamId;
}
function updateHealth(session: Session, upstreamId: TargetId, ok: boolean) {
  const state = session.health[upstreamId];
  if (ok) { state.failures = 0; state.successes++; if (state.status === 'unhealthy' && state.successes >= 2) { state.status = 'healthy'; state.lastChange = now(); } }
  else { state.successes = 0; state.failures++; if (state.failures >= 3 && state.status === 'healthy') { state.status = 'unhealthy'; state.lastChange = now(); } }
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
  const session: Session = { id: randomUUID(), expires: now() + sessionTtlMs, config: structuredClone(baseConfig), faults: {}, health, rateLimit: { requestsPerSecond: 100, burst: 20, recent: [] }, runs: 0 };
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
  if (rateLimit && (!Number.isInteger(rateLimit.requestsPerSecond) || rateLimit.requestsPerSecond < 1 || rateLimit.requestsPerSecond > 100 || !Number.isInteger(rateLimit.burst) || rateLimit.burst < 0 || rateLimit.burst > 100)) return reply.code(400).send({ error: 'Rate limit must be 1-100 requests per second with a 0-100 burst.' });
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
app.post<{ Params: { id: string } }>('/api/sessions/:id/reset', async (request, reply) => { const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired.' }); session.config = structuredClone(baseConfig); session.faults = {}; session.runs = 0; for (const state of Object.values(session.health)) Object.assign(state, { status: 'healthy', failures: 0, successes: 0, lastChange: now() }); session.rateLimit.recent = []; return { config: session.config, faults: {}, health: session.health }; });
app.post<{ Params: { id: string }; Body: { count?: number } }>('/api/sessions/:id/runs', async (request, reply) => {
  const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired.' });
  const count = Math.min(200, Math.max(1, Math.floor(request.body?.count ?? 40)));
  const samples: Sample[] = [];
  const runStarted = now();
  const pacingMs = Math.max(1, Math.ceil(1000 / session.rateLimit.requestsPerSecond));
  for (let i = 0; i < count; i++) {
    if (now() - runStarted >= maxRunMs) break;
    if (i > 0) await new Promise(resolve => setTimeout(resolve, pacingMs));
    const requestId = `${session.id}:${session.runs}:${i}`;
    const expectedRoute = chooseRoute(session.config, { url: '/api/catalog/items', method: 'GET', headers: { 'x-request-id': requestId } } as unknown as IncomingMessage);
    if (!expectedRoute) continue;
    const started = performance.now();
    try {
      const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT ?? 3100)}/proxy/${session.id}/api/catalog/items`, { headers: { 'x-request-id': requestId }, signal: AbortSignal.timeout(expectedRoute.timeoutMs + 250) });
      await response.arrayBuffer();
      samples.push({ upstreamId: (response.headers.get('x-lab-upstream') as TargetId | null) ?? selectTarget(expectedRoute, requestId, session), status: response.status, durationMs: Math.max(1, Math.round(performance.now() - started)) });
    } catch {
      samples.push({ upstreamId: selectTarget(expectedRoute, requestId, session), status: 504, durationMs: expectedRoute.timeoutMs });
    }
    if ((i + 1) % 10 === 0) emit(session.id, 'run-progress', { runId: session.runs + 1, completed: i + 1, requested: count });
  }
  session.runs++;
  const sorted = samples.map(x => x.durationMs).sort((a, b) => a - b);
  const countByUpstream = Object.fromEntries(Object.keys(targets).map(id => [id, samples.filter(sample => sample.upstreamId === id).length]));
  const result: RunResult = { id: session.runs, requested: count, completed: samples.length, countByUpstream, successRate: samples.length ? samples.filter(x => x.status < 400).length / samples.length : 0, p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? 0, p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? 0, p99: sorted[Math.floor((sorted.length - 1) * .99)] ?? 0, health: structuredClone(session.health), traces: samples.slice(-12).reverse() };
  session.lastRun = result; emit(session.id, 'run-complete', result); return result;
});
app.get<{ Params: { id: string } }>('/api/sessions/:id/report', async (request, reply) => {
  const session = getSession(request.params.id); if (!session) return reply.code(404).send({ error: 'Session expired. Start a new lab session.' });
  const run = session.lastRun;
  const checks = run ? [
    { id: 'success-rate', label: 'At least 99% of admitted requests succeed', passed: run.successRate >= .99, actual: `${(run.successRate * 100).toFixed(1)}%` },
    { id: 'tail-latency', label: 'p95 latency stays below 300 ms', passed: run.p95 < 300, actual: `${run.p95} ms` },
    { id: 'health-ejection', label: 'Unhealthy services are tracked by the gateway', passed: Object.values(run.health).some(state => state.status === 'unhealthy') || !Object.values(session.faults).some(fault => fault?.down || (fault?.errorRate ?? 0) > 0), actual: Object.entries(run.health).filter(([, state]) => state.status === 'unhealthy').map(([id]) => id).join(', ') || 'healthy' },
    { id: 'checkout-retries', label: 'Checkout POST routes do not retry', passed: !session.config.some(route => route.match.pathPrefix.startsWith('/api/checkout') && route.retries > 0 && (!route.match.methods || route.match.methods.includes('POST'))), actual: 'gateway policy' }
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
  let lastTarget: TargetId = selectTarget(route, requestId, session);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const targetId = selectTarget(route, `${requestId}:${attempt}`, session); lastTarget = targetId;
    const fault = session.faults[targetId];
    try {
      if (fault?.down) throw new Error('Injected upstream outage');
      if (fault?.errorRate && Math.random() < fault.errorRate) throw new Error('Injected upstream failure');
      if (fault?.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), route.timeoutMs);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : JSON.stringify(request.body ?? {});
      const upstreamResponse = await fetch(`${targets[targetId]}${originalPath}`, { method: request.method, headers: { 'content-type': String(request.headers['content-type'] ?? 'application/json'), 'x-request-id': requestId, 'x-lab-upstream': targetId }, body, signal: controller.signal }).finally(() => clearTimeout(timer));
      const payload = await upstreamResponse.arrayBuffer();
      updateHealth(session, targetId, upstreamResponse.status < 500);
      reply.code(upstreamResponse.status).header('content-type', upstreamResponse.headers.get('content-type') ?? 'application/json').header('x-lab-upstream', targetId).send(Buffer.from(payload));
      return;
    } catch (error) {
      updateHealth(session, targetId, false);
      if (attempt === attempts - 1) return reply.code(504).send({ error: 'Gateway timeout or upstream connection failure.', detail: error instanceof Error ? error.message : 'upstream failure', upstreamId: lastTarget, attempts: attempt + 1 });
    }
  }
});
const port = Number(process.env.PORT ?? 3100);
await app.listen({ port, host: '0.0.0.0' });
