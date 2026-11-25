# VoiceWord Party

VoiceWord Party is a browser based multiplayer party game. Create a room, invite friends with a short room code, chat, and play games together. Voice messages are available when the server is connected to Cloudinary.

## What you can do

- Create or join a room for up to 10 players.
- Chat with other players and send short voice messages.
- Play Tic Tac Toe, Imposter, or Scribble.
- Reconnect to a room briefly after losing your connection.
- Share a room code or invitation link with friends.

## How it works

The project has two parts:

- **Client (`client/`)** — React application built with Vite. It displays the home page, room, chat, and games.
- **Server (`server/`)** — Express and Socket.IO application. It manages rooms, player connections, chat, game rules, and voice message uploads.

Room and game data is stored in the server's memory. Rooms, messages, and scores are cleared if the server restarts.

## Requirements

- Node.js 20.19+ or 22.12+ (Vite 8 requirement)
- npm
- Cloudinary account for voice message uploads

## Run locally

Install and start the server in one terminal:

```bash
cd server
npm install
npm run dev
```

The server listens on `http://localhost:5000` by default. To use another port, set the `PORT` environment variable.

In a second terminal, install and start the client:

```bash
cd client
npm install
npm run dev
```

Open the local URL printed by Vite (usually `http://localhost:5173`). The client uses `http://localhost:5000` as its default server address.

## Configure voice messages

Voice recording happens in the browser. Sending and saving a recording also requires the backend and Cloudinary credentials.

1. Copy `server/.env.example` to `server/.env`.
2. Add your Cloudinary values:

   ```env
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_api_key
   CLOUDINARY_API_SECRET=your_api_secret
   ```

3. Restart the server.

Keep the Cloudinary API secret on the server. Do not add it to the client or commit it to source control. Voice recordings are limited to 15 seconds and 2 MB. Microphone access requires HTTPS in production (localhost is allowed for local development).

## Deploy

Deploy the `client/` and `server/` as separate services.

### Client settings

- Build command: `npm install && npm run build`
- Output directory: `dist`
- Set `VITE_SERVER_URL` to the public URL of the deployed server, for example `https://your-server.example.com`.
- Rebuild the client after changing `VITE_SERVER_URL`; Vite embeds it during the build.
- Keep `client/vercel.json` and `client/public/_redirects` so direct links and refreshes on `/room/ROOMCODE` load the single page app.

### Server settings

- Install command: `npm install`
- Start command: `npm start`
- Set `PORT` if your hosting service requires it.
- Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` to enable voice uploads.

Use HTTPS for both services. If the host is not Vercel or Netlify, configure its single page app fallback so unknown client paths (such as `/room/ABCDE`) serve `index.html`.

## Useful commands

Run from the relevant folder:

| Folder | Command | Purpose |
| --- | --- | --- |
| `client/` | `npm run dev` | Start the client development server |
| `client/` | `npm run build` | Build the production client |
| `client/` | `npm run preview` | Preview the production build locally |
| `client/` | `npm run lint` | Check client code with ESLint |
| `server/` | `npm run dev` | Start the server with automatic reload |
| `server/` | `npm start` | Start the server for production |

## Project layout

```text
client/
  src/pages/       Home and room pages
  src/components/  Chat, voice recorder, player list, game UI, drawing canvas
  src/hooks/       Voice recording hook
server/
  games/           Game registry and server-side game rules
  index.js         HTTP routes, Socket.IO events, rooms, uploads
```
