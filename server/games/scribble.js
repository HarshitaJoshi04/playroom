import { randomInt } from "node:crypto";
import { assertGameDefinition } from "./gameInterface.js";
import { SCRIBBLE_WORD_CATEGORIES } from "./scribbleWords.js";

const DRAW_SECONDS_OPTIONS = [60, 80, 90];
const CHOICE_SECONDS = 15;
const HINT_INTERVAL_MS = 20_000;
const BETWEEN_TURNS_MS = 7_000;
const WORDS_PER_TURN = 3;
const DRAWER_POINTS_PER_GUESS = 2;

const pick = (items) => items[randomInt(items.length)];

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function validateSettings(options = {}) {
  const rounds = options.rounds ?? 3;
  const drawSeconds = options.drawSeconds ?? 60;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error("Choose between 1 and 5 rounds.");
  if (!DRAW_SECONDS_OPTIONS.includes(drawSeconds)) throw new Error("Draw time must be 60, 80, or 90 seconds.");
  return { rounds, drawSeconds };
}

function makeChoices() {
  const pool = SCRIBBLE_WORD_CATEGORIES.flatMap(({ words }) => words);
  const choices = [];
  while (choices.length < WORDS_PER_TURN) {
    const word = pick(pool);
    if (!choices.includes(word)) choices.push(word);
  }
  return choices;
}

function startTurn(state, drawerId, turnIndex = state.turnIndex) {
  const wordChoices = makeChoices();
  const now = Date.now();
  return {
    ...state,
    phase: "choosing",
    phaseEndsAt: now + CHOICE_SECONDS * 1000,
    drawOrder: [...state.drawOrder],
    turnIndex,
    drawerId,
    wordChoices,
    autoWord: pick(wordChoices),
    word: null,
    drawStartedAt: null,
    guessedIds: [],
    hints: [],
    nextHintAt: null,
    strokes: [],
    turnSummary: null
  };
}

function createState(players, options = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 10) {
    throw new Error("Scribble needs 2 to 10 players.");
  }
  const settings = validateSettings(options);
  const startingPlayers = players.map(({ id, nickname }) => ({ id, nickname, score: 0, connected: true }));
  const drawOrder = shuffled(startingPlayers.map(({ id }) => id));
  return startTurn({
    players: startingPlayers,
    settings,
    round: 1,
    drawOrder,
    turnIndex: 0,
    completedTurns: 0,
    phase: "choosing",
    phaseEndsAt: null,
    drawerId: null,
    wordChoices: [],
    autoWord: null,
    word: null,
    drawStartedAt: null,
    guessedIds: [],
    hints: [],
    nextHintAt: null,
    strokes: [],
    turnSummary: null,
    status: "playing",
    result: null
  }, drawOrder[0], 0);
}

function connectedPlayers(state) {
  return state.players.filter((player) => player.connected);
}

function finishGame(state, resultType = "complete") {
  const leaderboard = [...state.players]
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname))
    .map(({ id, nickname, score, connected }) => ({ id, nickname, score, connected }));
  const highScore = leaderboard[0]?.score ?? 0;
  const winnerIds = leaderboard.filter((player) => player.score === highScore).map(({ id }) => id);
  return {
    ...state,
    phase: "finished",
    phaseEndsAt: null,
    status: "finished",
    strokes: [],
    result: { type: resultType, leaderboard, winnerIds, scoresAlreadyApplied: true }
  };
}

function finishTurn(state, { skipped = false } = {}) {
  const drawer = state.players.find((player) => player.id === state.drawerId);
  const guessers = state.players.filter((player) => state.guessedIds.includes(player.id));
  return {
    ...state,
    phase: "between",
    phaseEndsAt: Date.now() + BETWEEN_TURNS_MS,
    completedTurns: state.completedTurns + 1,
    strokes: [],
    nextHintAt: null,
    turnSummary: {
      drawerId: state.drawerId,
      drawerName: drawer?.nickname || "Drawer",
      word: state.word,
      guessed: guessers.map(({ id, nickname }) => ({ id, nickname, score: state.players.find((player) => player.id === id)?.lastGuessPoints || 0 })),
      skipped
    }
  };
}

