// 차요우 다원 방문 통계 — aggregated counts only (no names, no IP addresses).
//
// Each visitor's browser keeps an anonymous random id, so a day's unique visitors and new-vs-returning can be
// counted. Everything is grouped by the Korean date (KST). The numbers are saved as stats.json on the "stats"
// branch of the GitHub repository every 10 minutes and when the server shuts down; on start the saved numbers
// are loaded and counting continues. Without STATS_GITHUB_TOKEN the counts live only in memory (lost on restart).
//
//   STATS_GITHUB_TOKEN  fine-grained token, this repository only, permission "Contents: Read and write"
//   STATS_REPO          owner/repo (default chayou0405/chayou-dawon)
'use strict';
const TOKEN = process.env.STATS_GITHUB_TOKEN || '', REPO = process.env.STATS_REPO || 'chayou0405/chayou-dawon';
const BRANCH = 'stats', FILE = 'stats.json', SAVE_MS = +process.env.STATS_SAVE_MS || 10 * 60000, API = process.env.STATS_API || 'https://api.github.com';

const kst = (t = Date.now()) => new Date(t + 9 * 3600e3);
const dayKey = t => kst(t).toISOString().slice(0, 10);
const STAY = [[60, '1분 미만'], [300, '1~5분'], [900, '5~15분'], [1800, '15~30분'], [3600, '30~60분'], [Infinity, '1시간 이상']];

let data = { version: 1, visitors: {}, days: {} }, dirty = false, sha = null, loaded = !TOKEN;
const live = new Map();   // uid -> { since, day, phone }

function day(t) {
  const k = dayKey(t);
  return data.days[k] || (data.days[k] = { visits: 0, unique: [], newVisitors: 0, phone: 0, pc: 0, hours: Array(24).fill(0),
    peak: 0, peakAt: null, channels: {}, staySec: 0, stays: 0, stayBuckets: {}, acts: {}, teas: {} });
}
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

// someone came in (a new visit, not a reload or reconnect of the same session)
function visit(p, ch, vid, phone) {
  const t = Date.now(), d = day(t);
  vid = typeof vid === 'string' && /^[\w-]{6,40}$/.test(vid) ? vid : 'anon-' + p.uid;
  d.visits++; d.hours[kst(t).getUTCHours()]++; inc(d.channels, ch);
  if (!d.unique.includes(vid)) { d.unique.push(vid); if (phone) d.phone++; else d.pc++; }
  if (!data.visitors[vid]) { data.visitors[vid] = dayKey(t); d.newVisitors++; }
  live.set(p.uid, { since: t, phone: !!phone });
  dirty = true;
}
function rejoin(p, phone) { live.set(p.uid, { since: Date.now(), phone: !!phone }); }
// the character really left (goodbye, background timeout, grace over, server shutting down)
function leave(p) {
  const v = live.get(p.uid); if (!v) return; live.delete(p.uid);
  const sec = Math.round((Date.now() - v.since) / 1000), d = day();
  d.staySec += sec; d.stays++; inc(d.stayBuckets, STAY.find(([s]) => sec < s)[1]);
  dirty = true;
}
function online(total) { const d = day(); if (total > d.peak) { d.peak = total; d.peakAt = kst().toISOString().slice(11, 16); dirty = true; } }
function act(kind, n = 1) { inc(day().acts, kind, n); dirty = true; }
function tea(key) { if (typeof key === 'string' && key.length <= 24) { inc(day().teas, key); act('찻잎 고르기'); } }

/* ---------- saving to GitHub (branch "stats", file stats.json) ---------- */
async function gh(method, url, body) {
  const r = await fetch(API + url, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: 'Bearer ' + TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'chayou-dawon-stats', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) } });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, j };
}
async function readFile() {
  const r = await gh('GET', `/repos/${REPO}/contents/${FILE}?ref=${BRANCH}`);
  if (r.ok) { sha = r.j.sha; return JSON.parse(Buffer.from(r.j.content, 'base64').toString('utf8')); }
  if (r.status === 404) {   // no stats branch yet: start it from main
    const main = await gh('GET', `/repos/${REPO}/git/ref/heads/main`);
    if (main.ok) await gh('POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/' + BRANCH, sha: main.j.object.sha });
    return null;
  }
  throw new Error('GitHub ' + r.status + ' ' + (r.j && r.j.message));
}
// counts made before the saved file was loaded are added on top of it
function merge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === 24 && b.length === 24 && typeof a[0] === 'number' ? a.map((v, i) => v + b[i]) : [...new Set([...a, ...b])];
  if (a && b && typeof a === 'object' && typeof b === 'object') { const o = { ...a }; for (const k in b) o[k] = k in o ? (k === 'peak' ? Math.max(o[k], b[k]) : k === 'peakAt' ? (a.peak >= b.peak ? a.peakAt : b.peakAt) : merge(o[k], b[k])) : b[k]; return o; }
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? a : b;   // a visitor's first day: the earlier one
  return a ?? b;
}
async function load() {
  if (!TOKEN) { console.log('통계: STATS_GITHUB_TOKEN이 없어 메모리에만 저장해요 (서버가 재시작되면 초기화).'); return; }
  try { const saved = await readFile(); if (saved) data = merge(saved, data); loaded = true; console.log('통계: GitHub stats 브랜치에서 불러왔어요.'); }
  catch (e) { console.log('통계: 불러오기 실패 —', e.message); setTimeout(load, 60000); }
}
let saving = null;
async function save() {
  if (!TOKEN || !loaded || !dirty) return;
  if (saving) return saving;
  saving = (async () => {
    dirty = false;
    const body = { message: 'stats ' + kst().toISOString().slice(0, 16).replace('T', ' ') + ' KST', branch: BRANCH,
      content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    let r = await gh('PUT', `/repos/${REPO}/contents/${FILE}`, body);
    if (!r.ok && (r.status === 409 || r.status === 422)) {   // the file changed meanwhile: take its version and retry
      const g = await gh('GET', `/repos/${REPO}/contents/${FILE}?ref=${BRANCH}`); if (g.ok) { body.sha = sha = g.j.sha; r = await gh('PUT', `/repos/${REPO}/contents/${FILE}`, body); }
    }
    if (r.ok) sha = r.j.content.sha; else { dirty = true; console.log('통계: 저장 실패 —', r.status, r.j && r.j.message); }
  })().catch(e => { dirty = true; console.log('통계: 저장 실패 —', e.message); }).finally(() => { saving = null; });
  return saving;
}
// shutting down (Render stops a sleeping free server with SIGTERM): close open visits, save, then exit
async function flush(players) { for (const p of players) leave(p); await save(); }

load();
setInterval(save, SAVE_MS).unref();
module.exports = { visit, rejoin, leave, online, act, tea, flush, save, get data() { return data; } };
