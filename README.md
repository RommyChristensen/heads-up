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
- **Turns:** players go one at a time in a random order. There's no time limit. On your turn you ask the others yes/no questions, then type a guess or pass.
  - A correct guess means you're done, and your place (#1, #2, …) is recorded.
  - A wrong guess or a pass moves play to the next player. The host can also skip the current player's turn if they've gone quiet.
- **End:** the game ends when only one player is still guessing. The host can then send everyone back to the lobby for another round.
- **Reconnects:** each device keeps a player id in local storage. If you refresh or lose connection, you get your seat back. In the lobby, a player who stays offline for 30 seconds is removed. During a game, offline players are skipped when picking whose turn is next, and if a player goes offline during their own turn, they are skipped after 15 seconds.

Guesses ignore case, punctuation and accents. Small typos are accepted, and so are common aliases ("Peter Parker" for Spider-Man). Characters are grouped into themes in `src/characters.js`. In the lobby the host picks one or more themes (all are on by default), and during the game everyone can see which theme each character is from, including their own.

## Structure

- `server.js`: Express static server and Socket.IO events
- `src/game.js`: room and game logic (no networking, unit tested). The server sends each player a version of the state with their own character removed, so it can't be found in the browser's dev tools.
- `public/`: the client, written in plain HTML/CSS/JS

## Deploy to Render (free)

The repo includes a `render.yaml` Blueprint.

1. Sign in at [render.com](https://render.com) with GitHub.
2. Click **New → Blueprint** and pick this repository (allow Render's GitHub app to access it if asked).
3. Choose the branch that has the code, then click **Apply**. The first build takes about 2 minutes.
4. Open the URL Render gives you (e.g. `https://heads-up-xxxx.onrender.com`) and share it with your friends.

Every push to that branch redeploys automatically. On the free plan the service sleeps after 15 minutes without traffic, so the first visit after that takes about 30 seconds to load. A restart or redeploy ends any game in progress.
