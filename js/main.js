import { Table } from './engine/table.js';
import { groupSquads } from './engine/deck.js';
import { bestTeam, HAND_RANKINGS, CHEM } from './engine/evaluate.js';
import { decide, equityFromCards, PERSONALITIES } from './engine/ai.js';
import { viewFor } from './engine/view.js';
import { hostRoom, joinRoom, normalizeCode } from './net.js';

const $ = id => document.getElementById(id);
const AI_DELAY = 750;
const RUNOUT_DELAY = 1300;
const TURN_MS = 45000;        // online: time to act before auto check/fold
const AWAY_MS = 1200;         // online: disconnected players auto-act quickly
const AUTO_NEXT_MS = 12000;   // online: next hand deals itself
const MAX_SEATS = 8;

const BOT_NAMES = ['Pep', 'Carlo', 'Jürgen', 'Zizou', 'Diego', 'José', 'Arsène', 'Johan', 'Sir Alex', 'Marcelo'];
const STYLES = ['pro', 'rock', 'maniac', 'station', 'pro'];

let SQUADS, BYID = new Map();
let settings = loadSettings();

// mode: 'solo' (vs bots), 'host' (runs an online table), 'client' (joined one)
let mode = null;
let table = null;           // solo/host only — the authoritative game
let view = null;            // what this browser renders
let timer = null;
let deadline = 0, nextAt = 0;           // host clocks
let localDeadline = 0, localNextAt = 0; // render clocks (all modes)
let host = null;   // { peer, code, clients: Map(token -> {conn, name, seat}), lobby: [], started, pending: [] }
let client = null; // { peer, conn, code, token, lobby }
let raiseTo = 0;
let seenCards = new Set(), seenHand = 0;
let equityCache = { key: '', value: null };
let shownResults = 0;
let overlayKind = '';

// ---------- boot ----------
async function boot() {
  const [pj, cj] = await Promise.all([
    fetch('data/players.json').then(r => r.json()),
    fetch('data/clubs.json').then(r => r.json()),
  ]);
  const colors = Object.fromEntries(cj.clubs.map(c => [c.id, c.primaryColor]));
  const all = pj.players.map(p => ({ ...p, color: colors[p.clubId] || '#2a6' }));
  for (const p of all) BYID.set(p.id, p);
  SQUADS = groupSquads(all);
  $('btn-rules').onclick = showRules;
  $('btn-new').onclick = () => confirmLeave() && showHome();
  document.addEventListener('keydown', onKey);
  setInterval(updateClocks, 500);
  window.addEventListener('beforeunload', e => { if (mode === 'host' && host?.started) { e.preventDefault(); e.returnValue = ''; } });
  const room = normalizeCode(new URLSearchParams(location.search).get('room'));
  showHome(room);
}

function loadSettings() {
  const d = { name: '', bots: 4, stack: 1000, blinds: '10/20', deck: 'all', showEquity: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem('fp-settings') || '{}') }; } catch { return d; }
}
function saveSettings() { try { localStorage.setItem('fp-settings', JSON.stringify(settings)); } catch {} }
function token(code) {
  const k = 'fp-token-' + code;
  try {
    let t = localStorage.getItem(k);
    if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(k, t); }
    return t;
  } catch { return Math.random().toString(36).slice(2); }
}
const card = id => BYID.get(id);
const mySeat = () => (view ? view.me : -1);

function confirmLeave() {
  if (mode === 'host' && host?.started) return confirm('Leaving ends the online table for everyone. Continue?');
  return true;
}

function teardown() {
  clearTimeout(timer);
  try { host?.peer?.destroy(); } catch {}
  try { client?.peer?.destroy(); } catch {}
  host = client = table = view = null;
  mode = null;
  shownResults = 0;
}

function botSeats(n, taken = 0) {
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  return Array.from({ length: n }, (_, i) => ({ name: names[i], chips: settings.stack, style: STYLES[(i + taken) % STYLES.length] }));
}

function makeTable(seats) {
  const [sb, bb] = settings.blinds.split('/').map(Number);
  return new Table({
    seats, squads: SQUADS, smallBlind: sb, bigBlind: bb,
    deckOpts: settings.deck === 'elite' ? { minSquadOverall: 81 } : {},
  });
}

// =====================================================================
// Solo + host: the authoritative game loop
// =====================================================================
function startSolo() {
  teardown();
  mode = 'solo';
  table = makeTable([{ name: settings.name || 'You', isHuman: true, chips: settings.stack }, ...botSeats(settings.bots)]);
  closeModal();
  nextHand();
}

function nextHand() {
  if (mode === 'client') return;
  clearTimeout(timer);
  if (overlayKind === 'results') closeModal();
  if (mode === 'host') {
    for (const p of host.pending.splice(0)) {
      const c = host.clients.get(p.token);
      if (!c || table.seats.length >= MAX_SEATS) continue;
      c.seat = table.addSeat({ name: p.name, isHuman: true, chips: settings.stack, token: p.token });
      table.say(`${p.name} joins the table`);
    }
  }
  table.startHand();
  if (mode === 'solo' && (table.street === 'gameover' || table.seats[0].out)) { publish(); return gameOver(); }
  tick();
}

function tick() {
  clearTimeout(timer);
  deadline = 0; nextAt = 0;
  const t = table;
  if (t.street === 'gameover') { publish(); return tableFinished(); }
  if (t.street === 'handover') {
    if (mode === 'host') { nextAt = Date.now() + AUTO_NEXT_MS; timer = setTimeout(nextHand, AUTO_NEXT_MS); }
  } else if (t.runningOut) {
    timer = setTimeout(() => { t.advanceRunout(); tick(); }, RUNOUT_DELAY);
  } else if (t.toAct >= 0) {
    const i = t.toAct, s = t.seats[i];
    if (!s.isHuman) {
      timer = setTimeout(() => { t.act(i, decide(t, i)); tick(); }, AI_DELAY);
    } else if (mode === 'host') {
      const away = s.token !== 'host' && !s.connected;
      const ms = away ? AWAY_MS : TURN_MS;
      if (!away) deadline = Date.now() + ms;
      timer = setTimeout(() => autoAct(i), ms);
    }
  }
  publish();
}