function advanceTurn(state) {
  const activeIds = new Set(connectedPlayers(state).map(({ id }) => id));
  if (activeIds.size < 2) return finishGame(state, "not-enough-players");

  for (let index = state.turnIndex + 1; index < state.drawOrder.length; index += 1) {
    const playerId = state.drawOrder[index];
    if (activeIds.has(playerId)) return startTurn(state, playerId, index);
  }

  if (state.round >= state.settings.rounds) return finishGame(state);
  const drawOrder = shuffled([...activeIds]);
  return startTurn({ ...state, round: state.round + 1, drawOrder }, drawOrder[0], 0);
}

function beginDrawing(state, word) {
  const now = Date.now();
  return {
    ...state,
    phase: "drawing",
    phaseEndsAt: now + state.settings.drawSeconds * 1000,
    word,
    wordChoices: [],
    autoWord: null,
    drawStartedAt: now,
    guessedIds: [],
    hints: [],
    nextHintAt: now + HINT_INTERVAL_MS,
    strokes: [],
    turnSummary: null
  };
}

function revealHint(state) {
  const letterIndexes = [...state.word].map((character, index) => character === " " || state.hints.includes(index) ? null : index).filter((index) => index !== null);
  if (!letterIndexes.length) return { ...state, nextHintAt: state.phaseEndsAt };
  const hints = [...state.hints, pick(letterIndexes)];
  return { ...state, hints, nextHintAt: state.nextHintAt + HINT_INTERVAL_MS };
}

