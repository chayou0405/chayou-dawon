// 차요우 다원 실시간 서버 — Node 18+ only, no npm dependencies.
// Serves the game files (index.html, tex/) and a WebSocket endpoint at /ws on the same port.
//
//   node server.js            → http://localhost:8080  (game)   ws://localhost:8080/ws  (realtime)
//   PORT=10000 node server.js → for hosts that assign a port (Render, Railway, Fly …)
//
// The server is the single source of truth for: who is on which server ("channel"), the 88-person cap,
// nicknames (unique per channel), session resume after a reload, seat occupancy, the host (팽주) role,
// each player's chosen tea and remaining infusions, every guest cup, and table events (serve, drink, 함께 한 모금).
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');

const PORT = +process.env.PORT || 8080;
const CAP = +process.env.CAP || 88;            // per channel, hosts and guests included
const GRACE = +process.env.GRACE_MS || 90000;   // a dropped connection keeps its character, name and seat this long (phones in the background)
const LEAVE_MS = +process.env.LEAVE_MS || 6000;   // after the page says goodbye, the character leaves this soon unless a reload brings it back
const LOG = process.env.DEBUG_LOG !== '0';     // dev log to stdout (server console only, never shown to players)
const MAX_CHANNELS = 50, NTABLES = 8, NSEAT = 5, INFUSIONS = 3, SIPS = 3;   // brewed once, then shared up to 3 times; a poured cup is three sips
const ROOT = __dirname;

const A = ['살랑','소담','몽글','포근','고요한','느린','여린','은은한','잔잔한','다정한','따스한','아늑한'];
const B = ['구름','이슬','바람','달빛','잎새','여울','윤슬','꽃잎','노을','안개','햇살','물결'];
const NICKS = A.flatMap(a => B.map(b => a + b));   // 144

// NPC tea guests fill the hall while it is quiet and make room as people arrive.
// up to 10 people: 10 NPCs, 20: 8, 30: 7, 40: 6, 50: 5, 60: 4, 70: 3, 80: 2, more: 1
const npcCount = users => users <= 10 ? 10 : Math.max(1, 10 - Math.ceil(users / 10));
// seats they take, in order (a host before its guests; the last ones leave first). Seat holder id: "npc:ti-k"
const NPC_PLAN = [[0, 0], [0, 1], [0, 2], [4, 0], [4, 1], [7, 0], [7, 2], [0, 3], [4, 3], [7, 4]];
const isNpc = h => typeof h === 'string' && h.startsWith('npc:');

const channels = new Map();
let cidSeq = 0;
// dev log: one line per lifecycle event with user id, connection id, server(channel) id and seat
function L(ev, o) { if (LOG) console.log(new Date().toISOString().slice(11, 23), ev, JSON.stringify(o)); }
const seatId = s => s ? `T${s[0]}-${s[1]}` : null;
function syncNpcs(c) {
  const want = new Set(); let n = npcCount(c.players.size);
  for (const [ti, k] of NPC_PLAN) {
    if (n <= 0) break; const h = c.seats[ti][k];
    if (h && !isNpc(h)) continue;                                       // a person sits there: skip this seat
    if (k > 0) { const host = c.seats[ti][0]; if (!(want.has(ti + '-0') || (host && isNpc(host) && want.has(ti + '-0')))) continue; }   // NPC guests only at an NPC host's table
    want.add(ti + '-' + k); n--;
  }
  // leave first (guests before hosts), then sit down
  for (let ti = 0; ti < NTABLES; ti++) for (let k = NSEAT - 1; k >= 0; k--) {
    const h = c.seats[ti][k]; if (!isNpc(h) || want.has(ti + '-' + k)) continue;
    if (k > 0) c.tables[ti].cups[k] = 0; else { c.tables[ti].brewed = false; c.tables[ti].tea = null; }
    setSeat(c, ti, k, null);
  }
  for (const key of want) { const [ti, k] = key.split('-').map(Number); if (c.seats[ti][k]) continue;
    if (k === 0) { c.tables[ti].brewed = true; c.tables[ti].tea = null; }   // an NPC host always has tea in the fair cup
    setSeat(c, ti, k, 'npc:' + key);
  }
}
function channel(id) {
  let c = channels.get(id);
  if (!c) {
    c = { id, players: new Map(), bySid: new Map(), retired: new Map(), ver: 0,
      seats: Array.from({ length: NTABLES }, () => Array(NSEAT).fill(null)),
      seatVer: Array.from({ length: NTABLES }, () => Array(NSEAT).fill(0)),   // version of each seat's last change: clients drop older updates
      tables: Array.from({ length: NTABLES }, () => ({ tea: null, ready: false, brewed: false, cups: Array(NSEAT).fill(0) })) };
    channels.set(id, c);
  }
  return c;
}
const occupancy = c => c.players.size;   // online players + players inside their reconnect grace window
const pub = p => ({ uid: p.uid, nick: p.nick, look: p.look, st: p.st, q: p.stq, online: p.online, seat: p.seat, tea: p.tea, teaLeft: p.teaLeft, brewedAt: p.brewedAt });
const tableState = (c, ti) => ({ ti, tea: c.tables[ti].tea, ready: c.tables[ti].ready, cups: c.tables[ti].cups, seats: c.seats[ti], sv: c.seatVer[ti] });
// every seat change goes through here: one owner per seat, decided only by the server, stamped with a version
function setSeat(c, ti, k, uid) { c.seats[ti][k] = uid; const v = c.seatVer[ti][k] = ++c.ver; broadcast(c, { t: 'seat', ti, k, uid, v }); return v; }