function autoAct(i) {
  if (table.toAct !== i) return;
  const L = table.legal(i);
  table.act(i, { type: L.canCheck ? 'check' : 'fold' });
  tick();
}

function extras() {
  return {
    mode,
    code: host?.code || null,
    turnLeftMs: deadline ? deadline - Date.now() : 0,
    nextLeftMs: nextAt ? nextAt - Date.now() : 0,
    stack: settings.stack,
  };
}

/** Send every seat its own view, and render ours. */
function publish() {
  const ex = extras();
  receiveView(viewFor(table, 0, ex));
  if (mode !== 'host') return;
  for (const [tok, c] of host.clients) {
    if (!c.conn.open) continue;
    const seat = table.seats.findIndex(s => s.token === tok);
    const v = viewFor(table, seat, { ...ex, pending: seat < 0 });
    try { c.conn.send({ t: 'state', view: v }); } catch {}
  }
}

function hostAct(seat, action) {
  if (table.toAct !== seat) return;
  if (table.act(seat, action)) tick();
}

function rebuy(seat) {
  const s = table.seats[seat];
  if (!s || s.chips > 0) return;
  s.chips = settings.stack;
  s.out = false;
  table.say(`${s.name} rebuys for ${settings.stack}`);
  if (table.street === 'gameover') nextHand(); else publish();
}

// ---------- hosting ----------
async function createRoom() {
  teardown();
  mode = 'host';
  host = { peer: null, code: null, clients: new Map(), lobby: [], started: false, pending: [] };
  openModal(`<h2>Opening table…</h2><div class="sub">Registering your room.</div>`, 'lobby');
  try {
    const { peer, code } = await hostRoom({
      onConnection: conn => wireClient(conn),
      onError: err => console.warn('peer error', err),
    });
    host.peer = peer; host.code = code;
    showLobby();
  } catch (err) {
    teardown();
    showError(`Couldn't open an online table: ${err.message || err.type || err}`);
  }
}

function wireClient(conn) {
  let tok = null;
  conn.on('data', msg => {
    if (!msg || typeof msg !== 'object' || !host) return;
    if (msg.t === 'join') {
      tok = String(msg.token || '').slice(0, 40) || Math.random().toString(36).slice(2);
      const name = String(msg.name || 'Player').trim().slice(0, 16) || 'Player';
      onJoin(conn, tok, name);
    } else if (tok && msg.t === 'act' && table) {
      const seat = table.seats.findIndex(s => s.token === tok);
      const a = msg.action || {};
      if (seat >= 0 && ['fold', 'check', 'call', 'raise'].includes(a.type)) hostAct(seat, { type: a.type, to: +a.to || 0 });
    } else if (tok && msg.t === 'rebuy' && table) {
      const seat = table.seats.findIndex(s => s.token === tok);
      if (seat >= 0) rebuy(seat);
    }
  });
  conn.on('close', () => tok && onLeave(conn, tok));
}

function onJoin(conn, tok, name) {
  const prev = host.clients.get(tok);
  if (prev && prev.conn !== conn) try { prev.conn.close(); } catch {}
  if (!host.started) {
    const seatsUsed = 1 + host.lobby.filter(p => p.token !== tok).length + host.bots;
    if (!host.lobby.find(p => p.token === tok) && seatsUsed >= MAX_SEATS) return conn.send({ t: 'full' });
    host.clients.set(tok, { conn, name });
    const existing = host.lobby.find(p => p.token === tok);
    if (existing) existing.name = name; else host.lobby.push({ token: tok, name });
    return showLobby();
  }
  host.clients.set(tok, { conn, name });
  const seat = table.seats.findIndex(s => s.token === tok);
  if (seat >= 0) {
    table.seats[seat].connected = true;
    table.say(`${table.seats[seat].name} is back`);
  } else if (!host.pending.find(p => p.token === tok)) {
    if (table.seats.length + host.pending.length >= MAX_SEATS) return conn.send({ t: 'full' });
    host.pending.push({ token: tok, name });
    table.say(`${name} will be dealt in next hand`);
  }
  publish();
}

function onLeave(conn, tok) {
  const c = host?.clients.get(tok);
  if (!c || c.conn !== conn) return; // replaced by a newer connection
  if (!host.started) {
    host.clients.delete(tok);
    host.lobby = host.lobby.filter(p => p.token !== tok);
    return showLobby();
  }
  host.pending = host.pending.filter(p => p.token !== tok);
  const seat = table.seats.findIndex(s => s.token === tok);
  if (seat >= 0) {
    table.seats[seat].connected = false;
    table.say(`${table.seats[seat].name} disconnected`);
    if (table.toAct === seat) return tick();
  }
  publish();
}

function lobbyPlayers() {
  return [{ name: settings.name || 'Host', host: true }, ...host.lobby.map(p => ({ name: p.name }))];
}

function broadcastLobby() {
  const msg = { t: 'lobby', code: host.code, players: lobbyPlayers(), bots: host.bots, settings: { stack: settings.stack, blinds: settings.blinds } };
  for (const c of host.clients.values()) if (c.conn.open) try { c.conn.send(msg); } catch {}
}

