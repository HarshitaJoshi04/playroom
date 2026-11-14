
import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import multer from "multer";
import { Readable } from "node:stream";
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import { getGame, listGames } from "./games/registry.js";

const app = express();
app.use(cors());
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const cloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);
const pendingAudioUploads = new Map();
const PENDING_AUDIO_TTL_MS = 15 * 60 * 1000;
const RECONNECT_GRACE_MS = 60 * 1000;

function hashIdentityToken(token) {
  return createHash("sha256").update(token).digest();
}

function validIdentity(payload) {
  const playerId = typeof payload?.playerId === "string" ? payload.playerId : "";
  const reconnectToken = typeof payload?.reconnectToken === "string" ? payload.reconnectToken : "";
  return /^[a-zA-Z0-9_-]{16,80}$/.test(playerId) && /^[a-f0-9]{64}$/.test(reconnectToken)
    ? { playerId, reconnectToken }
    : null;
}

function tokenMatches(player, reconnectToken) {
  if (!player?.reconnectTokenHash || !reconnectToken) return false;
  return timingSafeEqual(player.reconnectTokenHash, hashIdentityToken(reconnectToken));
}

const acceptedAudioTypes = new Map([
  ["audio/webm", ".webm"],
  ["audio/ogg", ".ogg"],
  ["audio/mp4", ".mp4"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
  ["audio/x-wav", ".wav"]
]);

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const type = String(file.mimetype || "").split(";")[0].toLowerCase();
    if (!acceptedAudioTypes.has(type)) {
      const error = new Error("Unsupported audio format. Use WebM, Ogg, MP4, MP3, or WAV audio.");
      error.code = "INVALID_AUDIO_TYPE";
      return callback(error);
    }
    callback(null, true);
  }
});

function uploadAudioToCloudinary(buffer, mimeType, roomCode) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video",
        folder: "voicewordparty/voice-messages",
        public_id: randomUUID(),
        overwrite: false,
        format: acceptedAudioTypes.get(mimeType).slice(1),
        tags: `voicewordparty,voicewordparty-room-${roomCode}`
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result?.secure_url) return reject(new Error("Cloudinary did not return a secure audio URL."));
        resolve(result);
      }
    );

    Readable.from([buffer]).on("error", reject).pipe(uploadStream);
    uploadStream.on("error", reject);
  });
}

function isValidCloudinaryAudioUrl(value) {
  if (typeof value !== "string" || !process.env.CLOUDINARY_CLOUD_NAME) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || url.port || url.username || url.password || url.search || url.hash) return false;

    const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    if (segments[0] !== cloudName || segments[1] !== "video" || segments[2] !== "upload") return false;

    const folderIndex = segments.indexOf("voicewordparty", 3);
    if (folderIndex < 3 || segments[folderIndex + 1] !== "voice-messages" || folderIndex + 3 !== segments.length) return false;
    return /^[a-z0-9_-]+\.(webm|ogg|mp4|mp3|wav)$/i.test(segments[folderIndex + 2]);
  } catch {
    return false;
  }
}

