import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowRight, Check, ChevronDown, CircleHelp, Gauge, GitBranch, Layers3, Play, RotateCcw, Server, ShieldCheck, Signal, SlidersHorizontal, Sparkles, Waypoints, X } from 'lucide-react';

const api = import.meta.env.VITE_LAB_API_URL ?? 'http://localhost:3100';
type Route = { id: string; priority: number; match: { pathPrefix: string; methods?: string[]; headers?: Record<string, string> }; pool: { upstreamId: string; weight: number }[]; timeoutMs: number; retries: number };
type Run = { id: number; requested: number; completed: number; countByUpstream: Record<string, number>; successRate: number; p50: number; p95: number; p99: number; health: Record<string, { status: string }>; traces: { upstreamId: string; status: number; durationMs: number }[] };
type LabReport = { score: number; checks: { id: string; label: string; passed: boolean; actual: string }[] };
const lessons = [
  { title: 'HTTP routing', subtitle: 'Paths, methods & rewrites', icon: Waypoints },
  { title: 'Canary release', subtitle: 'Weighted traffic split', icon: GitBranch },
  { title: 'Failure & recovery', subtitle: 'Health, timeout, retries', icon: ShieldCheck },
  { title: 'SLO challenge', subtitle: 'Design for a slow service', icon: Gauge }
];
const lessonCopy = [
  { eyebrow: 'EXPERIMENT 01', label: 'HTTP ROUTING', title: <>Give every request<br /> a clear destination.</>, description: 'Trace path and method rules from the client to the right synthetic service.' },
  { eyebrow: 'EXPERIMENT 02', label: 'CANARY RELEASE', title: <>Let a little traffic<br /> try the new thing.</>, description: 'Split catalog requests between two versions. Then measure what actually happened.' },
  { eyebrow: 'EXPERIMENT 03', label: 'FAILURE & RECOVERY', title: <>When a service slows,<br /> make the gateway adapt.</>, description: 'Inject a fault, watch health transitions, and tune the gateway response.' },
  { eyebrow: 'FINAL CHALLENGE', label: 'SLO DESIGN', title: <>Keep the promise<br /> under pressure.</>, description: 'Meet the success and latency targets while one upstream becomes unreliable.' }
];
const names: Record<string, string> = { 'catalog-v1': 'Catalog v1', 'catalog-v2': 'Catalog v2', checkout: 'Checkout' };
const colors: Record<string, string> = { 'catalog-v1': 'pine', 'catalog-v2': 'violet', checkout: 'blue' };