function startOnline() {
  const people = [{ name: settings.name || 'Host', isHuman: true, chips: settings.stack, token: 'host' },
    ...host.lobby.map(p => ({ name: p.name, isHuman: true, chips: settings.stack, token: p.token }))];
  const bots = Math.max(0, Math.min(host.bots, MAX_SEATS - people.length));
  if (people.length + bots < 2) return;
  table = makeTable([...people, ...botSeats(bots)]);
  table.seats.forEach(s => { if (s.token && s.token !== 'host') s.connected = !!host.clients.get(s.token)?.conn.open; });
  host.started = true;
  closeModal();
  nextHand();
}

function tableFinished() {
  const v = view;
  const leader = [...v.seats].filter(s => !s.out).sort((a, b) => b.chips - a.chips)[0];
  const meOut = v.seats[v.me]?.chips === 0;
  openModal(`<div class="banner"><div class="big">🏆 ${esc(leader?.name || '')} takes every chip</div>
    <p class="sub">Table finished after ${v.handNo} hands.</p></div>
    <div class="foot">
      ${meOut ? `<button class="gold" id="m-rebuy">Rebuy ${v.stack}</button>` : ''}
      ${mode === 'host' ? '<button class="primary" id="m-restart">Restart table</button>' : '<span class="hint">Waiting for the host…</span>'}
    </div>`, 'finished');
  if ($('m-rebuy')) $('m-rebuy').onclick = () => { doRebuy(); };
  if ($('m-restart')) $('m-restart').onclick = () => startOnline();
}

// =====================================================================
// Client
// =====================================================================
async function joinTable(code) {
  code = normalizeCode(code);
  if (!code) return;
  teardown();
  mode = 'client';
  const tok = token(code);
  client = { peer: null, conn: null, code, token: tok, lobby: null };
  openModal(`<h2>Joining ${code}…</h2><div class="sub">Connecting to the host's table.</div>`, 'lobby');
  try {
    const { peer, conn } = await joinRoom(code);
    if (!client || client.token !== tok) { peer.destroy(); return; }
    client.peer = peer; client.conn = conn;
    conn.on('data', onHostMessage);
    conn.on('close', () => {
      if (mode !== 'client' || client?.conn !== conn) return;
      openModal(`<h2>Connection lost</h2><div class="sub">The host closed the table or the connection dropped. Your seat is kept for you if the host is still playing.</div>
        <div class="foot"><button class="ghost" id="m-home">Home</button><button class="primary" id="m-rejoin">Rejoin ${code}</button></div>`, 'error');
      $('m-home').onclick = () => { teardown(); showHome(); };
      $('m-rejoin').onclick = () => joinTable(code);
    });
    conn.send({ t: 'join', name: settings.name || 'Player', token: tok });
    history.replaceState(null, '', '?room=' + code);
  } catch (err) {
    teardown();
    showError(err.message || String(err), code);
  }
}

function onHostMessage(msg) {
  if (!msg || mode !== 'client') return;
  if (msg.t === 'lobby') { client.lobby = msg; showClientLobby(); }
  else if (msg.t === 'state') {
    if (overlayKind === 'lobby') closeModal();
    receiveView(msg.view);
    if (msg.view.street === 'gameover') tableFinished();
    else if (overlayKind === 'finished') closeModal();
  } else if (msg.t === 'full') { teardown(); showError('That table is full (8 seats).'); }
}

// =====================================================================
// Actions from this browser
// =====================================================================
function myAct(type) {
  if (!view || view.toAct !== view.me || !view.legal) return;
  const action = type === 'raise' ? { type, to: raiseTo } : { type };
  if (mode === 'client') client.conn.send({ t: 'act', action });
  else hostAct(0, action);
}

function doRebuy() {
  if (mode === 'client') client.conn.send({ t: 'rebuy' });
  else if (table) rebuy(0);
  if (overlayKind === 'finished') closeModal();
}

function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !view) return;
  const k = e.key.toLowerCase();
  const canNext = view.street === 'handover' && mode !== 'client';
  if (!$('overlay').classList.contains('hidden')) {
    if (k === 'enter' && canNext && overlayKind === 'results') nextHand();
    return;
  }
  if (canNext && (k === 'enter' || k === 'n')) return nextHand();
  if (view.toAct !== view.me || !view.legal) return;
  const L = view.legal;
  if (k === 'f' && !L.canCheck) myAct('fold');
  if (k === 'c') myAct(L.canCheck ? 'check' : 'call');
  if (k === 'r' && L.canRaise) myAct('raise');
}

// =====================================================================
// Rendering (works purely from `view`)
// =====================================================================
function receiveView(v) {
  const prev = view;
  view = v;
  localDeadline = v.turnLeftMs > 0 ? Date.now() + v.turnLeftMs : 0;
  localNextAt = v.nextLeftMs > 0 ? Date.now() + v.nextLeftMs : 0;
  if (!prev || prev.toAct !== v.toAct || prev.street !== v.street || prev.handNo !== v.handNo) raiseTo = 0;
  render();
  if (v.street === 'handover' && v.result && !v.result.uncontested && shownResults !== v.handNo) {
    shownResults = v.handNo;
    setTimeout(() => { if (view && view.handNo === v.handNo && view.street === 'handover') showResults(); }, 900);
  }
  if (v.street !== 'handover' && overlayKind === 'results') closeModal();
}

