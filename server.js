const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager, GameError } = require('./src/game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

// playerId -> Set of socket ids (a player may have the page open in more than one tab)
const sockets = new Map();

const manager = new RoomManager({
  onChange: (code) => broadcast(code),
});

function broadcast(code) {
  const room = manager.rooms.get(code);
  if (!room) return;
  for (const p of room.players) {
    const view = manager.viewFor(code, p.id);
    for (const sid of sockets.get(p.id) || []) io.to(sid).emit('state', view);
  }
}

io.on('connection', (socket) => {
  const playerId = String(socket.handshake.auth?.playerId || '').slice(0, 64);
  if (!playerId) return socket.disconnect(true);

  if (!sockets.has(playerId)) sockets.set(playerId, new Set());
  sockets.get(playerId).add(socket.id);
  socket.data.roomCode = null;

  const handle = (event, fn) => {
    socket.on(event, (payload = {}, ack = () => {}) => {
      if (typeof ack !== 'function') ack = () => {};
      try {
        ack({ ok: true, ...(fn(payload || {}) || {}) });
      } catch (err) {
        if (!(err instanceof GameError)) console.error(err);
        ack({ ok: false, error: err instanceof GameError ? err.message : 'Something went wrong.' });
      }
    });
  };

  const enter = (room) => {
    if (socket.data.roomCode && socket.data.roomCode !== room.code) {
      manager.leaveRoom(socket.data.roomCode, playerId);
    }
    socket.data.roomCode = room.code;
    broadcast(room.code);
    return { code: room.code };
  };

  handle('room:create', ({ name }) => enter(manager.createRoom(playerId, name)));
  handle('room:join', ({ code, name }) => enter(manager.joinRoom(code, playerId, name)));
  handle('room:resume', ({ code }) => {
    const room = manager.getRoom(code);
    if (!room.players.some((p) => p.id === playerId)) throw new GameError('You are no longer in that room.');
    return enter(manager.joinRoom(code, playerId));
  });
  handle('room:leave', () => {
    if (socket.data.roomCode) manager.leaveRoom(socket.data.roomCode, playerId);
    socket.data.roomCode = null;
  });
  handle('room:kick', ({ targetId }) => {
    manager.kickPlayer(socket.data.roomCode, playerId, targetId);
    for (const sid of sockets.get(targetId) || []) io.to(sid).emit('kicked');
  });
  handle('game:start', () => manager.startGame(socket.data.roomCode, playerId));
  handle('game:guess', ({ text }) => manager.guess(socket.data.roomCode, playerId, text));
  handle('game:pass', () => manager.passTurn(socket.data.roomCode, playerId));
  handle('game:lobby', () => manager.backToLobby(socket.data.roomCode, playerId));

  socket.on('disconnect', () => {
    const set = sockets.get(playerId);
    set?.delete(socket.id);
    if (set && set.size === 0) {
      sockets.delete(playerId);
      if (socket.data.roomCode) manager.setConnected(socket.data.roomCode, playerId, false);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Heads Up running on http://localhost:${PORT}`));