export default function App() {
  const [session, setSession] = useState('');
  const [routes, setRoutes] = useState<Route[]>([]);
  const [activeLesson, setActiveLesson] = useState(1);
  const [requestCount, setRequestCount] = useState(200);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedRule, setSelectedRule] = useState('catalog');
  const [faulted, setFaulted] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [tab, setTab] = useState<'metrics' | 'traces'>('metrics');
  const [report, setReport] = useState<LabReport | null>(null);
  const catalog = routes.find(route => route.id === selectedRule) ?? routes[0];
  const currentLesson = lessonCopy[activeLesson]!;

  async function request(path: string, init?: RequestInit) {
    const response = await fetch(`${api}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
  }
  async function createSession() {
    try { const created = await request('/api/sessions', { method: 'POST' }); setSession(created.id); setRoutes(created.config); setError(''); }
    catch { setError('The lab server is waking up. Check that the API is running, then start a new session.'); }
  }
  useEffect(() => { void createSession(); }, []);
  useEffect(() => {
    if (!session) return;
    const events = new EventSource(`${api}/api/sessions/${session}/events`);
    events.addEventListener('ready', () => setStreamReady(true));
    events.addEventListener('run-progress', event => { const progress = JSON.parse((event as MessageEvent).data) as { completed: number; requested: number }; setNotice(`Sending ${progress.completed} of ${progress.requested} requests`); });
    events.addEventListener('run-complete', event => { setRun(JSON.parse((event as MessageEvent).data) as Run); setNotice('Run complete'); });
    events.onerror = () => setStreamReady(false);
    return () => events.close();
  }, [session]);
  const completed = useMemo(() => lessons.map((_, i) => i < activeLesson), [activeLesson]);
  async function save(next: Route[]) {
    setRoutes(next); setError('');
    try { await request(`/api/sessions/${session}/config`, { method: 'PUT', body: JSON.stringify(next) }); setNotice('Configuration saved'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save configuration'); }
  }
  async function updateWeight(upstreamId: string, weight: number) {
    if (!catalog) return;
    const other = catalog.pool.find(target => target.upstreamId !== upstreamId);
    const pool = catalog.pool.map(target => target.upstreamId === upstreamId ? { ...target, weight } : target === other ? { ...target, weight: 100 - weight } : target);
    setRoutes(routes.map(route => route.id === catalog.id ? { ...route, pool } : route));
  }
  async function startRun() {
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/api/sessions/${session}/config`, { method: 'PUT', body: JSON.stringify(routes) });
      setRun(await request(`/api/sessions/${session}/runs`, { method: 'POST', body: JSON.stringify({ count: requestCount }) }));
      setReport(await request(`/api/sessions/${session}/report`));
      setNotice('Run complete');
    }
    catch (e) { setError(e instanceof Error ? e.message : 'The run could not be completed'); }
    finally { setBusy(false); }
  }
  async function injectFault() {
    try {
      if (faulted) await request(`/api/sessions/${session}/faults`, { method: 'DELETE' });
      else await request(`/api/sessions/${session}/faults`, { method: 'POST', body: JSON.stringify({ upstreamId: 'catalog-v2', delayMs: 350, errorRate: .4 }) });
      setFaulted(!faulted); setNotice(faulted ? 'Faults cleared' : 'Catalog v2 slowed and returning errors');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not change upstream fault'); }
  }
  async function reset() {
    try { const result = await request(`/api/sessions/${session}/reset`, { method: 'POST' }); setRoutes(result.config); setRun(null); setReport(null); setFaulted(false); setNotice('Lesson reset'); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not reset the lesson'); }
  }
  function exportReport() {
    const report = `<!doctype html><meta charset="utf-8"><title>Gateway lab report</title><style>body{font:16px system-ui;max-width:760px;margin:4rem auto;color:#18231f}table{border-collapse:collapse}td,th{padding:10px;border:1px solid #ccd4ce;text-align:left}</style><h1>Gateway lab report</h1><p>Completed ${new Date().toLocaleString()}</p><h2>Canary release</h2><p>Configuration: ${catalog?.pool.map(item => `${names[item.upstreamId]} ${item.weight}%`).join(', ')}</p>${run ? `<h2>Observed run</h2><p>${run.completed} requests · ${(run.successRate * 100).toFixed(1)}% success · p95 ${run.p95} ms</p>` : '<p>No traffic run recorded.</p>'}`;
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([report], { type: 'text/html' })); anchor.download = 'gateway-lab-report.html'; anchor.click(); URL.revokeObjectURL(anchor.href);
  }

  return <main className="shell">
    <header className="topbar"><a className="brand" href="#top" aria-label="Breakwater Lab home"><span className="brand-mark"><Activity size={18} /></span><span>breakwater<span className="brand-light"> lab</span></span></a><div className="crumb"><span>Virtual labs</span><ArrowRight size={14} /><strong>Dynamic API gateway</strong></div><div className="top-right"><span className="session-pill"><span className={streamReady ? 'live-dot' : 'live-dot quiet'} />{streamReady ? 'Lab connected' : 'Connecting'}</span><button className="icon-button" aria-label="Help"><CircleHelp size={18} /></button><div className="avatar">S</div></div></header>
    <div className="layout">
      <aside className="lesson-rail"><div className="course-label">NETWORK ENGINEERING <span>LAB 04</span></div><div className="rail-title">Dynamic API<br />gateway</div><p className="rail-description">Shape traffic. Watch the system respond.</p><div className="progress-line"><span style={{ width: `${22 + activeLesson * 18}%` }} /></div><div className="progress-copy"><span>YOUR PROGRESS</span><strong>{activeLesson + (run ? 1 : 0)} of 4</strong></div>
        <nav aria-label="Lab activities" className="lesson-list">{lessons.map((lesson, i) => { const Icon = lesson.icon; return <button key={lesson.title} className={`lesson-item ${activeLesson === i ? 'selected' : ''} ${completed[i] ? 'done' : ''}`} onClick={() => setActiveLesson(i)}><span className="lesson-icon">{completed[i] ? <Check size={16} /> : <Icon size={16} />}</span><span className="lesson-text"><strong>{lesson.title}</strong><small>{lesson.subtitle}</small></span>{activeLesson === i && <span className="lesson-arrow"><ArrowDownRight size={15} /></span>}</button>; })}</nav>
        <div className="rail-bottom"><div className="rail-help"><Sparkles size={16} /><span><strong>Need a nudge?</strong><small>Hints are here when you need them.</small></span><ChevronDown size={14} /></div><button className="reset-link" onClick={() => void reset()} disabled={!session}><RotateCcw size={14} /> Reset this lesson</button></div>
      </aside>
      <section className="workspace">
        <div className="page-heading"><div><div className="eyebrow"><span>{currentLesson.eyebrow}</span><span className="eyebrow-line" /> {currentLesson.label}</div><h1>{currentLesson.title}</h1><p>{currentLesson.description}</p></div><div className="heading-actions"><button className="button subtle" onClick={exportReport}><span>Export report</span><ArrowDownRight size={15} /></button></div></div>
        <div className="experiment-row"><div className="experiment-step"><span className="step-marker">01</span><div><strong>{activeLesson === 3 ? 'Set your SLO target' : activeLesson === 2 ? 'Make a failure prediction' : 'Make a prediction'}</strong><small>{activeLesson === 0 ? 'Which rule should handle /api/checkout?' : activeLesson === 2 ? 'What happens to p95 when catalog v2 slows?' : activeLesson === 3 ? 'Can the gateway keep p95 below 300 ms?' : 'What share of 200 requests will reach v2?'}</small></div></div><div className="prediction-card"><span>{activeLesson === 3 ? 'TARGET p95' : 'YOUR PREDICTION'}</span><strong>{activeLesson === 3 ? '300' : '20'}<span> {activeLesson === 3 ? 'ms' : '%'}</span></strong><span>{activeLesson === 3 ? 'maximum latency' : 'to the new version'}</span><button className="prediction-edit" aria-label="Change prediction"><SlidersHorizontal size={15} /></button></div></div>
        <section className="topology-card" aria-label="Live gateway topology"><div className="card-head"><div><span className="section-kicker">LIVE TOPOLOGY</span><h2>Requests have a route.</h2></div><div className="topology-legend"><span><i className="legend-dot healthy" />Healthy</span><span><i className="legend-dot degraded" />Degraded</span></div></div>
          <div className="topology-flow"><div className="node client-node"><div className="node-symbol client-symbol"><Activity size={20} /></div><strong>Browser client</strong><small>200 requests</small></div><div className="flow-wire"><span className="wire-label">HTTP / TLS</span><span className="wire-track"><i /></span></div><button className="node gateway-node" onClick={() => setSelectedRule('catalog')}><div className="node-symbol gateway-symbol"><Waypoints size={21} /></div><strong>API gateway</strong><small>3 active routes</small><span className="node-badge">L7</span></button><div className="branch-lines"><span /><span /></div><div className="services">{(['catalog-v1', 'catalog-v2', 'checkout'] as const).map(id => <button key={id} className={`service-node ${run?.health[id]?.status === 'unhealthy' || (faulted && id === 'catalog-v2') ? 'warn' : ''}`} onClick={() => setSelectedRule(id === 'checkout' ? 'checkout' : 'catalog')}><span className={`service-icon ${colors[id]}`}><Layers3 size={17} /></span><span className="service-copy"><strong>{names[id]}</strong><small>{run?.countByUpstream[id] ?? 0} requests</small></span><span className={`health ${run?.health[id]?.status === 'unhealthy' || (faulted && id === 'catalog-v2') ? 'health-warn' : ''}`}><i />{run?.health[id]?.status === 'unhealthy' ? 'Ejected' : faulted && id === 'catalog-v2' ? 'Degraded' : 'Healthy'}</span></button>)}</div></div>
          <div className="topology-foot"><span><span className="tiny-wave">〰</span>Traffic follows your rules in real time</span><span className="served-label"><i />Services responding</span></div>
        </section>
        <div className="lower-grid"><section className="config-card"><div className="card-head compact"><div><span className="section-kicker">ROUTE INSPECTOR</span><h2>{activeLesson === 0 ? 'Start with the path.' : activeLesson === 2 ? 'Tune the safety net.' : activeLesson === 3 ? 'Choose a resilient policy.' : 'Shape the canary.'}</h2></div><button className="more-button" aria-label="More route options">···</button></div><div className="route-summary"><div className="route-method">GET</div><code>/api/catalog/*</code><span className="route-caret">⌄</span></div><div className="split-header"><span>{activeLesson === 0 ? 'MATCHING RULE' : 'UPSTREAM WEIGHTS'}</span><span>{activeLesson === 2 ? 'HEALTH SIGNAL' : 'TRAFFIC SPLIT'}</span></div>{catalog?.pool.filter(item => item.upstreamId.startsWith('catalog')).map(item => <div className="weight-row" key={item.upstreamId}><span className={`weight-dot ${colors[item.upstreamId]}`} /><span className="weight-name">{names[item.upstreamId]}</span><span className="weight-number">{item.weight}<small>%</small></span><input aria-label={`${names[item.upstreamId]} traffic weight`} type="range" min="1" max="99" value={item.weight} onChange={e => updateWeight(item.upstreamId, Number(e.target.value))} onPointerUp={() => void save(routes)} onKeyUp={() => void save(routes)} onBlur={() => void save(routes)} /><span className="weight-share">{run?.countByUpstream[item.upstreamId] != null && run.completed ? `${Math.round(run.countByUpstream[item.upstreamId]! / run.completed * 100)}%` : '—'}</span></div>)}<div className="inspector-divider" /><div className="route-options"><span><small>TIMEOUT</small><strong>{catalog?.timeoutMs ?? 1000} ms</strong></span><span><small>RETRIES</small><strong>{catalog?.retries ?? 0} attempts</strong></span><button className="text-button" onClick={() => void injectFault()}><Signal size={14} />{faulted ? 'Clear fault' : 'Inject v2 fault'}</button></div><div className="config-note"><span>i</span><span>{activeLesson === 2 ? 'Three consecutive failures eject a service from selection. Two healthy responses bring it back.' : 'Weights are applied to new requests. Existing connections finish on their current upstream.'}</span></div></section>
          <section className="run-card"><span className="section-kicker">TRAFFIC GENERATOR</span><h2>{activeLesson === 3 ? 'Try the challenge.' : 'Put it to the test.'}</h2><p>{activeLesson === 3 ? 'Run the fixed profile, then use the checks to tune your gateway.' : 'Send repeatable requests through the live proxy and inspect the results.'}</p><label className="request-control"><span>Requests</span><select value={requestCount} onChange={e => setRequestCount(Number(e.target.value))}><option value="50">50 requests</option><option value="100">100 requests</option><option value="200">200 requests</option></select><ChevronDown size={14} /></label><button className="run-button" onClick={() => void startRun()} disabled={!session || busy}>{busy ? <><span className="spinner" /> Sending requests…</> : <><Play size={16} fill="currentColor" /> Run experiment <ArrowRight size={16} /></>}</button><div className="run-foot"><span><i />Deterministic run</span><span><i />Synthetic traffic</span></div></section></div>
        {error && <div role="alert" className="inline-alert"><span>{error}</span>{!session && <button onClick={() => void createSession()}>Try again</button>}<button className="alert-close" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
        {(notice || run) && <section className="results-card"><div className="results-head"><div><span className="section-kicker">OBSERVABILITY DECK</span><h2>{run ? `Run ${String(run.id).padStart(2, '0')} · What happened` : notice}</h2></div><div className="result-tabs"><button className={tab === 'metrics' ? 'active' : ''} onClick={() => setTab('metrics')}>Metrics</button><button className={tab === 'traces' ? 'active' : ''} onClick={() => setTab('traces')}>Traces</button></div></div>{run && tab === 'metrics' && <div className="metrics-grid"><div className="metric"><small>REQUESTS</small><strong>{run.completed}<span>/{run.requested}</span></strong><em>completed</em></div><div className="metric"><small>SUCCESS RATE</small><strong>{(run.successRate * 100).toFixed(1)}<span>%</span></strong><em>admitted requests</em></div><div className="metric"><small>p95 LATENCY</small><strong>{run.p95}<span> ms</span></strong><em>95th percentile</em></div><div className="metric"><small>p99 LATENCY</small><strong>{run.p99}<span> ms</span></strong><em>99th percentile</em></div><div className="distribution"><div><small>OBSERVED DISTRIBUTION</small><strong>{names['catalog-v1']} <b>{run.countByUpstream['catalog-v1'] ?? 0}</b></strong><strong>{names['catalog-v2']} <b>{run.countByUpstream['catalog-v2'] ?? 0}</b></strong></div><div className="distribution-bar"><span style={{ width: `${run.completed ? (run.countByUpstream['catalog-v1'] ?? 0) / run.completed * 100 : 0}%` }} /><i /></div><em>Compare observed traffic with your configured weights.</em></div></div>}{run && activeLesson === 3 && report && <div className="challenge-checks"><div className="challenge-score"><span className="section-kicker">SLO CHALLENGE</span><strong>{report.score}<small>/100</small></strong><em>{report.score === 100 ? 'Target met' : 'Tune the gateway and run again'}</em></div><div className="check-list">{report.checks.map(check => <div className="check-row" key={check.id}><span className={check.passed ? 'check-pass' : 'check-fail'}>{check.passed ? '✓' : '!'}</span><span>{check.label}</span><code>{check.actual}</code></div>)}</div></div>}{run && tab === 'traces' && <div className="trace-list">{run.traces.map((trace, i) => <div className="trace-row" key={`${trace.upstreamId}-${i}`}><span className={trace.status < 400 ? 'status-ok' : 'status-fail'}>{trace.status}</span><code>GET /api/catalog/items</code><span>{names[trace.upstreamId]}</span><strong>{trace.durationMs} ms</strong></div>)}</div>}</section>}
      </section>
    </div>
    <footer className="footer"><span>BREAKWATER LAB <i>·</i> A NETWORKING VIRTUAL LAB</span><span>Requests are synthetic. Results are real. <a href="https://github.com/xevrion/breakscale" target="_blank" rel="noreferrer">How this lab works <ArrowRight size={12} /></a></span></footer>
    <div className="sr-only" role="status" aria-live="polite">{notice}</div>
  </main>;
}
