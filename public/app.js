(() => {
  const $ = (sel) => document.querySelector(sel);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  // Stable per-device identity so a refresh / reconnect keeps your seat.
  let playerId = store.get('hu:playerId');
  if (!playerId) {
    playerId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    store.set('hu:playerId', playerId);
  }

  const socket = io({ auth: { playerId } });
  let state = null;
  let turnDeadline = null; // local timestamp when the current turn ends
  let lastTurnKey = null;

  // ---------- helpers ----------
  const COLORS = ['#5b3df5', '#ff7a59', '#19a463', '#e5484d', '#0ea5e9', '#d946ef', '#f59e0b', '#14b8a6', '#8b5cf6', '#ef4444'];
  const colorFor = (id) => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const avatar = (p) => `<div class="avatar" style="background:${colorFor(p.id)}">${esc(p.name[0].toUpperCase())}</div>`;

  function toast(msg, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.className = 'toast'), 2600);
  }

  function emit(event, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload, (err, res) => {
        if (err) res = { ok: false, error: 'Connection problem. Try again.' };
        if (!res.ok) toast(res.error, 'bad');
        resolve(res);
      });
    });
  }

  function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }

  function confetti() {
    for (let i = 0; i < 60; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = COLORS[i % COLORS.length];
      c.style.animationDuration = 1.5 + Math.random() * 1.5 + 's';
      c.style.animationDelay = Math.random() * 0.4 + 's';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 3500);
    }
  }

  function show(screen) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== `screen-${screen}`);
  }

  // ---------- home ----------
  const nameInput = $('#name-input');
  const codeInput = $('#code-input');
  nameInput.value = store.get('hu:name') || '';
  const urlCode = new URLSearchParams(location.search).get('room');
  if (urlCode) codeInput.value = urlCode.toUpperCase().slice(0, 4);

  const getName = () => {
    const n = nameInput.value.trim();
    if (!n) { toast('Enter your name first', 'bad'); nameInput.focus(); return null; }
    store.set('hu:name', n);
    return n;
  };

  async function entered(res) {
    if (!res.ok) return;
    store.set('hu:room', res.code);
    history.replaceState(null, '', `?room=${res.code}`);
  }

  $('#create-btn').onclick = async () => {
    const name = getName();
    if (name) entered(await emit('room:create', { name }));
  };
  const join = async () => {
    const name = getName();
    const code = codeInput.value.trim().toUpperCase();
    if (!name) return;
    if (code.length !== 4) { toast('Enter the 4-letter room code', 'bad'); codeInput.focus(); return; }
    entered(await emit('room:join', { name, code }));
  };
  $('#join-btn').onclick = join;
  codeInput.addEventListener('input', () => (codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '')));
  codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && join());
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && (codeInput.value.length === 4 ? join() : $('#create-btn').click()));

  function leftRoom(msg) {
    state = null;
    store.set('hu:room', null);
    history.replaceState(null, '', location.pathname);
    codeInput.value = '';
    show('home');
    if (msg) toast(msg);
  }

  for (const b of document.querySelectorAll('[data-action="leave"]')) {
    b.onclick = async () => {
      if (state?.phase === 'playing' && !confirm('Leave the game in progress?')) return;
      await emit('room:leave');
      leftRoom();
    };
  }

  // ---------- lobby ----------
  $('#share-btn').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${state.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Heads Up!', text: `Join my Heads Up game! Code: ${state.code}`, url });
      else { await navigator.clipboard.writeText(url); toast('Invite link copied!', 'good'); }
    } catch { /* user cancelled */ }
  };
  $('#start-btn').onclick = () => emit('game:start');
  $('#lobby-players').onclick = (e) => {
    const id = e.target.closest('[data-kick]')?.dataset.kick;
    if (!id) return;
    const p = state.players.find((x) => x.id === id);
    if (p && confirm(`Remove ${p.name} from the room?`)) emit('room:kick', { targetId: id });
  };

  function renderLobby() {
    const isHost = state.hostId === playerId;
    $('#room-code').textContent = state.code;
    $('#lobby-count').textContent = `${state.players.length}/${state.maxPlayers} players`;
    $('#lobby-players').innerHTML = state.players.map((p) => `
      <li>
        ${avatar(p)}
        <span class="pname">${esc(p.name)}${p.id === playerId ? ' <span class="muted">(you)</span>' : ''}</span>
        ${p.id === state.hostId ? '<span class="tag host">👑 Host</span>' : ''}
        ${!p.connected ? '<span class="tag off">offline</span>' : ''}
        ${isHost && p.id !== playerId ? `<button class="btn danger-link" data-kick="${p.id}">Remove</button>` : ''}
      </li>`).join('');

    const enough = state.players.length >= state.minPlayers;
    $('#start-btn').classList.toggle('hidden', !isHost);
    $('#start-btn').disabled = !enough;
    $('#lobby-hint').textContent = isHost
      ? (enough ? 'Everyone in? Start when ready.' : `Waiting for at least ${state.minPlayers} players…`)
      : 'Waiting for the host to start the game…';
  }

  // ---------- game ----------
  const guessInput = $('#guess-input');
  $('#guess-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = guessInput.value.trim();
    if (!text) return;
    const res = await emit('game:guess', { text });
    if (!res.ok) return;
    guessInput.value = '';
    if (res.correct) { toast('Correct! You got it! 🎉', 'good'); confetti(); vibrate([60, 40, 60]); }
    else { toast('Nope — not quite!', 'bad'); vibrate(200); $('#guess-form').classList.add('shake'); setTimeout(() => $('#guess-form').classList.remove('shake'), 400); }
  };
  $('#pass-btn').onclick = () => emit('game:pass');

  function statusText(p) {
    if (p.status === 'won') return `✅ Guessed it (#${p.place})`;
    if (p.status === 'lost') return '🫠 Last one standing';
    if (p.id === state.turnId) return '🎤 Their turn';
    return p.connected ? 'Still guessing' : '⚠️ Offline';
  }

  function renderGame() {
    const me = state.players.find((p) => p.id === playerId);
    const turnPlayer = state.players.find((p) => p.id === state.turnId);
    const myTurn = state.turnId === playerId;
    const remaining = state.players.filter((p) => p.status === 'playing').length;

    $('#round-label').textContent = `Round ${state.round} · ${remaining} left`;

    const banner = $('#turn-banner');
    banner.classList.toggle('mine', myTurn);
    $('#turn-title').textContent = myTurn ? "🎤 It's your turn!" : `${turnPlayer ? turnPlayer.name : '—'}'s turn`;
    $('#turn-sub').textContent = myTurn
      ? 'Ask yes/no questions, then make a guess.'
      : me.status === 'won' ? 'Help the others with yes/no answers!' : 'Answer their yes/no questions.';

    const panel = $('#my-panel');
    if (me.status === 'won') {
      panel.className = 'my-panel won';
      panel.innerHTML = `<div class="label">You were</div><div class="big-q">${esc(me.character)}</div><div>🏅 Finished #${me.place}</div>`;
    } else {
      panel.className = 'my-panel';
      panel.innerHTML = `<div class="label">Your character</div><div class="big-q">❓❓❓</div><div>Only you can't see it!</div>`;
    }

    const form = $('#guess-form');
    const wasHidden = form.classList.contains('hidden');
    form.classList.toggle('hidden', !myTurn);
    if (myTurn && wasHidden) { guessInput.value = ''; }

    // Vibrate once when your turn begins.
    const turnKey = `${state.round}:${state.turnId}`;
    if (turnKey !== lastTurnKey) {
      lastTurnKey = turnKey;
      if (myTurn) { vibrate([100, 50, 100]); toast("Your turn! You have 30 seconds."); }
    }

    // Others, in turn order.
    const order = state.turnOrder.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
    $('#cards').innerHTML = order.filter((p) => p.id !== playerId).map((p) => `
      <div class="card ${p.id === state.turnId ? 'turn' : ''} ${p.status !== 'playing' ? 'done' : ''}">
        <div class="who">${avatar(p)}<span>${esc(p.name)}</span></div>
        <div class="char">${esc(p.character || '?')}</div>
        <div class="state">${statusText(p)}</div>
      </div>`).join('');

    renderLog();
  }

  function renderLog() {
    $('#log').innerHTML = state.log.slice().reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');
  }

  function tick() {
    if (state?.phase === 'playing' && turnDeadline) {
      const ms = Math.max(0, turnDeadline - Date.now());
      const secs = Math.ceil(ms / 1000);
      $('#timer-text').textContent = secs;
      $('#timer-ring').style.strokeDashoffset = String(119.4 * (1 - ms / state.turnMs));
      $('.timer').classList.toggle('low', secs <= 5);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---------- results ----------
  $('#again-btn').onclick = () => emit('game:lobby');

  function renderResults() {
    const medals = ['🥇', '🥈', '🥉'];
    const ranked = state.players.slice().sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
    $('#results').innerHTML = ranked.map((p) => `
      <li>
        <span class="medal">${p.place ? (medals[p.place - 1] || `#${p.place}`) : '🫠'}</span>
        ${avatar(p)}
        <div class="info"><b>${esc(p.name)}${p.id === playerId ? ' (you)' : ''}</b><span class="muted">was ${esc(p.character || '?')}</span></div>
      </li>`).join('');
    const isHost = state.hostId === playerId;
    $('#again-btn').classList.toggle('hidden', !isHost);
    $('#again-hint').classList.toggle('hidden', isHost);
  }

  // ---------- socket events ----------
  socket.on('state', (s) => {
    const prevPhase = state?.phase;
    state = s;
    turnDeadline = s.turnRemainingMs != null ? Date.now() + s.turnRemainingMs : null;
    if (s.phase === 'lobby') { show('lobby'); renderLobby(); }
    else if (s.phase === 'playing') { show('game'); renderGame(); if (prevPhase !== 'playing') window.scrollTo(0, 0); }
    else { show('results'); renderResults(); if (prevPhase === 'playing') confetti(); }
  });

  socket.on('kicked', () => leftRoom('You were removed from the room.'));

  socket.on('connect', async () => {
    const code = store.get('hu:room');
    if (!code) return;
    const res = await new Promise((r) => socket.emit('room:resume', { code }, r));
    if (!res.ok) leftRoom(state ? res.error : null);
  });
  socket.on('disconnect', () => toast('Connection lost — reconnecting…', 'bad'));
})();