function send(ws, m) { if (ws && ws.readyState === 1) wsSend(ws, JSON.stringify(m)); }
function broadcast(c, m, except) { const s = JSON.stringify(m); for (const p of c.players.values()) if (p.online && p.ws && p.ws !== except) wsSend(p.ws, s); }

function freeSeat(c, p) {
  if (!p.seat) return;
  const [ti, k] = p.seat;
  if (c.seats[ti][k] === p.uid) {
    if (k > 0) c.tables[ti].cups[k] = 0;
    if (k === 0) { c.tables[ti].ready = false; c.tables[ti].brewed = false; c.tables[ti].brewing = false; }
    setSeat(c, ti, k, null); L('stand', { uid: p.uid, ch: c.id, seat: seatId(p.seat) });
  }
  p.seat = null;
}
function removePlayer(c, p, why) {
  L('remove', { uid: p.uid, ch: c.id, why, seat: seatId(p.seat) });
  freeSeat(c, p); c.players.delete(p.uid); c.bySid.delete(p.sid);
  c.retired.set(p.sid, { uid: p.uid, nick: p.nick, t: Date.now() });   // the same session coming back much later gets its id and name again
  broadcast(c, { t: 'leave', uid: p.uid });
  syncNpcs(c);
  if (!c.players.size) channels.delete(c.id);
}