function normalizeGuess(text) {
  return text.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function isOneLetterOff(guess, word) {
  const compactGuess = guess.replace(/\s/g, "");
  const compactWord = word.replace(/\s/g, "");
  if (!compactGuess || Math.abs(compactGuess.length - compactWord.length) > 1) return false;
  let left = 0;
  let right = 0;
  let edits = 0;
  while (left < compactGuess.length && right < compactWord.length) {
    if (compactGuess[left] === compactWord[right]) { left += 1; right += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (compactGuess.length > compactWord.length) left += 1;
    else if (compactWord.length > compactGuess.length) right += 1;
    else { left += 1; right += 1; }
  }
  if (left < compactGuess.length || right < compactWord.length) edits += 1;
  return edits === 1;
}

function containsSecret(normalizedText, normalizedWord) {
  if (!normalizedText || !normalizedWord) return false;
  return ` ${normalizedText} `.includes(` ${normalizedWord} `);
}

const scribble = assertGameDefinition({
  id: "scribble",
  name: "Scribble",
  minPlayers: 2,
  maxPlayers: 10,

  createInitialState: createState,

  handleAction(state, playerId, action) {
    const player = state.players.find((entry) => entry.id === playerId);
    if (!player || !player.connected) throw new Error("You are not an active player in this game.");

    if (action?.type === "play-again") {
      if (state.status !== "finished") throw new Error("The current game is still in progress.");
      const remaining = state.players.filter((entry) => entry.connected).map(({ id, nickname }) => ({ id, nickname }));
      return createState(remaining, state.settings);
    }

    if (action?.type === "forfeit") {
      if (state.status !== "playing") return state;
      const players = state.players.map((entry) => entry.id === playerId ? { ...entry, connected: false } : entry);
      let next = { ...state, players };
      if (connectedPlayers(next).length < 2) return finishGame(next, "not-enough-players");
      if (state.drawerId === playerId && ["choosing", "drawing"].includes(state.phase)) {
        next = finishTurn({ ...next, word: state.word }, { skipped: true });
      } else if (state.phase === "drawing") {
        const remainingGuessers = connectedPlayers(next).filter((entry) => entry.id !== state.drawerId);
        if (remainingGuessers.every((entry) => next.guessedIds.includes(entry.id))) next = finishTurn(next);
      }
      return next;
    }

    if (state.status !== "playing") throw new Error("This Scribble game has finished.");

    if (action?.type === "choose-word") {
      if (state.phase !== "choosing" || playerId !== state.drawerId) throw new Error("Only the current drawer can choose a word now.");
      if (Date.now() >= state.phaseEndsAt) return beginDrawing(state, state.autoWord);
      if (typeof action.word !== "string" || !state.wordChoices.includes(action.word)) throw new Error("Choose one of the three words provided by the server.");
      return beginDrawing(state, action.word);
    }

    if (action?.type === "canvas-clear" || action?.type === "canvas-undo") {
      if (state.phase !== "drawing" || playerId !== state.drawerId) throw new Error("Only the current drawer can change the canvas.");
      if (action.type === "canvas-clear") return { ...state, strokes: [] };
      const lastStrokeId = state.strokes.at(-1)?.strokeId;
      return lastStrokeId ? { ...state, strokes: state.strokes.filter((stroke) => stroke.strokeId !== lastStrokeId) } : state;
    }

    throw new Error("That action is not available in this Scribble phase.");
  },

  getPhaseDuration(state) {
    if (state.phase === "drawing" && state.nextHintAt && state.nextHintAt < state.phaseEndsAt) return Math.max(0, state.nextHintAt - Date.now());
    return state.phaseEndsAt ? Math.max(0, state.phaseEndsAt - Date.now()) : null;
  },

  handleTimeout(state) {
    if (state.status !== "playing" || !state.phaseEndsAt || Date.now() < state.phaseEndsAt && !(state.phase === "drawing" && state.nextHintAt && Date.now() >= state.nextHintAt)) return state;
    if (state.phase === "choosing") return beginDrawing(state, state.autoWord);
    if (state.phase === "drawing") {
      if (state.nextHintAt && Date.now() >= state.nextHintAt && state.nextHintAt < state.phaseEndsAt) return revealHint(state);
      return finishTurn(state);
    }
    if (state.phase === "between") return advanceTurn(state);
    return state;
  },

  handleStrokeBatch(state, playerId, segments) {
    if (state.status !== "playing" || state.phase !== "drawing" || playerId !== state.drawerId) throw new Error("Only the current drawer can draw.");
    if (Date.now() >= state.phaseEndsAt) throw new Error("The drawing turn has ended.");
    if (!Array.isArray(segments) || !segments.length || segments.length > 48) throw new Error("Send between 1 and 48 stroke segments at a time.");
    if (state.strokes.length + segments.length > 5000) throw new Error("This turn has reached the drawing limit.");
    const allowedColors = new Set(["#33bce6", "#F4F1E8", "#A488FF", "#FF6B6B", "#FFB84D", "#43C9A9", "#5F9BFF", "#FF80B5"]);
    const cleanSegments = segments.map((segment) => {
      if (!segment || typeof segment !== "object" || typeof segment.strokeId !== "string" || segment.strokeId.length > 48) throw new Error("Invalid stroke data.");
      for (const coordinate of [segment.x1, segment.y1, segment.x2, segment.y2]) {
        if (typeof coordinate !== "number" || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) throw new Error("Stroke coordinates must be normalized between 0 and 1.");
      }
      if (!allowedColors.has(segment.color) || typeof segment.size !== "number" || !Number.isFinite(segment.size) || segment.size < 1 || segment.size > 32 || typeof segment.eraser !== "boolean") throw new Error("Invalid drawing tool settings.");
      return { strokeId: segment.strokeId, x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2, color: segment.color, size: segment.size, eraser: segment.eraser };
    });
    return { ...state, strokes: [...state.strokes, ...cleanSegments] };
  },

  handleChatMessage(state, playerId, text) {
    if (state.status !== "playing" || state.phase !== "drawing" || !state.word || !text.trim()) return null;
    if (Date.now() >= state.phaseEndsAt) return { state: finishTurn(state), suppress: false };
    const player = state.players.find((entry) => entry.id === playerId && entry.connected);
    if (!player) return null;
    const normalizedText = normalizeGuess(text);
    const normalizedWord = normalizeGuess(state.word);
    const mentionsWord = containsSecret(normalizedText, normalizedWord);
    const isDrawer = playerId === state.drawerId;
    const alreadyGuessed = state.guessedIds.includes(playerId);

    if (mentionsWord && isDrawer) {
      return { state, suppress: true, privateNotice: "You are drawing this turn, so you cannot guess the word." };
    }
    if (alreadyGuessed) {
      return { state, suppress: true, privateNotice: mentionsWord ? "You already guessed the word. Keep it secret until the turn ends." : "You already guessed. Wait for the next turn before sending another guess." };
    }
    if (isDrawer) return null;

    if (mentionsWord) {
      const guessOrder = state.guessedIds.length;
      const score = [10, 7, 5][guessOrder] || 3;
      const players = state.players.map((entry) => entry.id === playerId
        ? { ...entry, score: entry.score + score, lastGuessPoints: score }
        : entry.id === state.drawerId ? { ...entry, score: entry.score + DRAWER_POINTS_PER_GUESS } : entry);
      const next = { ...state, players, guessedIds: [...state.guessedIds, playerId] };
      const remainingGuessers = connectedPlayers(next).filter((entry) => entry.id !== next.drawerId);
      const completed = remainingGuessers.length > 0 && remainingGuessers.every((entry) => next.guessedIds.includes(entry.id));
      return {
        state: completed ? finishTurn(next) : next,
        suppress: true,
        announcement: `${player.nickname} guessed the word!`,
        scoreChanges: { [playerId]: score, [state.drawerId]: DRAWER_POINTS_PER_GUESS }
      };
    }

    if (normalizedText.split(" ").length === normalizedWord.split(" ").length && isOneLetterOff(normalizedText, normalizedWord)) {
      return { state, privateNotice: "Close!" };
    }
    return null;
  },

  canPlayAgain(state) {
    return state.status === "finished" && connectedPlayers(state).length >= 2;
  },

  getPublicState(state, playerId) {
    const drawer = playerId === state.drawerId;
    const activePlayer = state.players.find((player) => player.id === playerId && player.connected);
    const resultsVisible = ["between", "finished"].includes(state.phase);
    const mask = state.word ? [...state.word].map((character, index) => character === " " ? " " : state.hints.includes(index) ? character.toUpperCase() : "_") : [];
    const leaderboard = [...state.players].sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname)).map(({ id, nickname, score, connected }) => ({ id, nickname, score, connected }));
    return {
      phase: state.phase,
      status: state.status,
      phaseEndsAt: state.phaseEndsAt,
      round: state.round,
      rounds: state.settings.rounds,
      drawSeconds: state.settings.drawSeconds,
      turnNumber: state.completedTurns + 1,
      turnCount: state.players.length * state.settings.rounds,
      players: state.players.map(({ id, nickname, score, connected }) => ({ id, nickname, score, connected })),
      isParticipant: Boolean(activePlayer),
      isDrawer: drawer && Boolean(activePlayer),
      drawerId: state.drawerId,
      drawerName: state.players.find((player) => player.id === state.drawerId)?.nickname || null,
      choices: drawer && state.phase === "choosing" ? [...state.wordChoices] : [],
      word: drawer && ["choosing", "drawing"].includes(state.phase) ? state.word : resultsVisible ? state.word : null,
      wordMask: !drawer && state.phase === "drawing" ? mask : [],
      guessedIds: [...state.guessedIds],
      strokes: [...state.strokes],
      turnSummary: resultsVisible ? state.turnSummary : null,
      leaderboard: state.phase === "finished" ? leaderboard : [],
      resultType: state.result?.type || null,
      winnerIds: state.result?.winnerIds || []
    };
  },

  getResult(state) {
    return state.status === "finished" ? state.result : null;
  }
});

export default scribble;
