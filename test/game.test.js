const test = require('node:test');
const assert = require('node:assert');
const { RoomManager, isCorrectGuess, MAX_PLAYERS } = require('../src/game');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(n, opts = {}) {
  const m = new RoomManager({ turnMs: 60_000, ...opts });
  const room = m.createRoom('p0', 'Host');
  for (let i = 1; i < n; i++) m.joinRoom(room.code, `p${i}`, `Player ${i}`);
  return { m, room };
}
const current = (m, room) => m.currentTurnId(room);
const charOf = (room, id) => room.players.find((p) => p.id === id).character;
const cleanup = (m) => m.rooms.forEach((r) => m.closeRoom(r));

test('guess matching is forgiving', () => {
  const c = { name: 'Spider-Man', aliases: ['Peter Parker'] };
  assert.ok(isCorrectGuess('spiderman', c));
  assert.ok(isCorrectGuess('  SPIDER MAN ', c));
  assert.ok(isCorrectGuess('peter parker', c));
  assert.ok(isCorrectGuess('spidermn', c)); // small typo
  assert.ok(!isCorrectGuess('batman', c));
  assert.ok(!isCorrectGuess('', c));
  assert.ok(isCorrectGuess('beyonce', { name: 'Beyoncé' }));
  assert.ok(!isCorrectGuess('Thir', { name: 'Thor' })); // short names need exact match
});

test('room holds at most 10 players and rejects duplicates names', () => {
  const { m, room } = setup(MAX_PLAYERS);
  assert.throws(() => m.joinRoom(room.code, 'extra', 'Extra'), /full/);
  cleanup(m);
  const s = setup(2);
  assert.throws(() => s.m.joinRoom(s.room.code, 'x', 'host'), /taken/);
  cleanup(s.m);
});

test('only host can start, needs 2+ players, no joining mid-game', () => {
  const { m, room } = setup(1);
  assert.throws(() => m.startGame(room.code, 'p0'), /at least/);
  m.joinRoom(room.code, 'p1', 'Bob');
  assert.throws(() => m.startGame(room.code, 'p1'), /host/);
  m.startGame(room.code, 'p0');
  assert.strictEqual(room.phase, 'playing');
  assert.throws(() => m.joinRoom(room.code, 'p2', 'Late'), /already started/);
  cleanup(m);
});

test('each player sees others characters but not their own', () => {
  const { m, room } = setup(3);
  m.startGame(room.code, 'p0');
  const names = new Set(room.players.map((p) => p.character.name));
  assert.strictEqual(names.size, 3, 'characters are unique');
  const view = m.viewFor(room.code, 'p1');
  for (const p of view.players) {
    if (p.id === 'p1') assert.strictEqual(p.character, null);
    else assert.ok(p.character);
  }
  assert.ok(!JSON.stringify(view).includes(charOf(room, 'p1').name));
  cleanup(m);
});

test('only the current player may guess; wrong guess passes the turn', () => {
  const { m, room } = setup(3);
  m.startGame(room.code, 'p0');
  const first = current(m, room);
  const other = room.turnOrder.find((id) => id !== first);
  assert.throws(() => m.guess(room.code, other, 'x'), /not your turn/);
  assert.deepStrictEqual(m.guess(room.code, first, 'definitely wrong'), { correct: false });
  assert.notStrictEqual(current(m, room), first);
  cleanup(m);
});

test('correct guesses finish players until one is left', () => {
  const { m, room } = setup(3);
  m.startGame(room.code, 'p0');
  const a = current(m, room);
  assert.deepStrictEqual(m.guess(room.code, a, charOf(room, a).name), { correct: true });
  assert.strictEqual(room.players.find((p) => p.id === a).place, 1);
  assert.strictEqual(m.viewFor(room.code, a).players.find((p) => p.id === a).character, charOf(room, a).name);

  const b = current(m, room);
  assert.notStrictEqual(b, a);
  m.guess(room.code, b, charOf(room, b).name);
  assert.strictEqual(room.phase, 'ended');
  const loser = room.players.find((p) => p.status === 'lost');
  assert.ok(loser && loser.id !== a && loser.id !== b);

  m.backToLobby(room.code, 'p0');
  assert.strictEqual(room.phase, 'lobby');
  assert.ok(room.players.every((p) => p.status === 'waiting' && !p.character));
  cleanup(m);
});

test('turn advances automatically when the timer expires', async () => {
  const { m, room } = setup(2, { turnMs: 40 });
  m.startGame(room.code, 'p0');
  const first = current(m, room);
  await sleep(70);
  assert.notStrictEqual(current(m, room), first);
  cleanup(m);
});

test('leaving mid-turn moves to next player and host transfers', () => {
  const { m, room } = setup(3);
  m.startGame(room.code, 'p0');
  const first = current(m, room);
  m.leaveRoom(room.code, first);
  assert.strictEqual(room.phase, 'playing');
  assert.ok(current(m, room) && current(m, room) !== first);
  assert.ok(room.players.some((p) => p.id === room.hostId));
  m.leaveRoom(room.code, current(m, room));
  assert.strictEqual(room.phase, 'ended');
  cleanup(m);
});

test('disconnected lobby player is removed after grace period; rejoin keeps seat', async () => {
  const { m, room } = setup(3, { lobbyGraceMs: 40 });
  m.setConnected(room.code, 'p1', false);
  m.setConnected(room.code, 'p2', false);
  m.joinRoom(room.code, 'p2'); // came back
  await sleep(70);
  assert.deepStrictEqual(room.players.map((p) => p.id), ['p0', 'p2']);
  cleanup(m);
});