app.post("/api/upload", (req, res) => {
  audioUpload.single("audio")(req, res, async (error) => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Audio must be 2 MB or smaller." : error.message || "Audio upload failed." });
    }
    if (!req.file) return res.status(400).json({ error: "Choose an audio recording to upload." });

    const roomCode = String(req.body?.roomCode || "").trim().toUpperCase();
    const socketId = String(req.body?.socketId || "");
    const room = rooms[roomCode];
    const connectedSocket = io.sockets.sockets.get(socketId);
    const player = room?.players.find((entry) => entry.id === connectedSocket?.data.playerId);
    if (!room || !connectedSocket || connectedSocket.data.roomCode !== roomCode || !player || player.socketId !== socketId || !player.connected) {
      return res.status(403).json({ error: "Join the room before uploading a voice message." });
    }

    if (!cloudinaryConfigured) {
      return res.status(503).json({ error: "Audio storage is not configured on the server." });
    }

    try {
      const mimeType = String(req.file.mimetype || "").split(";")[0].toLowerCase();
      const result = await uploadAudioToCloudinary(req.file.buffer, mimeType, roomCode);
      if (!isValidCloudinaryAudioUrl(result.secure_url)) {
        console.error("Cloudinary returned a URL that failed the configured delivery URL validation.");
        return res.status(502).json({ error: "Audio storage returned an invalid URL. Please try again." });
      }
      const currentSocket = io.sockets.sockets.get(socketId);
      if (!rooms[roomCode] || !currentSocket || currentSocket.data.roomCode !== roomCode) {
        await cloudinary.uploader.destroy(result.public_id, { resource_type: "video", invalidate: true })
          .catch((cleanupError) => console.error(`Failed to remove audio uploaded during room closure ${result.public_id}: ${cleanupError?.message || "unknown error"}`));
        return res.status(410).json({ error: "The room closed before the recording finished uploading." });
      }
      const pending = {
        publicId: result.public_id,
        roomCode,
        socketId,
        timer: null
      };
      pending.timer = setTimeout(() => {
        if (pendingAudioUploads.get(result.secure_url) !== pending) return;
        pendingAudioUploads.delete(result.secure_url);
        cloudinary.uploader.destroy(pending.publicId, { resource_type: "video", invalidate: true })
          .then((response) => {
            if (response.result !== "ok" && response.result !== "not found") {
              console.error(`Failed to remove unused voice upload ${pending.publicId}: ${response.result}`);
            }
          })
          .catch((cleanupError) => console.error(`Failed to remove unused voice upload ${pending.publicId}: ${cleanupError?.message || "unknown error"}`));
      }, PENDING_AUDIO_TTL_MS);
      pending.timer.unref?.();
      pendingAudioUploads.set(result.secure_url, pending);
      return res.status(201).json({ url: result.secure_url });
    } catch (uploadError) {
      console.error("Cloudinary audio upload failed:", uploadError?.message || "unknown error");
      return res.status(502).json({ error: "Could not store the audio right now. Please try again." });
    }
  });
});

// HTTP server
const server = http.createServer(app);

// Socket.io server
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store all active rooms
const rooms = {};
const closingRooms = new Set();

function publicPlayers(room) {
  return room.players.map(({ id, nickname, score, connected }) => ({ id, nickname, score, connected: connected !== false }));
}

function currentPlayer(socket, room = rooms[socket.data.roomCode]) {
  const player = room?.players.find((entry) => entry.id === socket.data.playerId);
  return player?.connected && player.socketId === socket.id ? player : null;
}

function chooseNextHost(room) {
  const nextHost = room.players
    .filter((player) => player.connected && player.socketId)
    .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0]
    || [...room.players].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0];
  room.host = nextHost?.id || null;
}

// Health check
app.get("/", (req, res) => {
  res.send("VoiceWord Party Server is running!");
});

// Generate a unique 5-character room code
function makeCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  do {
    code = "";
    for (let i = 0; i < 5; i++) {
      code += characters[
        Math.floor(Math.random() * characters.length)
      ];
    }
  } while (rooms[code] || closingRooms.has(code));

  return code;
}

function clientMessages(messages) {
  return messages.map(({ audioPublicId: _audioPublicId, ...message }) => message);
}

async function deleteRoomAudioAssets(publicIds, code) {
  const uniqueIds = [...new Set(publicIds.filter(Boolean))];
  for (let offset = 0; offset < uniqueIds.length; offset += 100) {
    const batch = uniqueIds.slice(offset, offset + 100);
    try {
      const result = await cloudinary.api.delete_resources(batch, {
        resource_type: "video",
        type: "upload",
        invalidate: true
      });
      const statuses = result?.deleted || {};
      const failedIds = batch.filter((id) => !["deleted", "not_found"].includes(statuses[id]));
      if (failedIds.length) {
        console.error(`Cloudinary cleanup failed for room ${code}; failed public IDs: ${failedIds.join(", ")}`);
      }
    } catch (error) {
      console.error(`Cloudinary cleanup failed for room ${code}; failed public IDs: ${batch.join(", ")}; ${error?.message || "unknown error"}`);
    }
  }
}

