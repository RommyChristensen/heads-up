const DEFAULT_CATEGORIES = require('./characters');

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const OFFLINE_SKIP_MS = 15_000; // skip the current player if they're offline this long
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
    const tolerance = c.length >= 10 ? 2 : c.length >= 6 ? 1 : 0;
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
  constructor({ onChange = () => {}, offlineSkipMs = OFFLINE_SKIP_MS, lobbyGraceMs = LOBBY_DISCONNECT_GRACE_MS, categories = DEFAULT_CATEGORIES } = {}) {
    this.rooms = new Map();
    this.onChange = onChange;
    this.offlineSkipMs = offlineSkipMs;
    this.lobbyGraceMs = lobbyGraceMs;
    this.categories = categories;
    this.categoryById = new Map(categories.map((c) => [c.id, c]));
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
      skipTimer: null,
      round: 0,
      categoryIds: this.categories.map((c) => c.id), // all themes by default
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
    if (room.phase === 'playing') this.scheduleOfflineSkip(room);
    this.changed(room);
  }

  closeRoom(room) {
    clearTimeout(room.skipTimer);
    room.players.forEach((p) => clearTimeout(p.removeTimer));
    this.rooms.delete(room.code);
  }

  setCategories(code, playerId, ids) {
    const room = this.getRoom(code);
    if (room.hostId !== playerId) throw new GameError('Only the host can pick the themes.');
    if (room.phase === 'playing') throw new GameError('You cannot change themes during a game.');
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    const valid = this.categories.map((c) => c.id).filter((id) => wanted.has(id)); // keep canonical order
    if (valid.length === 0) throw new GameError('Pick at least one theme.');
    room.categoryIds = valid;
    this.changed(room);
  }

  /** Characters from the room's selected themes, each tagged with its theme. */
  poolFor(room) {
    return room.categoryIds.flatMap((id) => {
      const cat = this.categoryById.get(id);
      return cat.characters.map((ch) => ({ ...ch, category: cat.id }));
    });
  }

  // ---------- game flow ----------

  startGame(code, playerId) {
    const room = this.getRoom(code);
    if (room.hostId !== playerId) throw new GameError('Only the host can start the game.');
    if (room.phase === 'playing') throw new GameError('The game is already running.');
    if (room.players.length < MIN_PLAYERS) throw new GameError(`You need at least ${MIN_PLAYERS} players.`);
    const pool = this.poolFor(room);
    if (room.players.length > pool.length) {
      throw new GameError(`The selected themes only have ${pool.length} characters — pick more themes.`);
    }

    const chars = shuffle(pool);
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
    const themes = room.categoryIds.map((id) => this.categoryById.get(id).label);
    const themeText = themes.length === this.categories.length ? 'all themes' : themes.join(', ');
    this.pushLog(room, `The game has started (${themeText})! Ask yes/no questions to figure out who you are.`);
    this.nextTurn(room);
  }

  nextTurn(room) {
    clearTimeout(room.skipTimer);
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
    this.scheduleOfflineSkip(room);
    this.changed(room);
  }

  /** With no turn timer, an offline player would stall the game — skip them if they don't come back. */
  scheduleOfflineSkip(room) {
    clearTimeout(room.skipTimer);
    room.skipTimer = null;
    const current = room.players.find((p) => p.id === this.currentTurnId(room));
    if (!current || current.connected) return;
    room.skipTimer = setTimeout(() => {
      if (this.currentTurnId(room) !== current.id || current.connected) return;
      this.pushLog(room, `${current.name} is offline — skipping their turn.`);
      this.nextTurn(room);
    }, this.offlineSkipMs);
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

  /** Host can move things along if the current player has gone quiet. */
  skipTurn(code, hostId) {
    const room = this.getRoom(code);
    if (room.hostId !== hostId) throw new GameError('Only the host can skip a turn.');
    if (room.phase !== 'playing') throw new GameError('The game is not running.');
    const current = room.players.find((p) => p.id === this.currentTurnId(room));
    this.pushLog(room, `⏭️ The host skipped ${current.name}'s turn.`);
    this.nextTurn(room);
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
    clearTimeout(room.skipTimer);
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
    clearTimeout(room.skipTimer);
    room.phase = 'lobby';
    room.turnOrder = [];
    room.turnIndex = -1;
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
      turnId,
      round: room.round,
      turnOrder: room.turnOrder,
      categories: this.categories.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji, count: c.characters.length })),
      categoryIds: room.categoryIds,
      players: room.players.map((p) => {
        const reveal = p.id !== viewerId || p.status === 'won' || room.phase === 'ended';
        return {
          id: p.id,
          name: p.name,
          connected: p.connected,
          status: p.status,
          place: p.place,
          character: p.character && reveal ? p.character.name : null,
          // The theme is a fair hint, so everyone (including the player) can see it.
          category: p.character ? p.character.category : null,
        };
      }),
      log: room.log.slice(-20),
    };
  }
}

module.exports = { RoomManager, GameError, isCorrectGuess, normalize, MAX_PLAYERS, MIN_PLAYERS };
