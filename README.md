# Heads Up!

A mobile-friendly multiplayer guessing game. Everyone can see everyone else's character, but not their own.

## Run it

```bash
npm install
npm start          # http://localhost:3000  (set PORT to change)
npm test
```

To play on phones, open the server's address (e.g. `http://<your-computer-ip>:3000`) from devices on the same network, or deploy it to any Node host.

## How it works

- **Rooms:** a player creates a room and gets a 4-letter code. They can share it or send an invite link (`?room=CODE`). Rooms hold up to **10 players**. The host can remove players. If the host leaves, another player becomes host.
- **Start:** when everyone has joined (at least 2 players), the host starts the game. Each player is given a different secret character.
- **Turns:** players go one at a time in a random order. Each turn lasts **30 seconds**. On your turn you ask the others yes/no questions, then type a guess. You can also pass.
  - A correct guess means you're done, and your place (#1, #2, …) is recorded.
  - A wrong guess, a pass, or the timer running out moves play to the next player.
- **End:** the game ends when only one player is still guessing. The host can then send everyone back to the lobby for another round.
- **Reconnects:** each device keeps a player id in local storage. If you refresh or lose connection, you get your seat back. In the lobby, a player who stays offline for 30 seconds is removed. During a game, offline players are skipped when picking whose turn is next.

Guesses ignore case, punctuation and accents. Small typos are accepted, and so are common aliases ("Peter Parker" for Spider-Man). Characters are listed in `src/characters.js`.

## Structure

- `server.js`: Express static server and Socket.IO events
- `src/game.js`: room and game logic (no networking, unit tested). The server sends each player a version of the state with their own character removed, so it can't be found in the browser's dev tools.
- `public/`: the client, written in plain HTML/CSS/JS