async function closeRoom(code, notice = "This room has been closed.") {
  if (closingRooms.has(code)) return false;
  const room = rooms[code];
  if (!room) return false;

  closingRooms.add(code);
  if (room.closingTimer) clearTimeout(room.closingTimer);

  const publicIds = room.messages.map((message) => message.audioPublicId).filter(Boolean);
  clearGameTimer(room.game);
  for (const player of room.players) {
    if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
    player.reconnectTimer = null;
  }
  for (const [url, pending] of pendingAudioUploads) {
    if (pending.roomCode === code) {
      clearTimeout(pending.timer);
      publicIds.push(pending.publicId);
      pendingAudioUploads.delete(url);
    }
  }

  io.to(code).emit("room:closed", { code, notice });
  for (const socketId of io.sockets.adapter.rooms.get(code) || []) {
    const member = io.sockets.sockets.get(socketId);
    if (member) {
      member.data.roomCode = null;
      member.data.playerId = null;
      member.leave(code);
    }
  }

  room.players.splice(0, room.players.length);
  room.messages.splice(0, room.messages.length);
  room.game = null;
  delete rooms[code];

  try {
    await deleteRoomAudioAssets(publicIds, code);
  } finally {
    closingRooms.delete(code);
  }
  return true;
}

// Send updated room information to everyone
function updateRoom(code) {
  const room = rooms[code];
  if (!room) return;

  io.to(code).emit("room:update", {
    players: publicPlayers(room),
    hostId: room.host
  });
}

function gameSelectionPayload(room) {
  const definition = room.game ? getGame(room.game.gameId) : null;
  return {
    gameId: room.game?.gameId || null,
    gameName: definition?.name || null,
    status: room.game?.status || "unselected",
    hostId: room.host,
    games: listGames()
  };
}

function sendGameSelection(room, target = room.code) {
  const payload = gameSelectionPayload(room);
  if (target) io.to(target).emit("game:selected", payload);
  return payload;
}

function sendGameStateToPlayer(room, player) {
  if (!player.connected || !player.socketId) return;
  const game = room.game;
  if (game?.status === "ended") {
    io.to(player.socketId).emit("game:state", { gameId: game.gameId, status: "ended", state: { ended: true }, canPlayAgain: false });
    return;
  }
  const definition = game ? getGame(game.gameId) : null;
  if (!definition) {
    io.to(player.socketId).emit("game:state", { gameId: null, status: "unselected", state: null, canPlayAgain: false });
    return;
  }

  io.to(player.socketId).emit("game:state", {
    gameId: game.gameId,
    status: game.status,
    state: game.state ? definition.getPublicState(game.state, player.id) : null,
    canPlayAgain: Boolean(game.state && game.status === "finished" && (definition.canPlayAgain
      ? definition.canPlayAgain(game.state, room.players)
      : game.playerIds?.every((id) => room.players.some((entry) => entry.id === id))))
  });
}

function broadcastGameState(room) {
  for (const player of room.players) sendGameStateToPlayer(room, player);
}

function clearGameTimer(activeGame) {
  if (activeGame?.timer) clearTimeout(activeGame.timer);
  if (activeGame) activeGame.timer = null;
}

function scheduleGameTimer(room) {
  const activeGame = room.game;
  const definition = activeGame ? getGame(activeGame.gameId) : null;
  clearGameTimer(activeGame);
  if (!definition?.getPhaseDuration || !definition?.handleTimeout || activeGame.status !== "playing") return;

  const duration = definition.getPhaseDuration(activeGame.state);
  if (!Number.isFinite(duration)) return;
  activeGame.timer = setTimeout(() => {
    if (rooms[room.code] !== room || room.game !== activeGame || activeGame.status !== "playing") return;
    try {
      activeGame.state = definition.handleTimeout(activeGame.state);
      activeGame.status = activeGame.state.status;
      if (activeGame.status === "finished") recordGameResult(room);
      sendGameSelection(room, room.code);
      if (activeGame.resultRecorded && activeGame.gameId !== "scribble") updateRoom(room.code);
      broadcastGameState(room);
      scheduleGameTimer(room);
    } catch (error) {
      console.error(`Could not advance game ${activeGame.gameId} in room ${room.code}: ${error.message}`);
    }
  }, Math.max(0, duration));
  activeGame.timer.unref?.();
}

