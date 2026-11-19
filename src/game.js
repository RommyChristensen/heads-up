const DEFAULT_CHARACTERS = require('./characters');

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const TURN_MS = 30_000;
const LOBBY_DISCONNECT_GRACE_MS = 30_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
const MAX_LOG = 50;

class GameError extends Error {}

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/ /g, '');
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** True when `guess` names `character` (case/punctuation-insensitive, aliases, small typos). */
function isCorrectGuess(guess, character) {
  const g = normalize(guess);
  if (!g) return false;
  return [character.name, ...(character.aliases || [])].some((candidate) => {
    const c = normalize(candidate);
    if (g === c) return true;
    const tolerance = c.length >= 10 ? 2 : c.length >= 5 ? 1 : 0;
    return levenshtein(g, c) <= tolerance;
  });
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!n) throw new GameError('Please enter your name.');
  return n;
}

class RoomManager {
  /**
   * @param {object} opts
   * @param {(code: string) => void} opts.onChange called whenever a room's state changes
   */
  constructor({ onChange = () => {}, turnMs = TURN_MS, lobbyGraceMs = LOBBY_DISCONNECT_GRACE_MS, characters = DEFAULT_CHARACTERS } = {}) {
    this.rooms = new Map();
    this.onChange = onChange;
    this.turnMs = turnMs;
    this.lobbyGraceMs = lobbyGraceMs;
    this.characters = characters;
  }

  // ---------- room management ----------

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  getRoom(code) {
    const room = this.rooms.get(String(code || '').toUpperCase().trim());
    if (!room) throw new GameError('Room not found. Check the code and try again.');
    return room;
  }

  createRoom(playerId, name) {
    const code = this.newCode();
    const room = {
      code,
      hostId: playerId,
      phase: 'lobby', // lobby | playing | ended
      players: [],
      turnOrder: [],
      turnIndex: -1,
      turnEndsAt: null,
      turnTimer: null,
      round: 0,
      log: [],
    };
    this.rooms.set(code, room);
    this.addPlayer(room, playerId, name);
    return room;
  }

  addPlayer(room, playerId, name) {
    room.players.push({
      id: playerId,
      name: cleanName(name),
      connected: true,
      character: null,
      status: 'waiting', // waiting | playing | won | lost
      place: null,
      removeTimer: null,
    });
  }