function onMessage(conn, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') return hello(conn, m);
  const c = conn.c, p = conn.p; if (!c || !p) return;
  if (p.ws !== conn.ws) return;   // a replaced, older connection of this session: its late messages must not touch the current state
  switch (m.t) {
    case 'st': {   // position, facing, pose
      const s = m.s || {}; const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
      p.st = { x: num(s.x), y: num(s.y), z: num(s.z), ry: num(s.ry), p: ['stand','sit','squat'].includes(s.p) ? s.p : 'stand', st: num(s.st) || .42, m: s.m ? 1 : 0, v: s.v === 0 ? 0 : 1 };
      if (Array.isArray(s.b) && s.b.length === 3) p.st.b = s.b.map(num);   // raft pose while riding
      p.stq = (p.stq || 0) + 1;   // order stamp: a client ignores any position older than the one it already has
      broadcast(c, { t: 'st', uid: p.uid, s: p.st, q: p.stq }, conn.ws); break;
    }
    case 'tea': {  // picked a tea at the cabinet
      if (p.tea && p.teaLeft > 0 && !m.swap) return send(conn.ws, { t: 'player', uid: p.uid, tea: p.tea, teaLeft: p.teaLeft, brewedAt: p.brewedAt });
      if (m.swap && p.seat && p.seat[1] === 0) { const T = c.tables[p.seat[0]]; T.brewed = false; T.ready = false; }   // a host with a new tea brews it fresh
      if (typeof m.key !== 'string' || m.key.length > 24) return;
      p.tea = m.key; p.teaLeft = m.swap ? INFUSIONS : Math.max(1, Math.min(INFUSIONS, (m.left | 0) || INFUSIONS)); p.brewedAt = null;
      L('tea', { uid: p.uid, ch: c.id, key: m.key, swap: !!m.swap });
      broadcast(c, { t: 'player', uid: p.uid, tea: p.tea, teaLeft: p.teaLeft, brewedAt: null }); break;
    }
    case 'sit': {
      const ti = m.ti | 0, k = m.k | 0;
      if (ti < 0 || ti >= NTABLES || k < 0 || k >= NSEAT) return;
      const holder = c.seats[ti][k];
      // Node runs this handler to completion before the next message, so two people asking for one seat at once
      // are decided here one after the other: the first gets it, the second is told it is taken
      if (holder && holder !== p.uid) { L('sitDenied', { uid: p.uid, cid: conn.cid, ch: c.id, seat: seatId([ti, k]), holder }); return send(conn.ws, { t: 'seatDenied', ti, k, why: 'taken', holder, v: c.seatVer[ti][k] }); }
      if (k === 0 && holder !== p.uid && !(p.tea && p.teaLeft > 0)) { L('sitDenied', { uid: p.uid, ch: c.id, seat: seatId([ti, k]), why: 'noTea' }); return send(conn.ws, { t: 'seatDenied', ti, k, why: 'noTea' }); }   // 팽주석 needs a tea from the cabinet (a host who already sits there keeps it)
      if (holder === p.uid) { send(conn.ws, { t: 'seat', ti, k, uid: p.uid, v: c.seatVer[ti][k] }); break; }   // already mine: just confirm
      if (p.seat && (p.seat[0] !== ti || p.seat[1] !== k)) freeSeat(c, p);
      p.seat = [ti, k];
      setSeat(c, ti, k, p.uid); L('sit', { uid: p.uid, cid: conn.cid, ch: c.id, seat: seatId(p.seat) });
      broadcast(c, { t: 'table', ...tableState(c, ti) });
      // a new guest at a table whose host has already brewed gets a cup straight away
      const hostUid = c.seats[ti][0], T = c.tables[ti];
      if (k > 0 && hostUid && hostUid !== p.uid && T.brewed && !T.cups[k]) {
        T.cups[k] = SIPS;
        L('serveNewGuest', { uid: p.uid, ch: c.id, seat: seatId([ti, k]) });
        setTimeout(() => { if (c.seats[ti][k] === p.uid && c.seats[ti][0] === hostUid) broadcast(c, { t: 'serveOne', ti, k, tea: T.tea, by: hostUid }); }, 900);   // straight from the fair cup, no new infusion
      } else if (k > 0 && hostUid && hostUid !== p.uid && !T.brewed) {
        const h = c.players.get(hostUid); if (h) send(h.ws, { t: 'newGuest', ti, k });
        // the host does nothing for 3 seconds (does not start brewing): tea is poured from the fair cup to the new guest
        if (h && h.tea && h.teaLeft > 0) setTimeout(() => {
          if (c.seats[ti][k] !== p.uid || c.seats[ti][0] !== hostUid || T.brewed || T.brewing || T.cups[k]) return;
          T.brewed = true; T.tea = T.tea || h.tea; h.brewedAt = ti; T.cups[k] = SIPS;   // what is in the fair cup: the table's last brewed tea
          L('autoPour', { uid: p.uid, host: hostUid, ch: c.id, seat: seatId([ti, k]) });
          broadcast(c, { t: 'player', uid: h.uid, tea: h.tea, teaLeft: h.teaLeft, brewedAt: h.brewedAt });
          broadcast(c, { t: 'serveOne', ti, k, tea: T.tea, by: hostUid });
        }, 3000);
      }
      break;
    }
    case 'stand': freeSeat(c, p); break;
    case 'brewed': {   // host serves an infusion: a full brew the first time at a table, afterwards poured from the fair cup
      if (!p.seat || p.seat[1] !== 0 || !(p.teaLeft > 0)) return;
      const ti = p.seat[0], T = c.tables[ti];
      T.tea = p.tea; T.ready = true; T.brewed = true; T.brewing = false; p.teaLeft -= 1; p.brewedAt = ti; const tea = p.tea; if (p.teaLeft <= 0) { p.tea = null; p.brewedAt = null; }
      broadcast(c, { t: 'player', uid: p.uid, tea: p.tea, teaLeft: p.teaLeft, brewedAt: p.brewedAt });
      // pouring follows immediately: every seated guest gets a full cup
      const ks = []; for (let k = 1; k < NSEAT; k++) if (c.seats[ti][k]) { T.cups[k] = SIPS; ks.push(k); }
      T.ready = false;
      broadcast(c, { t: 'serve', ti, tea, ks, by: p.uid });
      broadcast(c, { t: 'table', ...tableState(c, ti) }); break;
    }
    case 'brewstep': {   // the host's brewing steps, replayed on everyone else's screen
      if (!p.seat || p.seat[1] !== 0 || !['start','leafing','watering','closing'].includes(m.step)) return;
      if (m.step === 'start') c.tables[p.seat[0]].brewing = true;   // the host is busy brewing: no automatic pour
      broadcast(c, { t: 'brewstep', ti: p.seat[0], step: m.step, tea: m.step === 'start' ? p.tea : undefined, by: p.uid }, conn.ws); break;
    }
    case 'act': {   // a visible action (incense, sweets, offering, stone skipping, feeding, sky lantern) replayed for everyone
      if (!['incense','snack','offer','skip','toss','lantern'].includes(m.kind)) return;
      const d = (m.d && typeof m.d === 'object') ? m.d : {}; if (typeof d.txt === 'string') d.txt = d.txt.slice(0, 40);
      if (JSON.stringify(d).length > 300) return;
      broadcast(c, { t: 'act', uid: p.uid, kind: m.kind, d }, conn.ws); break;
    }
    case 'drink': {
      if (!p.seat) return; const [ti, k] = p.seat; c.tables[ti].cups[k] = Math.max(0, (c.tables[ti].cups[k] | 0) - 1);   // one sip
      broadcast(c, { t: 'drink', ti, k, uid: p.uid }, conn.ws); break;
    }
    case 'cupback': {
      if (!p.seat || p.seat[1] === 0) return; const [ti, k] = p.seat; const T = c.tables[ti]; T.cups[k] = 0;
      broadcast(c, { t: 'cupback', ti, k, uid: p.uid }, conn.ws);
      // the host has tea in the fair cup at this table: the empty cup is refilled and passed straight back,
      // without a new infusion (and without the host having to press anything)
      const hostUid = c.seats[ti][0];
      if (hostUid && hostUid !== p.uid && T.brewed && (T.tea || isNpc(hostUid))) {
        L('refill', { uid: p.uid, ch: c.id, seat: seatId([ti, k]) });
        setTimeout(() => { if (c.seats[ti][k] === p.uid && c.seats[ti][0] === hostUid && T.brewed && !T.cups[k]) { T.cups[k] = SIPS; broadcast(c, { t: 'serveOne', ti, k, tea: T.tea, by: hostUid }); } }, 1500);
      }
      break;
    }
    case 'cheers': {   // 함께 한 모금: everyone at that table drinks together
      if (!p.seat) return; const ti = p.seat[0];
      for (let k = 1; k < NSEAT; k++) if (c.seats[ti][k]) c.tables[ti].cups[k] = Math.max(0, (c.tables[ti].cups[k] | 0) - 1);
      broadcast(c, { t: 'cheers', ti, by: p.uid }); break;
    }
    case 'bye': {   // the page is closing; a reload comes straight back with the same session and keeps everything
      L('bye', { uid: p.uid, cid: conn.cid, ch: c.id, seat: seatId(p.seat) });
      clearTimeout(p.byeTimer); p.byeTimer = setTimeout(() => { if (c.players.get(p.uid) === p && p.byeCid === conn.cid) { clearTimeout(p.graceTimer); removePlayer(c, p, 'left'); } }, LEAVE_MS);
      p.byeCid = conn.cid; break;
    }
    case 'mood': if (typeof m.e === 'string' && m.e.length <= 8) broadcast(c, { t: 'mood', uid: p.uid, e: m.e }, conn.ws); break;
    case 'ping': send(conn.ws, { t: 'pong' }); break;
  }
}