function syncGameToSocket(socket, room) {
  socket.emit("game:selected", gameSelectionPayload(room));
  sendGameStateToPlayer(room, currentPlayer(socket, room) || { id: socket.data.playerId, socketId: socket.id, connected: true });
}

function recordGameResult(room) {
  const activeGame = room.game;
  const definition = activeGame ? getGame(activeGame.gameId) : null;
  const result = definition?.getResult(activeGame.state);
  if (!result || activeGame.resultRecorded) return false;

  activeGame.result = result;
  activeGame.status = "finished";
  activeGame.resultRecorded = true;
  clearGameTimer(activeGame);
  if (result.scoresAlreadyApplied) return true;
  if (!result.scoreAwards || typeof result.scoreAwards !== "object") return true;
  for (const [playerId, points] of Object.entries(result.scoreAwards)) {
    const player = room.players.find((entry) => entry.id === playerId);
    if (player && Number.isFinite(points) && points > 0) player.score = (player.score || 0) + points;
  }
  return true;
}

function forfeitGamePlayer(room, playerId) {
  const activeGame = room.game;
  if (!activeGame || activeGame.status !== "playing" || !activeGame.playerIds?.includes(playerId)) return false;
  const definition = getGame(activeGame.gameId);
  if (!definition) return false;

  try {
    activeGame.state = definition.handleAction(activeGame.state, playerId, { type: "forfeit" });
    recordGameResult(room);
    scheduleGameTimer(room);
    return true;
  } catch (error) {
    console.error(`Could not forfeit game ${activeGame.gameId} in room ${room.code}: ${error.message}`);
    return false;
  }
}

function permanentlyRemovePlayer(room, playerId, notice = "") {
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) return false;
  if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
  player.reconnectTimer = null;
  const gameEnded = forfeitGamePlayer(room, playerId);
  room.players = room.players.filter((entry) => entry.id !== playerId);
  if (room.host === playerId) chooseNextHost(room);
  if (room.players.length === 0) {
    void closeRoom(room.code, notice || "The last player left, so the room was closed.");
    return true;
  }
  updateRoom(room.code);
  if (gameEnded) {
    sendGameSelection(room, room.code);
    broadcastGameState(room);
  }
  return true;
}

// Explicit leave is permanent; a dropped socket keeps its room membership for the reconnect grace period.
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  if (!rooms[code]) {
    socket.data.roomCode = null;
    return;
  }

  const room = rooms[code];
  const player = currentPlayer(socket, room);
  socket.leave(code);
  socket.data.roomCode = null;
  socket.data.playerId = null;
  if (player) permanentlyRemovePlayer(room, player.id);
}

function disconnectPlayer(socket) {
  const code = socket.data.roomCode;
  const playerId = socket.data.playerId;
  const room = rooms[code];
  const player = room?.players.find((entry) => entry.id === playerId);
  if (!player || player.socketId !== socket.id) return;
  player.connected = false;
  player.socketId = null;
  player.reconnectTimer = setTimeout(() => {
    const activeRoom = rooms[code];
    const expiredPlayer = activeRoom?.players.find((entry) => entry.id === playerId);
    if (!activeRoom || expiredPlayer?.connected) return;
    permanentlyRemovePlayer(activeRoom, playerId, "The room expired after everyone disconnected.");
  }, RECONNECT_GRACE_MS);
  player.reconnectTimer.unref?.();
  socket.data.roomCode = null;
  socket.data.playerId = null;
  updateRoom(code);
}