function ink(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#111' : '#fff';
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fresh(key) {
  if (view && view.handNo !== seenHand) { seenHand = view.handNo; seenCards = new Set(); }
  if (!key || seenCards.has(key)) return '';
  seenCards.add(key);
  return 'fresh';
}

function cardHTML(p, size = '', opts = {}) {
  if (!p) return `<div class="card back ${size} ${fresh(opts.key)}"></div>`;
  const pos = p.subPosition.split('/')[0];
  const stats = p.position === 'GK'
    ? [['GK', p.gk], ['DEF', p.defense], ['TEC', p.technique], ['PHY', p.physical]]
    : [['ATT', p.attack], ['DEF', p.defense], ['TEC', p.technique], ['PHY', p.physical]];
  const cls = ['card', size, fresh(opts.key), opts.inteam ? 'inteam' : '', opts.dim ? 'dim' : ''].join(' ');
  return `<div class="${cls}" style="--club:${p.color};--club-ink:${ink(p.color)}" title="${esc(p.name)} — ${esc(p.club)} ${p.era}, ${esc(p.nationality)} (${p.subPosition})">
    <div class="band"><span class="ovr">${p.overall}</span><span class="pos">${pos}</span></div>
    <div class="nm">${esc(p.name)}</div>
    <div class="meta"><b>${esc(p.club)}</b> · ${p.era}</div>
    <div class="meta">${esc(p.nationality)}</div>
    <div class="stats">${stats.map(([k, v]) => `<div>${k}<span>${v}</span></div>`).join('')}</div>
    ${opts.role ? `<div class="role">${opts.role}</div>` : ''}
  </div>`;
}

function seatPos(i, n, me) {
  // You always sit at the bottom; everyone else spreads clockwise.
  const rel = me >= 0 ? (i - me + n) % n : i;
  const a = Math.PI / 2 + (rel * 2 * Math.PI) / n;
  return { x: 50 + 45 * Math.cos(a), y: 50 + 43 * Math.sin(a) };
}

function myCards() {
  const s = view.seats[view.me];
  return s && s.hole ? s.hole.map(card) : [];
}

function currentTeam() {
  const cards = [...myCards(), ...view.board.map(card)];
  return cards.length >= 5 ? bestTeam(cards) : null;
}

function render() {
  const v = view;
  if (!v) return;
  const handover = v.street === 'handover';
  const winners = new Set(handover && v.result ? v.result.winners.map(w => w.seat) : []);
  const myTeam = currentTeam();
  const inTeam = new Set(myTeam ? myTeam.lineup.map(l => l.player.id) : []);
  const roleOf = Object.fromEntries(myTeam ? myTeam.lineup.map(l => [l.player.id, l.role]) : []);
  const live = v.seats.filter(s => !s.out).length;

  $('hud').innerHTML = `${v.mode !== 'solo' && (v.code || client?.code) ? `<span>Table <b>${v.code || client.code}</b> <button class="ghost tiny" id="b-invite">Copy invite</button></span>` : ''}
    <span>Hand <b>#${v.handNo}</b></span><span>Blinds <b>${v.sb}/${v.bb}</b></span><span>Players <b>${live}</b></span>`;
  if ($('b-invite')) $('b-invite').onclick = () => copyInvite(v.code || client.code, $('b-invite'));
  $('pot').textContent = v.pot ? `Pot ${v.pot}` : '';
  $('street').textContent = handover ? 'hand over' : v.street === 'gameover' ? 'table finished' : v.street;
  const board = [];
  for (let k = 0; k < 5; k++) {
    const c = card(v.board[k]);
    board.push(c ? cardHTML(c, '', { key: 'b' + c.id, inteam: inTeam.has(c.id), role: roleOf[c.id] }) : '<div class="slot"></div>');
  }
  $('board').innerHTML = board.join('');

  const n = v.seats.length;
  $('seats').innerHTML = v.seats.map((s, i) => {
    if (i === v.me) {
      const { x, y } = seatPos(i, n, v.me);
      return seatHTML(s, i, x, y, '', winners);
    }
    const { x, y } = seatPos(i, n, v.me);
    let cards = '';
    if (s.holeCount && !s.out) {
      cards = `<div class="cards">${s.hole
        ? s.hole.map(id => cardHTML(card(id), 'sm', { key: 'r' + id })).join('')
        : Array.from({ length: s.holeCount }, (_, k) => cardHTML(null, 'sm', { key: `h${i}-${k}` })).join('')}</div>`;
    }
    return seatHTML(s, i, x, y, cards, winners);
  }).join('');

  const me = v.seats[v.me];
  const mine = myCards();
  $('my-cards').innerHTML = mine.length
    ? mine.map(c => cardHTML(c, 'lg', { key: 'm' + c.id, inteam: inTeam.has(c.id), role: roleOf[c.id], dim: me.folded })).join('')
    : cardHTML(null, 'lg') + cardHTML(null, 'lg');

  renderActions();
  renderTeamPanel(myTeam);
  renderLog();
  updateClocks();
}

function seatHTML(s, i, x, y, cards, winners) {
  const v = view;
  const cls = ['seat', v.toAct === i ? 'turn' : '', s.folded && !s.out ? 'folded' : '', s.out ? 'out' : '', winners.has(i) ? 'winner' : ''].join(' ');
  const sty = s.isBot ? `${PERSONALITIES[s.style]?.label || 'Bot'} · bot` : !s.connected ? '⚠ disconnected' : i === v.me ? 'You' : 'Player';
  const won = v.street === 'handover' && v.result ? v.result.winners.find(w => w.seat === i) : null;
  const top = y < 50;
  return `<div class="${cls}" style="left:${x}%;top:${y}%">
    ${top ? cards : ''}
    <div class="plate">
      ${i === v.dealer ? '<div class="dealer">D</div>' : ''}
      <div class="nm">${esc(s.name)}</div>
      <div class="ch">${s.out ? 'Out' : s.chips.toLocaleString()}</div>
      <div class="sty">${sty}${v.toAct === i && s.isHuman ? ' <span class="clock" data-clock="turn"></span>' : ''}</div>
    </div>
    <div class="act">${won ? `Wins ${won.amount}` : esc(s.lastAction)}</div>
    ${s.bet ? `<div class="bet">● ${s.bet}</div>` : ''}
    ${!top ? cards : ''}
  </div>`;
}

function updateClocks() {
  const now = Date.now();
  document.querySelectorAll('[data-clock]').forEach(el => {
    const at = el.dataset.clock === 'turn' ? localDeadline : localNextAt;
    const left = Math.max(0, Math.ceil((at - now) / 1000));
    el.textContent = at ? (el.dataset.clock === 'turn' ? `⏱ ${left}s` : `${left}s`) : '';
    el.classList.toggle('urgent', el.dataset.clock === 'turn' && at && left <= 10);
  });
}

function renderActions() {
  const v = view, el = $('actions');
  const me = v.seats[v.me];
  if (v.pending || v.me < 0) {
    el.innerHTML = `<div class="msg">You're watching — you'll be dealt in at the next hand.</div>`;
    return;
  }
  if (me.chips === 0 && (me.out || v.street === 'handover' || v.street === 'gameover') && mode !== 'solo') {
    el.innerHTML = `<div class="msg">You're out of chips.</div><div class="row"><button class="gold" id="b-rebuy">Rebuy ${v.stack}</button></div>`;
    $('b-rebuy').onclick = doRebuy;
    return;
  }
  if (v.street === 'handover') {
    const w = v.result.winners.map(x => v.seats[x.seat].name).join(' & ');
    const canNext = mode !== 'client';
    el.innerHTML = `<div class="msg">${esc(w)} won the hand${v.result.uncontested ? ' — everyone else folded' : ''}.${mode !== 'solo' ? ` Next hand in <span data-clock="next"></span>` : ''}</div>
      <div class="row">${!v.result.uncontested ? '<button class="ghost" id="b-res">See teams</button>' : ''}${canNext ? '<button class="primary" id="b-next">Next hand <kbd>↵</kbd></button>' : ''}</div>`;
    if ($('b-next')) $('b-next').onclick = nextHand;
    if ($('b-res')) $('b-res').onclick = showResults;
    return;
  }
  if (me.folded) { el.innerHTML = `<div class="msg">${me.out ? 'Sitting out.' : 'You folded — watching the hand play out…'}</div>`; return; }
  if (v.toAct !== v.me || !v.legal) {
    el.innerHTML = `<div class="msg">${v.runningOut ? 'All-in — running out the board…' : v.toAct >= 0 ? `Waiting for ${esc(v.seats[v.toAct].name)}… <span data-clock="turn"></span>` : ''}</div>`;
    return;
  }
  const L = v.legal;
  const pot = v.pot;
  if (!raiseTo || raiseTo < L.minRaiseTo || raiseTo > L.maxRaiseTo) raiseTo = L.minRaiseTo;
  const word = v.currentBet === 0 ? 'Bet' : 'Raise to';
  const step = v.sb;
  const preset = f => Math.min(L.maxRaiseTo, Math.max(L.minRaiseTo, v.currentBet + Math.round(pot * f / step) * step));
  el.innerHTML = `
    ${mode !== 'solo' ? `<div class="msg">Your turn <span data-clock="turn"></span></div>` : ''}
    <div class="row">
      <button class="danger" id="b-fold" ${L.canCheck ? 'disabled' : ''}>Fold<kbd>F</kbd></button>
      <button id="b-call">${L.canCheck ? 'Check' : `Call ${L.toCall}`}<kbd>C</kbd></button>
      <button class="gold" id="b-raise" ${L.canRaise ? '' : 'disabled'}><span id="rw">${raiseTo >= L.maxRaiseTo ? 'All-in' : word}</span> <span id="rv">${raiseTo}</span><kbd>R</kbd></button>
    </div>
    ${L.canRaise ? `<div class="raise-box">
      <input type="range" id="r-range" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" step="${step}" value="${raiseTo}">
      <input type="number" id="r-num" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" value="${raiseTo}">
    </div>
    <div class="row presets">
      <button data-v="${L.minRaiseTo}">Min</button>
      <button data-v="${preset(0.5)}">½ Pot</button>
      <button data-v="${preset(0.75)}">¾ Pot</button>
      <button data-v="${preset(1)}">Pot</button>
      <button data-v="${L.maxRaiseTo}">All-in</button>
    </div>` : ''}`;
  $('b-fold').onclick = () => myAct('fold');
  $('b-call').onclick = () => myAct(L.canCheck ? 'check' : 'call');
  $('b-raise').onclick = () => myAct('raise');
  const setR = val => {
    raiseTo = Math.max(L.minRaiseTo, Math.min(+val || L.minRaiseTo, L.maxRaiseTo));
    $('rv').textContent = raiseTo;
    $('rw').textContent = raiseTo >= L.maxRaiseTo ? 'All-in' : word;
    $('r-range').value = raiseTo; $('r-num').value = raiseTo;
  };
  if (L.canRaise) {
    $('r-range').oninput = e => setR(e.target.value);
    $('r-num').onchange = e => setR(e.target.value);
    el.querySelectorAll('.presets button').forEach(b => b.onclick = () => setR(b.dataset.v));
  }
}

function chemList(items) {
  if (!items.length) return '<div class="hint">No chemistry links.</div>';
  return `<ul class="chem">${items.map(c => `<li class="${c.kind}"><span>${esc(c.label)}</span><b>+${c.pts}</b></li>`).join('')}</ul>`;
}

function preflopHints(hole) {
  const [a, b] = hole;
  const out = [];
  if (a.clubId === b.clubId && a.era === b.era) out.push(['squad', `Pocket teammates — ${a.club} ${a.era} (+${CHEM.squadPair})`]);
  else if (a.clubId === b.clubId) out.push(['club', `Both ${a.club} legends (+${CHEM.clubPair})`]);
  if (a.nationality === b.nationality) out.push(['nation', `Both ${a.nationality} (+${CHEM.nationPair})`]);
  if (a.era !== b.era) out.push(['era', `Two eras covered (${a.era}, ${b.era}) — chasing Through the Eras`]);
  const gk = hole.some(p => p.position === 'GK');
  out.push(['style', gk ? 'You hold a keeper' : 'No keeper yet — you need one from the board']);
  return `<ul class="chem">${out.map(([k, l]) => `<li class="${k}"><span>${esc(l)}</span></li>`).join('')}</ul>`;
}

function renderTeamPanel(team) {
  const v = view, me = v.seats[v.me];
  const hole = myCards();
  let html = '<h3>Your best five</h3>';
  if (!hole.length) html += '<div class="hint">Waiting for the deal…</div>';
  else if (!team) {
    html += `<div class="hint">Your best five appears once the flop is dealt. Pre-flop links:</div>${preflopHints(hole)}`;
  } else {
    html += `<div class="handname">${team.hand.name}</div>
      <div class="score-row">
        <div class="score"><small>Talent</small><b>${team.talent.toFixed(1)}</b></div>
        <div class="score"><small>Chemistry</small><b>+${team.chemistry.toFixed(1)}</b></div>
        <div class="score total"><small>Team</small><b>${team.total.toFixed(1)}</b></div>
      </div>
      <div class="lineup">${team.lineup.map(l => `<span class="r">${l.role}</span><span>${esc(l.player.name)}</span><span class="rt">${l.rating.toFixed(0)}</span>`).join('')}</div>
      ${chemList(team.chemItems)}`;
  }
  const opponents = v.seats.filter((s, i) => i !== v.me && !s.folded && !s.out).length;
  if (settings.showEquity && hole.length && me && !me.folded && v.deck && opponents > 0) {
    const key = `${v.handNo}|${v.board.length}|${opponents}`;
    if (equityCache.key !== key) {
      equityCache = { key, value: null };
      setTimeout(() => {
        if (equityCache.key !== key || !view || !view.deck) return;
        const seen = new Set([...hole.map(c => c.id), ...view.board]);
        const unseen = view.deck.filter(id => !seen.has(id)).map(card);
        equityCache.value = equityFromCards(hole, view.board.map(card), unseen, opponents, 300);
        if (equityCache.key === key) renderTeamPanel(currentTeam());
      }, 30);
    }
    const val = equityCache.value;
    html += `<div class="equity"><div class="hint">Win chance vs ${opponents} opponent${opponents > 1 ? 's' : ''}: <b>${val == null ? '…' : Math.round(val * 100) + '%'}</b></div>
      <div class="bar"><div style="width:${val == null ? 0 : val * 100}%"></div></div></div>`;
  }
  $('team-panel').innerHTML = html;
}

function renderLog() {
  const el = $('log');
  el.innerHTML = view.log.map(l => `<div class="${l.msg.startsWith('—') ? 'hd' : ''}">${esc(l.msg)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}

// =====================================================================
// Modals
// =====================================================================
function openModal(html, kind = '') { $('modal').innerHTML = html; $('overlay').classList.remove('hidden'); overlayKind = kind; }
function closeModal() { $('overlay').classList.add('hidden'); overlayKind = ''; }

function inviteLink(code) { return `${location.origin}${location.pathname}?room=${code}`; }
function copyInvite(code, btn) {
  const link = inviteLink(code);
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => (btn.textContent = t), 1500); } };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, () => prompt('Copy this invite link:', link));
  else prompt('Copy this invite link:', link);
}

function showResults() {
  const v = view;
  if (!v || !v.result || v.result.uncontested) return;
  const wset = new Map(v.result.winners.map(w => [w.seat, w.amount]));
  const board = v.board.map(card);
  const rows = v.result.showdown
    .map(seat => ({ seat, team: bestTeam([...v.seats[seat].hole.map(card), ...board]) }))
    .sort((a, b) => b.team.total - a.team.total)
    .map(({ seat, team }) => {
      const s = v.seats[seat];
      const holeIds = new Set(s.hole);
      return `<div class="res ${wset.has(seat) ? 'win' : ''}">
        <div class="who">
          <div class="nm">${esc(s.name)}${seat === v.me ? ' (you)' : ''}</div>
          ${wset.has(seat) ? `<div class="won">Wins ${wset.get(seat)}</div>` : ''}
          <div class="hn">${team.hand.name}</div>
          <div class="tt"><b>${team.total.toFixed(1)}</b> = ${team.talent.toFixed(1)} talent + ${team.chemistry.toFixed(1)} chem</div>
          <div class="tt">Hole: ${s.hole.map(id => esc(card(id).name)).join(', ')}</div>
        </div>
        <div class="five">${team.lineup.map(l => cardHTML(l.player, 'sm', { role: l.role, inteam: holeIds.has(l.player.id) })).join('')}</div>
        <div>${chemList(team.chemItems)}</div>
      </div>`;
    }).join('');
  const canNext = mode !== 'client';
  openModal(`<h2>Showdown</h2>
    <div class="sub">Best five from each player's two cards + the board. Gold outline = from their hand. Highest team score wins.${mode !== 'solo' ? ' Next hand in <span data-clock="next"></span>.' : ''}</div>
    <div class="results">${rows}</div>
    <div class="foot"><button class="ghost" id="m-close">View table</button>${canNext ? '<button class="primary" id="m-next">Next hand ↵</button>' : ''}</div>`, 'results');
  $('m-close').onclick = closeModal;
  if ($('m-next')) $('m-next').onclick = nextHand;
  updateClocks();
}

function gameOver() {
  clearTimeout(timer);
  const me = view.seats[0];
  const won = !me.out && me.chips > 0;
  const leader = [...view.seats].filter(s => !s.out).sort((a, b) => b.chips - a.chips)[0];
  openModal(`<div class="banner">
      <div class="big">${won ? '🏆 You took every chip!' : '💸 You\'re out'}</div>
      <p class="sub">${won ? `Champion after ${view.handNo} hands.` : `Busted on hand #${view.handNo}. ${esc(leader?.name || '')} leads the table.`}</p>
    </div>
    <div class="foot"><button class="ghost" id="m-home">Home</button><button class="primary" id="m-again">Play again</button></div>`, 'finished');
  $('m-again').onclick = startSolo;
  $('m-home').onclick = () => showHome();
}

function readForm() {
  settings = {
    name: ($('f-name').value || '').trim().slice(0, 16),
    bots: +$('f-bots').value, stack: +$('f-stack').value,
    blinds: $('f-blinds').value, deck: $('f-deck').value, showEquity: $('f-eq').value === '1',
  };
  saveSettings();
}

function needName() {
  if (settings.name) return false;
  $('f-name').focus();
  $('f-name').classList.add('bad');
  return true;
}

function showHome(prefillRoom = '') {
  teardown();
  const s = settings;
  if (prefillRoom) {
    openModal(`<h2>⚽ You're invited to a Fútbol Poker table</h2>
      <div class="sub">Table <b>${prefillRoom}</b>. Pick a name and take a seat.</div>
      <div class="form">
        <label>Your name</label><input id="f-name" value="${esc(s.name)}" maxlength="16" placeholder="e.g. Jaime" autofocus>
        <label>Show win %</label><select id="f-eq"><option value="1" ${s.showEquity ? 'selected' : ''}>Yes (learning mode)</option><option value="0" ${!s.showEquity ? 'selected' : ''}>No</option></select>
      </div>
      <div class="foot"><button class="ghost" id="m-other">Not now</button><button class="ghost" id="m-rules">How to play</button><button class="primary" id="m-join">Join table</button></div>`, 'home');
    $('m-rules').onclick = showRules;
    $('m-other').onclick = () => { history.replaceState(null, '', location.pathname); showHome(); };
    const go = () => {
      settings.name = ($('f-name').value || '').trim().slice(0, 16);
      settings.showEquity = $('f-eq').value === '1';
      if (!settings.name) return $('f-name').classList.add('bad');
      saveSettings();
      joinTable(prefillRoom);
    };
    $('m-join').onclick = go;
    $('f-name').onkeydown = e => { if (e.key === 'Enter') go(); };
    return;
  }
  openModal(`<h2>⚽ Fútbol Poker</h2>
    <div class="sub">Texas Hold'em where the cards are footballers. Build the best 5-a-side team from your 2 players + 5 on the board — talent counts, chemistry counts more.</div>
    <div class="form">
      <label>Your name</label><input id="f-name" value="${esc(s.name)}" maxlength="16" placeholder="e.g. Jaime">
      <label>Computer players</label><select id="f-bots">${[0, 1, 2, 3, 4, 5].map(n => `<option ${n === s.bots ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label>Starting chips</label><select id="f-stack">${[500, 1000, 2000, 5000].map(n => `<option ${n === s.stack ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label>Blinds</label><select id="f-blinds">${['5/10', '10/20', '25/50', '50/100'].map(n => `<option ${n === s.blinds ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label>Deck</label><select id="f-deck">
        <option value="all" ${s.deck === 'all' ? 'selected' : ''}>All 185 squads (1980s–2020s)</option>
        <option value="elite" ${s.deck === 'elite' ? 'selected' : ''}>Elite squads only</option>
      </select>
      <label>Show win %</label><select id="f-eq"><option value="1" ${s.showEquity ? 'selected' : ''}>Yes (learning mode)</option><option value="0" ${!s.showEquity ? 'selected' : ''}>No</option></select>
    </div>
    <div class="foot">
      <button class="ghost" id="m-rules">How to play</button>
      <button id="m-solo">Play vs computer</button>
      <button class="primary" id="m-host">Create online table</button>
    </div>
    <div class="join-row">
      <span>Joining a friend?</span>
      <input id="f-code" placeholder="Table code" maxlength="8">
      <button id="m-join">Join</button>
    </div>`, 'home');
  $('m-rules').onclick = showRules;
  $('m-solo').onclick = () => {
    readForm();
    if (needName()) return;
    if (settings.bots < 1) { $('f-bots').value = '4'; readForm(); }
    startSolo();
  };
  $('m-host').onclick = () => { readForm(); if (needName()) return; createRoom(); };
  $('m-join').onclick = () => {
    readForm();
    if (needName()) return;
    const code = normalizeCode($('f-code').value);
    if (!code) return $('f-code').classList.add('bad');
    joinTable(code);
  };
  $('f-code').onkeydown = e => { if (e.key === 'Enter') $('m-join').click(); };
}

function showLobby() {
  if (!host || host.started) return;
  if (host.bots == null) host.bots = Math.min(settings.bots, MAX_SEATS - 1);
  const players = lobbyPlayers();
  host.bots = Math.min(host.bots, MAX_SEATS - players.length);
  const total = players.length + host.bots;
  const link = inviteLink(host.code);
  openModal(`<h2>Your table is open</h2>
    <div class="sub">Send friends the link (or the code). Keep this tab open — your browser is the table.</div>
    <div class="invite">
      <div class="code">${host.code}</div>
      <input readonly value="${esc(link)}" id="l-link">
      <button class="gold" id="l-copy">Copy invite link</button>
    </div>
    <h3 class="lh">Seated (${total}/${MAX_SEATS})</h3>
    <ul class="lobby-list">
      ${players.map(p => `<li>${esc(p.name)} ${p.host ? '<span class="tag">host</span>' : ''}</li>`).join('')}
      ${Array.from({ length: host.bots }, () => '<li class="bot">Computer player</li>').join('')}
    </ul>
    <div class="form" style="margin-top:12px">
      <label>Computer players</label>
      <select id="l-bots">${Array.from({ length: MAX_SEATS - players.length + 1 }, (_, n) => `<option ${n === host.bots ? 'selected' : ''}>${n}</option>`).join('')}</select>
    </div>
    <div class="foot">
      <button class="ghost" id="l-leave">Close table</button>
      <button class="primary" id="l-start" ${total < 2 ? 'disabled' : ''}>Start game (${total} players)</button>
    </div>`, 'lobby');
  $('l-copy').onclick = () => copyInvite(host.code, $('l-copy'));
  $('l-link').onclick = e => e.target.select();
  $('l-bots').onchange = e => { host.bots = +e.target.value; showLobby(); };
  $('l-leave').onclick = () => { teardown(); showHome(); };
  $('l-start').onclick = startOnline;
  broadcastLobby();
}

function showClientLobby() {
  const l = client.lobby;
  openModal(`<h2>Table ${l.code}</h2>
    <div class="sub">You're in. Waiting for the host to start — ${l.settings.stack} chips, blinds ${l.settings.blinds}.</div>
    <ul class="lobby-list">
      ${l.players.map(p => `<li>${esc(p.name)} ${p.host ? '<span class="tag">host</span>' : ''}</li>`).join('')}
      ${Array.from({ length: l.bots }, () => '<li class="bot">Computer player</li>').join('')}
    </ul>
    <div class="foot"><button class="ghost" id="l-invite">Copy invite link</button><button class="ghost" id="l-leave">Leave</button></div>`, 'lobby');
  $('l-invite').onclick = () => copyInvite(l.code, $('l-invite'));
  $('l-leave').onclick = () => { teardown(); history.replaceState(null, '', location.pathname); showHome(); };
}

function showError(msg, retryCode) {
  openModal(`<h2>Hmm.</h2><div class="sub">${esc(msg)}</div>
    <div class="foot"><button class="ghost" id="m-home">Home</button>${retryCode ? `<button class="primary" id="m-retry">Try again</button>` : ''}</div>`, 'error');
  $('m-home').onclick = () => { history.replaceState(null, '', location.pathname); showHome(); };
  if ($('m-retry')) $('m-retry').onclick = () => joinTable(retryCode);
}

function showRules() {
  const prevHTML = $('modal').innerHTML, prevKind = overlayKind, wasOpen = !$('overlay').classList.contains('hidden');
  openModal(`<h2>How to play</h2>
    <div class="sub">Everything you know about Texas Hold'em applies — only the cards and the hand rankings change.</div>
    <div class="rules">
      <div>
        <h4>The deal</h4>
        <p>Each hand uses a fresh 52-card deck: <b>13 real squads × 4 players</b> (a squad = one club in one era, e.g. AC Milan 1980s). You get 2 players face down; 5 more come to the board (flop, turn, river) with betting in between. No-limit, blinds, side pots — standard rules.</p>
        <h4>Your team</h4>
        <p>At showdown your best <b>5-a-side team</b> from your 7 cards is picked automatically: <b>GK, DEF, MID, FWD + one flexible outfielder</b>. Players out of position lose rating; an outfielder in goal is a disaster.</p>
        <h4>Team score = Talent + Chemistry</h4>
        <p><b>Talent</b> is the average role rating (built from each player's attack, defense, technique, physical, keeping and overall).</p>
        <p><b>Chemistry</b> is how they play together:</p>
        <ul>
          <li><span style="color:var(--squad)">●</span> Teammates (same club & era): <b>+${CHEM.squadPair}</b> per pair</li>
          <li><span style="color:var(--club)">●</span> Same club, different era: <b>+${CHEM.clubPair}</b> per pair</li>
          <li><span style="color:var(--nation)">●</span> Same nationality: <b>+${CHEM.nationPair}</b> per pair, <b>+${CHEM.nationFlush}</b> if all five</li>
          <li><span style="color:var(--era)">●</span> One player from every era: <b>+${CHEM.eraStraight}</b></li>
          <li><span style="color:var(--style)">●</span> Playing styles: Tiki-Taka, Iron Wall, Lethal Strike Partnership, Engine Room: <b>+2–3</b></li>
        </ul>
      </div>
      <div>
        <h4>Hand names (strongest chemistry first)</h4>
        <table>${HAND_RANKINGS.map(([n, d]) => `<tr><td>${n}</td><td>${d}</td></tr>`).join('')}</table>
        <p class="hint" style="margin-top:10px">The hand name describes your chemistry, but the <b>team score decides the pot</b> — a Partnership of superstars can beat a Trio of journeymen.</p>
        <h4>Playing online</h4>
        <p>Create a table and send the invite link. The host's browser runs the game, so the host keeps the tab open. You get ${TURN_MS / 1000}s per decision; if you drop out you're checked/folded and can rejoin with the same link. Busted? Rebuy.</p>
        <h4>Keys</h4>
        <p><b>F</b> fold · <b>C</b> check/call · <b>R</b> bet/raise · <b>Enter</b> next hand</p>
      </div>
    </div>
    <div class="foot"><button class="primary" id="m-ok">${wasOpen ? 'Back' : 'Back to the table'}</button></div>`, 'rules');
  $('m-ok').onclick = () => {
    if (wasOpen && prevKind !== 'rules') {
      // Re-open whatever was showing before (home, lobby…) with live handlers.
      if (prevKind === 'home') return showHome(normalizeCode(new URLSearchParams(location.search).get('room')));
      if (prevKind === 'lobby' && mode === 'host') return showLobby();
      if (prevKind === 'lobby' && mode === 'client' && client?.lobby) return showClientLobby();
      if (prevKind === 'results') return showResults();
      $('modal').innerHTML = prevHTML; overlayKind = prevKind;
      return;
    }
    closeModal();
  };
}

boot().catch(err => {
  document.body.innerHTML = `<div style="padding:40px;color:#fff">Could not load player data (${esc(err.message)}).<br>Serve this folder over HTTP: <code>python3 -m http.server 8000</code></div>`;
});