function hello(conn, m) {
  if (conn.p) return;
  const id = String(m.ch || '1').replace(/[^0-9a-z-]/gi, '').slice(0, 16) || '1';
  if (!channels.has(id) && channels.size >= MAX_CHANNELS) return send(conn.ws, { t: 'error', why: 'tooManyServers' });
  const c = channel(id);
  // same browser session coming back (reload / short drop): same id, same name, same seat
  // a fresh entry from the same tab: the character this tab left behind (still in its grace window) goes now
  if (typeof m.prev === 'string' && m.prev !== m.sid) { const ou = c.bySid.get(m.prev), op = ou && c.players.get(ou); if (op && !op.online) { clearTimeout(op.graceTimer); clearTimeout(op.byeTimer); removePlayer(c, op, 'reentered'); c.retired.delete(m.prev); } }
  const back = typeof m.sid === 'string' && c.bySid.get(m.sid);
  let p = back && c.players.get(back);
  if (p) {
    clearTimeout(p.graceTimer); p.graceTimer = null; clearTimeout(p.byeTimer); p.byeCid = null;
    const wasOnline = p.online;
    if (p.online && p.ws !== conn.ws) {   // the session's older connection is still open (a half-dead socket, or the same session in another tab)
      send(p.ws, { t: 'replaced' }); const old = p.ws; p.ws = null; try { old.close(); } catch (e) {}
    }
    p.ws = conn.ws; p.online = true; p.cid = conn.cid; if (m.look && typeof m.look === 'object') p.look = m.look;
    conn.c = c; conn.p = p;
    L(wasOnline ? 'takeover' : 'resume', { uid: p.uid, cid: conn.cid, ch: id, seat: seatId(p.seat), inst: m.inst });
    send(conn.ws, { t: 'welcome', resumed: true, cid: conn.cid, uid: p.uid, sid: p.sid, nick: p.nick, ch: id, cap: CAP, v: c.ver, me: pub(p), players: [...c.players.values()].filter(q => q !== p).map(pub), tables: c.tables.map((_, ti) => tableState(c, ti)) });
    if (!wasOnline) broadcast(c, { t: 'back', p: pub(p) }, conn.ws);
    return;
  }
  if (occupancy(c) >= CAP) {
    let alt = null; for (let n = 1; n <= MAX_CHANNELS; n++) { const cc = channels.get(String(n)); if (!cc || occupancy(cc) < CAP) { alt = String(n); break; } }
    if (!c.players.size) channels.delete(id);
    return send(conn.ws, { t: 'full', ch: id, count: occupancy(c), cap: CAP, alt });
  }
  const used = new Set([...c.players.values()].map(q => q.nick));
  for (const [k, r] of c.retired) if (Date.now() - r.t > 30 * 60000) c.retired.delete(k);
  const old = typeof m.sid === 'string' && c.retired.get(m.sid);   // this session was here before its grace ran out
  const free = NICKS.filter(n => !used.has(n));
  const nick = old && !used.has(old.nick) ? old.nick : free[crypto.randomInt(free.length)];
  const sid = old ? m.sid : crypto.randomBytes(18).toString('base64url');
  if (old) c.retired.delete(m.sid);
  p = { uid: old ? old.uid : crypto.randomUUID(), sid, nick, look: (m.look && typeof m.look === 'object') ? m.look : {}, st: null, stq: 0,
    ws: conn.ws, cid: conn.cid, online: true, graceTimer: null, seat: null, tea: null, teaLeft: 0, brewedAt: null };
  c.players.set(p.uid, p); c.bySid.set(p.sid, p.uid); conn.c = c; conn.p = p;
  L('enter', { uid: p.uid, cid: conn.cid, ch: id, nick, returning: !!old, inst: m.inst });
  send(conn.ws, { t: 'welcome', resumed: false, cid: conn.cid, uid: p.uid, sid: p.sid, nick, ch: id, cap: CAP, v: c.ver, me: pub(p), players: [...c.players.values()].filter(q => q !== p).map(pub), tables: c.tables.map((_, ti) => tableState(c, ti)) });
  broadcast(c, { t: 'enter', p: pub(p) }, conn.ws);
  syncNpcs(c);
}

