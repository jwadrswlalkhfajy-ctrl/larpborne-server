'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const MAX_PLAYERS = 4;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'saves.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
let saves = {};
try { saves = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch (_) {}
function persist() {
  try { fs.writeFileSync(SAVE_FILE + '.tmp', JSON.stringify(saves)); fs.renameSync(SAVE_FILE + '.tmp', SAVE_FILE); }
  catch (e) { console.error('Save write failed:', e.message); }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, service: 'Larpborne Online', players: wss.clients.size }));
  }
  res.writeHead(404); res.end('Not found');
});
const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });
const rooms = new Map();
const profiles = new Map();
const friends = new Map();
const clients = new Map();
const BOSS_MAX = { beast: 1000, gascoigne: 1400, void_guard: 1800 };

function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, except = null) { for (const id of room.members) { const c = clients.get(id); if (c && c.ws !== except) send(c.ws, obj); } }
function cleanName(v) { return String(v || 'الصياد').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || 'الصياد'; }
function cleanText(v, n = 180) { return String(v || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n); }
function roomInfo(r) { return { code: r.code, name: r.name, count: r.members.size, capacity: r.capacity, public: r.public }; }
function sendFriends(c) {
  const list = [...(friends.get(c.name) || [])].map(name => ({ name, online: [...clients.values()].some(x => x.name.toLowerCase() === name.toLowerCase()) }));
  send(c.ws, { type: 'friendsList', friends: list });
}
function leaveRoom(c) {
  if (!c.room) return;
  const r = rooms.get(c.room); if (!r) { c.room = null; return; }
  r.members.delete(c.id); broadcast(r, { type: 'leave', id: c.id });
  if (r.members.size === 0) rooms.delete(r.code);
  else broadcast(r, { type: 'roomUpdate', count: r.members.size });
  c.room = null;
}
function joinRoom(c, code, replyType = 'joined') {
  const r = rooms.get(String(code || '').toUpperCase());
  if (!r) return send(c.ws, { type: 'error', message: 'رمز الغرفة غير صحيح أو انتهت الغرفة.' });
  if (r.members.size >= r.capacity) return send(c.ws, { type: 'error', message: 'الغرفة ممتلئة.' });
  leaveRoom(c); c.room = r.code; r.members.add(c.id);
  send(c.ws, { type: replyType, room: roomInfo(r) });
  for (const id of r.members) {
    if (id === c.id) continue;
    const other = clients.get(id); if (other) send(c.ws, { type: 'player', id, name: other.name, x: other.x, z: other.z, yaw: other.yaw });
  }
  broadcast(r, { type: 'player', id: c.id, name: c.name, x: c.x, z: c.z, yaw: c.yaw }, c.ws);
  broadcast(r, { type: 'roomUpdate', count: r.members.size });
  send(c.ws, { type: 'bossStates', bosses: Object.entries(r.bosses).map(([name, hp]) => ({ name, hp })) });
  const saved = saves[c.name.toLowerCase()]; if (saved) send(c.ws, { type: 'progressData', data: saved });
}

wss.on('connection', ws => {
  const id = crypto.randomUUID();
  const c = { id, ws, name: 'الصياد', room: null, x: 0, z: 0, yaw: 0, last: Object.create(null) };
  clients.set(id, c); send(ws, { type: 'hello', id });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return send(ws, { type: 'error', message: 'رسالة غير مفهومة.' }); }
    if (!m || typeof m.type !== 'string') return;
    const now = Date.now();
    const limits = { position: 70, chat: 450, damage: 180, bossHit: 180, progress: 1000 };
    const wait = limits[m.type] || 80;
    if (c.last[m.type] && now - c.last[m.type] < wait) return;
    c.last[m.type] = now;
    switch (m.type) {
      case 'profile': {
        c.name = cleanName(m.name); profiles.set(c.name.toLowerCase(), c.name); sendFriends(c); break;
      }
      case 'create': {
        const capacity = Math.max(2, Math.min(MAX_PLAYERS, Number(m.capacity) || MAX_PLAYERS));
        let code; do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
        const r = { code, name: cleanText(m.name, 28) || 'صيد الصيادين', capacity, public: !!m.public, members: new Set(), bosses: { ...BOSS_MAX } };
        rooms.set(code, r); c.name = cleanName(m.playerName || c.name); joinRoom(c, code, 'created'); break;
      }
      case 'join': joinRoom(c, m.code); break;
      case 'list': send(ws, { type: 'rooms', rooms: [...rooms.values()].map(roomInfo) }); break;
      case 'position': {
        if (!c.room) break;
        c.x = Number.isFinite(Number(m.x)) ? Math.max(-100000, Math.min(100000, Number(m.x))) : c.x;
        c.z = Number.isFinite(Number(m.z)) ? Math.max(-100000, Math.min(100000, Number(m.z))) : c.z;
        c.yaw = Number.isFinite(Number(m.yaw)) ? Number(m.yaw) : c.yaw;
        const r = rooms.get(c.room); if (r) broadcast(r, { type: 'player', id: c.id, name: c.name, x: c.x, z: c.z, yaw: c.yaw }, ws);
        break;
      }
      case 'chat': {
        const r = rooms.get(c.room); const message = cleanText(m.message, 180);
        if (r && message) broadcast(r, { type: 'chat', name: c.name, message }); break;
      }
      case 'damage': {
        const target = clients.get(String(m.target)); const amount = Math.max(1, Math.min(80, Number(m.amount) || 1));
        if (target && c.room && target.room === c.room) send(target.ws, { type: 'damage', target: target.id, amount }); break;
      }
      case 'progress': {
        if (!c.name) break;
        try { const data = JSON.parse(JSON.stringify(m.data)); if (data && typeof data === 'object' && JSON.stringify(data).length < 12000) { saves[c.name.toLowerCase()] = data; persist(); } } catch (_) {}
        break;
      }
      case 'bossHit': {
        const r = rooms.get(c.room); const boss = String(m.boss || '');
        if (!r || !(boss in BOSS_MAX)) break;
        const amount = Math.max(0, Math.min(500, Number(m.amount) || 0));
        r.bosses[boss] = Math.max(0, r.bosses[boss] - amount);
        broadcast(r, { type: 'bossHit', boss, amount });
        broadcast(r, { type: 'bossStates', bosses: Object.entries(r.bosses).map(([name, hp]) => ({ name, hp })) });
        break;
      }
      case 'friends': sendFriends(c); break;
      case 'addFriend': {
        const name = cleanName(m.name); if (name.toLowerCase() === c.name.toLowerCase()) return send(ws, { type: 'friendNotice', message: 'ما تكدر تضيف نفسك.' });
        const set = friends.get(c.name) || new Set(); set.add(name); friends.set(c.name, set);
        send(ws, { type: 'friendNotice', message: 'تمت إضافة ' + name + ' إلى القائمة.' }); sendFriends(c); break;
      }
      default: send(ws, { type: 'error', message: 'هذا الأمر غير مدعوم.' });
    }
  });
  ws.on('close', () => { leaveRoom(c); clients.delete(id); });
  ws.on('error', () => { leaveRoom(c); clients.delete(id); });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Larpborne server listening on ${PORT}`));