function authenticateRoomPlayer(socket, room, payload, nickname) {
  const identity = validIdentity(payload);
  if (!identity) return { ok: false, error: "Player identity is missing. Return to the home screen and try again." };
  const existing = room.players.find((player) => player.id === identity.playerId);
  if (existing) {
    if (!tokenMatches(existing, identity.reconnectToken)) return { ok: false, error: "This player identity is already in use." };
    if (existing.connected && existing.socketId && existing.socketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(existing.socketId);
      if (previousSocket) {
        previousSocket.data.roomCode = null;
        previousSocket.data.playerId = null;
        previousSocket.leave(room.code);
      }
    }
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    existing.reconnectTimer = null;
    existing.connected = true;
    existing.socketId = socket.id;
    if (!room.players.some((player) => player.id === room.host)) chooseNextHost(room);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = existing.id;
    return { ok: true, player: existing, reconnected: true };
  }
  const globallyUsed = Object.values(rooms).some((entry) => entry.players.some((player) => player.id === identity.playerId));
  if (globallyUsed) return { ok: false, error: "That player identity belongs to a different room." };
  const player = {
    id: identity.playerId,
    nickname,
    score: 0,
    connected: true,
    socketId: socket.id,
    reconnectTokenHash: hashIdentityToken(identity.reconnectToken),
    joinedAt: Date.now(),
    reconnectTimer: null
  };
  room.players.push(player);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  return { ok: true, player, reconnected: false };
}