function onClose(conn) {
  const c = conn.c, p = conn.p;
  if (!c || !p) return;
  // a late close from a connection this session has already replaced must not touch the new connection's character or seat
  if (p.ws !== conn.ws) { L('closeStale', { uid: p.uid, cid: conn.cid, current: p.cid, ch: c.id }); return; }
  p.online = false; p.ws = null; L('away', { uid: p.uid, cid: conn.cid, ch: c.id, seat: seatId(p.seat), graceMs: GRACE });
  broadcast(c, { t: 'away', uid: p.uid });
  // character, name and seat stay during the grace window; only its end (or a real leave) clears them
  p.graceTimer = setTimeout(() => { if (!p.online && c.players.get(p.uid) === p) removePlayer(c, p, 'graceExpired'); }, GRACE);
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify({ ok: true, channels: [...channels.values()].map(c => ({ id: c.id, count: occupancy(c) })) })); }
  let f = decodeURIComponent(u.pathname); if (f.endsWith('/')) f += 'index.html';
  const file = path.join(ROOT, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !/\.(html|jpg|png|js|css|json)$/.test(file) || /server\.js$/.test(file)) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(data); });
});

/* ---------- minimal WebSocket (RFC 6455), text frames only ---------- */
server.on('upgrade', (req, sock) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return sock.destroy();
  const key = req.headers['sec-websocket-key']; if (!key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const ws = { sock, readyState: 1, close() { if (this.readyState !== 1) return; this.readyState = 3; try { sock.write(Buffer.from([0x88, 0])); sock.end(); } catch (e) {} } };
  const conn = { ws, c: null, p: null, alive: true, cid: ++cidSeq };
  L('connect', { cid: conn.cid });
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, masked = buf[1] & 128; let len = buf[1] & 127, o = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
      if (len > 65536) return ws.close();
      const need = o + (masked ? 4 : 0) + len; if (buf.length < need) return;
      let payload = buf.subarray(o + (masked ? 4 : 0), need);
      if (masked) { const mk = buf.subarray(o, o + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3]; }
      buf = buf.subarray(need);
      conn.alive = true;
      if (op === 1) { let m = null; try { m = JSON.parse(payload.toString('utf8')); } catch (e) {} onMessage(conn, m); }
      else if (op === 8) { ws.close(); }
      else if (op === 9) { wsRaw(ws, 0x8A, payload); }
    }
  });
  const end = () => { if (ws.readyState === 3 && conn.ended) return; ws.readyState = 3; if (!conn.ended) { conn.ended = true; onClose(conn); } };
  sock.on('close', end); sock.on('error', end);
  conns.add(conn); sock.on('close', () => conns.delete(conn));
});
function wsRaw(ws, op, payload) {
  const n = payload.length; let h;
  if (n < 126) h = Buffer.from([op, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = op; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  try { ws.sock.write(Buffer.concat([h, payload])); } catch (e) {}
}
function wsSend(ws, s) { if (ws.readyState === 1) wsRaw(ws, 0x81, Buffer.from(s, 'utf8')); }
// drop connections that went silent (phone locked, network gone) so their grace timer starts
const conns = new Set();
setInterval(() => { for (const c of conns) { if (!c.alive) { try { c.ws.sock.destroy(); } catch (e) {} continue; } c.alive = false; wsRaw(c.ws, 0x89, Buffer.alloc(0)); } }, 20000);

server.listen(PORT, () => console.log(`차요우 다원 서버: http://localhost:${PORT}  (실시간: ws://localhost:${PORT}/ws, 서버당 ${CAP}명)`));
