// 32LDK online server — Express + Socket.IO. Game state lives only here; each player
// receives a redacted view (own hand only, other players' unknown cards hidden).
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const E = require('./public/engine.js');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

const rooms = new Map(); // code -> room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  for (let n = 0; n < 50; n++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no code');
}
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12);
const cleanPid = (s) => (typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null);
const seatOf = (room, pid) => room.players.findIndex((p) => p.pid === pid);
const isOnline = (room, pid) => [...room.sockets.values()].includes(pid);

function view(room, pid) {
  const you = seatOf(room, pid);
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    you,
    host: seatOf(room, room.hostPid),
    players: room.players.map((p, i) => ({
      name: p.name,
      online: isOnline(room, p.pid),
      total: p.total || 0,
      scores: p.scores || [],
      hand: (p.hand || []).map((c) => (i === you ? c : { v: c.k ? c.v : null, k: c.k })),
    })),
    doors: (room.doors || []).map(() => 0),
    spirit: room.spirit || [],
    excluded: room.excluded || 0,
    turn: room.turn ?? 0,
    round: room.round || 1,
    totalRounds: room.totalRounds || 1,
    last: room.last || null,
    log: room.log || [],
    seq: room.seq || 0,
  };
}
function broadcast(room) {
  room.updatedAt = Date.now();
  for (const [sid, pid] of room.sockets) io.to(sid).emit('state', view(room, pid));
}
function detach(socket) {
  const code = socket.data.code;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.code = null;
  if (!room) return;
  room.sockets.delete(socket.id);
  broadcast(room);
}

io.on('connection', (socket) => {
  const reply = (cb, payload) => typeof cb === 'function' && cb(payload || {});
  const current = () => rooms.get(socket.data.code);

  socket.on('create', (d = {}, cb) => {
    const pid = cleanPid(d.pid), name = cleanName(d.name);
    if (!pid || !name) return reply(cb, { err: 'ニックネームを入力してください' });
    detach(socket);
    const code = genCode();
    const room = {
      code, hostPid: pid, status: 'lobby', settings: { mode: 'normal', chain: false },
      players: [{ pid, name }], sockets: new Map(), seq: 0, updatedAt: Date.now(),
    };
    rooms.set(code, room);
    room.sockets.set(socket.id, pid);
    socket.data = { code, pid };
    broadcast(room);
    reply(cb, { code });
  });

  socket.on('join', (d = {}, cb) => {
    const pid = cleanPid(d.pid), name = cleanName(d.name);
    const code = String(d.code || '').trim().toUpperCase();
    if (!pid) return reply(cb, { err: '接続情報が不正です' });
    const room = rooms.get(code);
    if (!room) return reply(cb, { err: 'その部屋は見つかりません（解散したか、コードが違います）', gone: true });
    let seat = seatOf(room, pid), spectate = false;
    if (seat < 0) {
      if (room.status !== 'lobby') spectate = true;
      else if (!name) return reply(cb, { err: 'ニックネームを入力してください' });
      else if (room.players.length >= 6) return reply(cb, { err: '満員です（最大6人）' });
      else room.players.push({ pid, name });
    } else if (room.status === 'lobby' && name) {
      room.players[seat].name = name;
    }
    if (socket.data.code !== code) detach(socket);
    room.sockets.set(socket.id, pid);
    socket.data = { code, pid };
    broadcast(room);
    reply(cb, { code, spectate });
  });

  socket.on('leave', (_d, cb) => {
    const room = current();
    if (room && room.status === 'lobby') {
      const pid = socket.data.pid;
      room.players = room.players.filter((p) => p.pid !== pid);
      if (room.hostPid === pid && room.players.length) room.hostPid = room.players[0].pid;
    }
    detach(socket);
    if (room && !room.players.length) {
      for (const sid of room.sockets.keys()) io.to(sid).emit('closed');
      rooms.delete(room.code);
    }
    reply(cb);
  });

  socket.on('kick', (d = {}, cb) => {
    const room = current();
    if (!room || room.hostPid !== socket.data.pid || room.status !== 'lobby') return reply(cb, { err: 'ホストだけが操作できます' });
    const p = room.players[d.seat | 0];
    if (!p || p.pid === room.hostPid) return reply(cb, { err: 'その人は外せません' });
    room.players.splice(d.seat | 0, 1);
    for (const [sid, pid] of room.sockets) if (pid === p.pid) { io.to(sid).emit('closed', { kicked: true }); room.sockets.delete(sid); }
    broadcast(room);
    reply(cb);
  });

  socket.on('settings', (d = {}, cb) => {
    const room = current();
    if (!room || room.hostPid !== socket.data.pid || room.status !== 'lobby') return reply(cb, { err: 'ホストだけが設定できます' });
    if (['short', 'normal', 'long'].includes(d.mode)) room.settings.mode = d.mode;
    if (typeof d.chain === 'boolean') room.settings.chain = d.chain;
    broadcast(room);
    reply(cb);
  });

  socket.on('start', (_d, cb) => {
    const room = current();
    if (!room || room.hostPid !== socket.data.pid) return reply(cb, { err: 'ホストだけが開始できます' });
    if (room.status !== 'lobby') return reply(cb);
    if (room.players.length < 3) return reply(cb, { err: '3人以上必要です' });
    E.newGame(room);
    broadcast(room);
    reply(cb);
  });

  socket.on('act', (a = {}, cb) => {
    const room = current();
    if (!room) return reply(cb, { err: '部屋に入っていません' });
    const action = {
      type: String(a.type || ''),
      i: Number(a.i) | 0,
      t: Number(a.t) | 0,
      vals: Array.isArray(a.vals) ? a.vals.slice(0, 32).map((v) => Number(v) | 0) : [],
    };
    const err = E.act(room, seatOf(room, socket.data.pid), action);
    if (err) return reply(cb, { err });
    broadcast(room);
    reply(cb);
  });

  socket.on('next', (_d, cb) => {
    const room = current();
    if (!room || seatOf(room, socket.data.pid) < 0) return reply(cb, { err: '参加者だけが進められます' });
    if (room.status === 'roundEnd') { E.nextRound(room); broadcast(room); }
    reply(cb);
  });

  socket.on('again', (_d, cb) => {
    const room = current();
    if (!room || seatOf(room, socket.data.pid) < 0) return reply(cb, { err: '参加者だけが操作できます' });
    if (room.status === 'finished') {
      room.status = 'lobby'; room.last = null; room.doors = []; room.spirit = []; room.log = [];
      room.players.forEach((p) => { p.hand = []; p.scores = []; p.total = 0; });
      broadcast(room);
    }
    reply(cb);
  });

  socket.on('disconnect', () => detach(socket));
});

// Forget rooms nobody has touched for 6 hours.
setInterval(() => {
  const limit = Date.now() - 6 * 3600e3;
  for (const [code, r] of rooms) if (r.updatedAt < limit && r.sockets.size === 0) rooms.delete(code);
}, 10 * 60e3).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`32LDK server listening on :${PORT}`));