// Socket connections
io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);
  

  // GET CURRENT ROOM INFORMATION
  socket.on("room:get", (callback) => {
    if (typeof callback !== "function") return;

    const code = socket.data.roomCode;
    const room = rooms[code];

    if (!room) {
      return callback({
        ok: false,
        error: "Room not found. Please create or join again."
      });
    }

    callback({
      ok: true,
      players: publicPlayers(room),
      hostId: room.host,
      currentPlayerId: socket.data.playerId,
      messages: clientMessages(room.messages)
    });
  });

  // SEND A ROOM CHAT MESSAGE
  socket.on("chat:send", (payload = {}, callback) => {
    const respond = typeof callback === "function" ? callback : () => {};
    const code = socket.data.roomCode;
    const room = rooms[code];
    const player = room && currentPlayer(socket, room);

    if (!room || !player) {
      return respond({ ok: false, error: "Join a room before sending messages." });
    }

    const rawText = payload && typeof payload === "object" ? payload.text : "";
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (text.length > 500) {
      return respond({ ok: false, error: "Messages can be up to 500 characters." });
    }

    const rawAudioUrl = payload && typeof payload === "object" ? payload.audioUrl : "";
    const audioUrl = typeof rawAudioUrl === "string" ? rawAudioUrl : "";
    const validAudioUrl = isValidCloudinaryAudioUrl(audioUrl);
    const pendingUpload = audioUrl ? pendingAudioUploads.get(audioUrl) : null;
    if (audioUrl && (!validAudioUrl || !pendingUpload || pendingUpload.roomCode !== code || pendingUpload.socketId !== socket.id)) {
      return respond({ ok: false, error: "Invalid audio attachment." });
    }
    if (!text && !validAudioUrl) return respond({ ok: false, error: "Add text or a voice recording before sending." });

    let messageText = text;
    const activeGame = room.game;
    const gameDefinition = activeGame ? getGame(activeGame.gameId) : null;
    if (text && activeGame?.status === "playing" && gameDefinition?.handleChatMessage) {
      try {
        const outcome = gameDefinition.handleChatMessage(activeGame.state, player.id, text);
        if (outcome) {
          activeGame.state = outcome.state;
          activeGame.status = activeGame.state.status;
          for (const [playerId, points] of Object.entries(outcome.scoreChanges || {})) {
            const scoredPlayer = room.players.find((entry) => entry.id === playerId);
            if (scoredPlayer && Number.isFinite(points) && points > 0) scoredPlayer.score = (scoredPlayer.score || 0) + points;
          }
          if (outcome.scoreChanges) updateRoom(code);
          if (activeGame.status === "finished") recordGameResult(room);
          if (outcome.privateNotice) socket.emit("scribble:notice", { message: outcome.privateNotice });
          if (outcome.announcement) {
            const announcement = { id: randomUUID(), nickname: "Scribble", text: outcome.announcement, timestamp: new Date().toISOString(), system: true };
            room.messages.push(announcement);
            if (room.messages.length > 100) room.messages.splice(0, room.messages.length - 100);
            io.to(code).emit("chat:new", announcement);
          }
          sendGameSelection(room, code);
          broadcastGameState(room);
          scheduleGameTimer(room);
          if (outcome.suppress) {
            if (!audioUrl) return respond({ ok: true });
            messageText = "";
          }
        }
      } catch (error) {
        console.error(`Game chat validation failed in room ${code}: ${error.message}`);
        return respond({ ok: false, error: "Could not process that game guess." });
      }
    }

    if (pendingUpload) {
      clearTimeout(pendingUpload.timer);
      pendingAudioUploads.delete(audioUrl);
    }

    const message = {
      id: randomUUID(),
      senderId: player.id,
      nickname: player.nickname,
      text: messageText,
      timestamp: new Date().toISOString()
    };
    if (validAudioUrl) {
      message.audioUrl = audioUrl;
      message.audioPublicId = pendingUpload.publicId;
    }
    room.messages.push(message);
    if (room.messages.length > 100) room.messages.splice(0, room.messages.length - 100);

    const { audioPublicId: _audioPublicId, ...clientMessage } = message;
    io.to(code).emit("chat:new", clientMessage);
    respond({ ok: true });
  });

  // GAME-SPECIFIC STATE SYNC: each connected player receives their own public view.
  socket.on("game:sync", () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !currentPlayer(socket, room)) return;
    syncGameToSocket(socket, room);
  });

  socket.on("scribble:stroke", (payload = {}, callback) => {
    const respond = typeof callback === "function" ? callback : () => {};
    const code = socket.data.roomCode;
    const room = rooms[code];
    const activeGame = room?.game;
    const definition = activeGame ? getGame(activeGame.gameId) : null;
    const player = room && currentPlayer(socket, room);
    if (!player || activeGame?.status !== "playing" || !activeGame.state || activeGame?.gameId !== "scribble" || !definition?.handleStrokeBatch) {
      return respond({ ok: false, error: "There is no active Scribble drawing turn." });
    }
    try {
      const previousLength = activeGame.state.strokes.length;
      activeGame.state = definition.handleStrokeBatch(activeGame.state, player.id, payload.segments);
      const segments = activeGame.state.strokes.slice(previousLength);
      io.to(code).emit("scribble:stroke", { segments });
      return respond({ ok: true });
    } catch (error) {
      return respond({ ok: false, error: error.message || "Could not accept those drawing strokes." });
    }
  });

  // HOST SELECTS WHICH REGISTERED GAME THE ROOM WILL PLAY.
  socket.on("game:select", (payload = {}, callback) => {
    const respond = typeof callback === "function" ? callback : () => {};
    const code = socket.data.roomCode;
    const room = rooms[code];
    const player = room && currentPlayer(socket, room);
    if (!room || !player) {
      return respond({ ok: false, error: "Join a room before selecting a game." });
    }
    if (room.host !== player.id) return respond({ ok: false, error: "Only the host can select a game." });
    if (room.game?.status === "playing") return respond({ ok: false, error: "Finish the current game before selecting another." });

    const gameId = typeof payload?.gameId === "string" ? payload.gameId : "";
    if (payload?.gameId === null) {
      clearGameTimer(room.game);
      room.game = null;
      sendGameSelection(room, code);
      broadcastGameState(room);
      respond({ ok: true });
      return;
    }
    const definition = getGame(gameId);
    if (!definition) return respond({ ok: false, error: "That game is not available." });

    room.game = {
      gameId: definition.id,
      status: "selected",
      state: null,
      playerIds: [],
      result: null,
      resultRecorded: false
    };
    sendGameSelection(room, code);
    broadcastGameState(room);
    respond({ ok: true });
  });

  // HOST ENDS THE CURRENT GAME WITHOUT CLOSING OR CLEANING UP THE ROOM.
  socket.on("game:end", (callback) => {
    const respond = typeof callback === "function" ? callback : () => {};
    const room = rooms[socket.data.roomCode];
    const player = room && currentPlayer(socket, room);
    if (!room || !player) return respond({ ok: false, error: "Join a room before ending its game." });
    if (room.host !== player.id) return respond({ ok: false, error: "Only the host can end the game." });
    if (!room.game || room.game.status !== "playing") return respond({ ok: false, error: "There is no active game to end." });
    clearGameTimer(room.game);
    room.game.status = "ended";
    room.game.state = null;
    room.game.playerIds = [];
    room.game.result = null;
    room.game.resultRecorded = true;
    sendGameSelection(room, room.code);
    broadcastGameState(room);
    respond({ ok: true });
  });

  // HOST STARTS THE SELECTED GAME.
  socket.on("game:start", (payload, callback) => {
    const respond = typeof payload === "function" ? payload : typeof callback === "function" ? callback : () => {};
    const code = socket.data.roomCode;
    const room = rooms[code];
    const player = room && currentPlayer(socket, room);
    if (!room || !player) {
      return respond({ ok: false, error: "Join a room before starting a game." });
    }
    if (room.host !== player.id) return respond({ ok: false, error: "Only the host can start a game." });
    if (room.game?.status === "playing") return respond({ ok: false, error: "A game is already in progress." });

    const definition = getGame(room.game?.gameId);
    if (!definition) return respond({ ok: false, error: "Select an available game first." });
    if (room.players.filter((entry) => entry.connected).length < definition.minPlayers) {
      return respond({ ok: false, error: `${definition.name} needs at least ${definition.minPlayers} players.` });
    }

    let gamePlayers;
    if (definition.id === "tic-tac-toe") {
      const ids = payload?.options?.playerIds;
      if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) return respond({ ok: false, error: "Choose two different players for Tic Tac Toe." });
      gamePlayers = ids.map((id) => room.players.find((entry) => entry.id === id && entry.connected));
      if (gamePlayers.some((entry) => !entry)) return respond({ ok: false, error: "Both selected players must be in the room." });
    } else {
      gamePlayers = room.players.filter((entry) => entry.connected).slice(0, definition.maxPlayers);
    }
    if (gamePlayers.length < definition.minPlayers || gamePlayers.length > definition.maxPlayers) {
      return respond({ ok: false, error: `${definition.name} needs ${definition.minPlayers === definition.maxPlayers ? `exactly ${definition.minPlayers}` : `${definition.minPlayers}–${definition.maxPlayers}`} players.` });
    }
    try {
      room.game = {
        gameId: definition.id,
        status: "playing",
        state: definition.createInitialState(gamePlayers, payload?.options || {}),
        playerIds: gamePlayers.map((player) => player.id),
        result: null,
        resultRecorded: false
      };
    } catch (error) {
      return respond({ ok: false, error: error.message || "Could not start this game." });
    }

    scheduleGameTimer(room);
    sendGameSelection(room, code);
    broadcastGameState(room);
    respond({ ok: true });
  });

  // PLAYERS SEND GAME ACTIONS; THE REGISTERED GAME VALIDATES EACH ACTION.
  socket.on("game:action", (payload = {}, callback) => {
    const respond = typeof callback === "function" ? callback : () => {};
    const code = socket.data.roomCode;
    const room = rooms[code];
    const player = room && currentPlayer(socket, room);
    const activeGame = room?.game;
    const definition = activeGame ? getGame(activeGame.gameId) : null;
    if (!room || !player || !definition || !activeGame.state) {
      return respond({ ok: false, error: "There is no active game in this room." });
    }
    if (!activeGame.playerIds.includes(player.id)) {
      return respond({ ok: false, error: "You are watching this game and cannot make a move." });
    }

    const action = payload?.action;
    if (action?.type === "play-again") {
      if (activeGame.status !== "finished") return respond({ ok: false, error: "The current game is still in progress." });
      const mayPlayAgain = definition.canPlayAgain
        ? definition.canPlayAgain(activeGame.state, room.players)
        : activeGame.playerIds.every((id) => room.players.some((entry) => entry.id === id));
      if (!mayPlayAgain) return respond({ ok: false, error: "All players from the previous game must be in the room to play again." });
    } else {
      if (activeGame.status !== "playing") return respond({ ok: false, error: "This game has already finished." });
      if (!action || typeof action !== "object" || typeof action.type !== "string" || ["forfeit", "timeout"].includes(action.type)) {
        return respond({ ok: false, error: "Unsupported game action." });
      }
    }

    try {
      activeGame.state = definition.handleAction(activeGame.state, player.id, action);
      activeGame.status = activeGame.state.status;
      if (action?.type === "play-again") {
        activeGame.result = null;
        activeGame.resultRecorded = false;
        activeGame.playerIds = activeGame.state.players?.filter((entry) => entry.connected !== false).map((entry) => entry.id) || activeGame.playerIds;
      }
      if (activeGame.status === "finished") recordGameResult(room);
      sendGameSelection(room, code);
      if (activeGame.resultRecorded && activeGame.gameId !== "scribble") updateRoom(code);
      broadcastGameState(room);
      scheduleGameTimer(room);
      return respond({ ok: true });
    } catch (error) {
      return respond({ ok: false, error: error.message || "That game action could not be applied." });
    }
  });

  // LEAVE ROOM
  socket.on("room:leave", () => {
    leaveRoom(socket);
  });

  // HOST CLOSES THE ENTIRE ROOM
  socket.on("room:close", (payload, callback) => {
    const respond = typeof payload === "function" ? payload : typeof callback === "function" ? callback : () => {};
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return respond({ ok: false, error: "Room not found or already closed." });
    const player = currentPlayer(socket, room);
    if (!player || room.host !== player.id) return respond({ ok: false, error: "Only the host can close this room." });

    void closeRoom(code, "The host closed this room.");
    respond({ ok: true });
  });

  // CREATE ROOM
  socket.on("room:create", (payload = {}, callback) => {
    if (typeof callback !== "function") return;

    const name = String(payload.nickname || "").trim();

    if (!name || name.length > 20) {
      return callback({
        ok: false,
        error: "Enter a nickname (maximum 20 characters)."
      });
    }

    leaveRoom(socket);

    const identity = validIdentity(payload);
    if (!identity) return callback({ ok: false, error: "Player identity is missing. Reload the page and try again." });
    leaveRoom(socket);
    const code = makeCode();

    rooms[code] = {
      code,
      host: identity.playerId,
      players: [],
      messages: [],
      game: {
        gameId: "tic-tac-toe",
        status: "selected",
        state: null,
        playerIds: [],
        result: null,
        resultRecorded: false
      }
    };
    const joined = authenticateRoomPlayer(socket, rooms[code], payload, name);
    if (!joined.ok) { delete rooms[code]; return callback(joined); }
    callback({ ok: true, code, playerId: joined.player.id, reconnected: false });

    updateRoom(code);

    console.log(`${name} created room ${code}`);
  });

  // JOIN ROOM
  socket.on("room:join", (payload = {}, callback) => {
    if (typeof callback !== "function") return;

    const name = String(payload.nickname || "").trim();
    const roomCode = String(payload.code || "").trim().toUpperCase();

    if (!name || name.length > 20) {
      return callback({
        ok: false,
        error: "Enter a valid nickname."
      });
    }

    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(roomCode)) {
      return callback({
        ok: false,
        error: "Enter a valid 5-character room code."
      });
    }

    const room = rooms[roomCode];

    if (!room) {
      return callback({
        ok: false,
        error: "Room not found."
      });
    }

    const identity = validIdentity(payload);
    if (!identity) return callback({ ok: false, error: "Player identity is missing. Reload the page and try again." });
    const existingPlayer = room.players.find((player) => player.id === identity.playerId);
    if (existingPlayer && !tokenMatches(existingPlayer, identity.reconnectToken)) {
      return callback({ ok: false, error: "This player identity is already in use." });
    }
    if (!existingPlayer && room.players.length >= 10) {
      return callback({
        ok: false,
        error: "Room is full."
      });
    }

    if (socket.data.roomCode && socket.data.roomCode !== roomCode) leaveRoom(socket);
    const targetRoom = rooms[roomCode];

    if (!targetRoom) {
      return callback({
        ok: false,
        error: "Room no longer exists."
      });
    }

    const joined = authenticateRoomPlayer(socket, targetRoom, payload, name);
    if (!joined.ok) return callback(joined);

    callback({
      ok: true,
      code: roomCode,
      playerId: joined.player.id,
      reconnected: joined.reconnected,
      players: publicPlayers(targetRoom),
      hostId: targetRoom.host,
      messages: clientMessages(targetRoom.messages)
    });

    updateRoom(roomCode);

    console.log(`${name} joined room ${roomCode}`);
  });

  // PLAYER DISCONNECTS
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    disconnectPlayer(socket);
  });
});

// Start server
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`VoiceWord Party server running on port ${PORT}`);
});