  joinRoom(code, playerId, name) {
    const room = this.getRoom(code);
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      // Rejoining (e.g. after refresh): keep seat, allow a name change in the lobby.
      if (room.phase === 'lobby' && name) existing.name = cleanName(name);
      this.setConnected(room.code, playerId, true);
      return room;
    }
    if (room.phase !== 'lobby') throw new GameError('This game has already started.');
    if (room.players.length >= MAX_PLAYERS) throw new GameError(`Room is full (max ${MAX_PLAYERS} players).`);
    const clean = cleanName(name);
    if (room.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      throw new GameError('That name is already taken in this room.');
    }
    this.addPlayer(room, playerId, clean);
    this.pushLog(room, `${clean} joined.`);
    this.changed(room);
    return room;
  }

  leaveRoom(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return;
    const idx = room.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return;
    const [player] = room.players.splice(idx, 1);
    clearTimeout(player.removeTimer);
    this.pushLog(room, `${player.name} left.`);

    if (room.players.length === 0) {
      this.closeRoom(room);
      return;
    }
    if (room.hostId === playerId) {
      const next = room.players.find((p) => p.connected) || room.players[0];
      room.hostId = next.id;
      this.pushLog(room, `${next.name} is now the host.`);
    }
    if (room.phase === 'playing') {
      const wasCurrent = room.turnOrder[room.turnIndex] === playerId;
      const orderIdx = room.turnOrder.indexOf(playerId);
      room.turnOrder.splice(orderIdx, 1);
      if (orderIdx !== -1 && orderIdx < room.turnIndex) room.turnIndex--;
      if (!this.checkGameOver(room) && wasCurrent) {
        room.turnIndex--; // the next player slid into this slot
        this.nextTurn(room);
        return;
      }
    }
    this.changed(room);
  }

  kickPlayer(code, hostId, targetId) {
    const room = this.getRoom(code);
    if (room.hostId !== hostId) throw new GameError('Only the host can remove players.');
    if (targetId === hostId) throw new GameError('You cannot remove yourself.');
    this.leaveRoom(room.code, targetId);
  }

  setConnected(code, playerId, connected) {
    const room = this.rooms.get(code);
    if (!room) return;
    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;
    player.connected = connected;
    clearTimeout(player.removeTimer);
    player.removeTimer = null;
    if (!connected && room.phase === 'lobby') {
      // Free the seat if they don't come back soon.
      player.removeTimer = setTimeout(() => this.leaveRoom(room.code, playerId), this.lobbyGraceMs);
    }
    if (!connected && room.hostId === playerId) {
      const next = room.players.find((p) => p.connected);
      if (next) {
        room.hostId = next.id;
        this.pushLog(room, `${next.name} is now the host.`);
      }
    }
    this.changed(room);
  }

  closeRoom(room) {
    clearTimeout(room.turnTimer);
    room.players.forEach((p) => clearTimeout(p.removeTimer));
    this.rooms.delete(room.code);
  }

  // ---------- game flow ----------

  startGame(code, playerId) {
    const room = this.getRoom(code);
    if (room.hostId !== playerId) throw new GameError('Only the host can start the game.');
    if (room.phase === 'playing') throw new GameError('The game is already running.');
    if (room.players.length < MIN_PLAYERS) throw new GameError(`You need at least ${MIN_PLAYERS} players.`);
    if (room.players.length > this.characters.length) throw new GameError('Not enough characters.');

    const chars = shuffle(this.characters);
    room.players.forEach((p, i) => {
      p.character = chars[i];
      p.status = 'playing';
      p.place = null;
    });
    room.turnOrder = shuffle(room.players.map((p) => p.id));
    room.turnIndex = -1;
    room.phase = 'playing';
    room.round = 0;
    room.log = [];
    this.pushLog(room, 'The game has started! Ask yes/no questions to figure out who you are.');
    this.nextTurn(room);
  }

  nextTurn(room) {
    clearTimeout(room.turnTimer);
    const n = room.turnOrder.length;
    const isActive = (id) => room.players.find((p) => p.id === id)?.status === 'playing';
    const isOnline = (id) => room.players.find((p) => p.id === id)?.connected;

    // Prefer the next active player who is online; fall back to any active player.
    let chosen = -1;
    for (const needOnline of [true, false]) {
      for (let step = 1; step <= n; step++) {
        const i = (room.turnIndex + step) % n;
        const id = room.turnOrder[i];
        if (isActive(id) && (!needOnline || isOnline(id))) { chosen = i; break; }
      }
      if (chosen !== -1) break;
    }
    if (chosen === -1) return this.checkGameOver(room);

    if (chosen <= room.turnIndex || room.turnIndex === -1) room.round++;
    room.turnIndex = chosen;
    room.turnEndsAt = Date.now() + this.turnMs;
    const turnPlayer = room.players.find((p) => p.id === room.turnOrder[chosen]);
    room.turnTimer = setTimeout(() => {
      this.pushLog(room, `⏰ Time's up for ${turnPlayer.name}.`);
      this.nextTurn(room);
    }, this.turnMs);
    this.changed(room);
  }

  currentTurnId(room) {
    return room.phase === 'playing' ? room.turnOrder[room.turnIndex] : null;
  }

  requireTurn(code, playerId) {
    const room = this.getRoom(code);
    if (room.phase !== 'playing') throw new GameError('The game is not running.');
    if (this.currentTurnId(room) !== playerId) throw new GameError("It's not your turn yet.");
    return room;
  }

  guess(code, playerId, text) {
    const room = this.requireTurn(code, playerId);
    const player = room.players.find((p) => p.id === playerId);
    const guessText = String(text || '').trim().slice(0, 60);
    if (!guessText) throw new GameError('Type a guess first.');

    if (isCorrectGuess(guessText, player.character)) {
      player.status = 'won';
      player.place = room.players.filter((p) => p.status === 'won').length;
      this.pushLog(room, `🎉 ${player.name} guessed it — they are ${player.character.name}! (#${player.place})`);
      if (!this.checkGameOver(room)) this.nextTurn(room);
      return { correct: true };
    }
    this.pushLog(room, `❌ ${player.name} guessed "${guessText}" — wrong.`);
    this.nextTurn(room);
    return { correct: false };
  }

  passTurn(code, playerId) {
    const room = this.requireTurn(code, playerId);
    const player = room.players.find((p) => p.id === playerId);
    this.pushLog(room, `${player.name} passed.`);
    this.nextTurn(room);
  }

  /** Ends the game when at most one player is still guessing. Returns true if it ended. */
  checkGameOver(room) {
    if (room.phase !== 'playing') return false;
    const remaining = room.players.filter((p) => p.status === 'playing');
    if (remaining.length > 1) return false;
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.turnEndsAt = null;
    room.phase = 'ended';
    for (const p of remaining) {
      p.status = 'lost';
      this.pushLog(room, `${p.name} is the last one standing — they were ${p.character.name}.`);
    }
    this.pushLog(room, 'Game over!');
    this.changed(room);
    return true;
  }

  backToLobby(code, playerId) {
    const room = this.getRoom(code);
    if (room.hostId !== playerId) throw new GameError('Only the host can do that.');
    clearTimeout(room.turnTimer);
    room.phase = 'lobby';
    room.turnOrder = [];
    room.turnIndex = -1;
    room.turnEndsAt = null;
    room.log = [];
    room.players.forEach((p) => {
      p.character = null;
      p.status = 'waiting';
      p.place = null;
      if (!p.connected) this.setConnected(room.code, p.id, false); // start the lobby grace timer
    });
    this.changed(room);
  }

  // ---------- helpers ----------

  pushLog(room, text) {
    room.log.push({ t: Date.now(), text });
    if (room.log.length > MAX_LOG) room.log.shift();
  }

  changed(room) {
    if (this.rooms.has(room.code)) this.onChange(room.code);
  }

  /** The room state as seen by one player — their own character stays hidden until they've guessed it. */
  viewFor(code, viewerId) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const turnId = this.currentTurnId(room);
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      you: viewerId,
      maxPlayers: MAX_PLAYERS,
      minPlayers: MIN_PLAYERS,
      turnMs: this.turnMs,
      turnId,
      turnRemainingMs: room.turnEndsAt ? Math.max(0, room.turnEndsAt - Date.now()) : null,
      round: room.round,
      turnOrder: room.turnOrder,
      players: room.players.map((p) => {
        const reveal = p.id !== viewerId || p.status === 'won' || room.phase === 'ended';
        return {
          id: p.id,
          name: p.name,
          connected: p.connected,
          status: p.status,
          place: p.place,
          character: p.character && reveal ? p.character.name : null,
        };
      }),
      log: room.log.slice(-20),
    };
  }
}

module.exports = { RoomManager, GameError, isCorrectGuess, normalize, MAX_PLAYERS, MIN_PLAYERS, TURN_MS };
