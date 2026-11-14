import { randomInt } from "node:crypto";
import { assertGameDefinition } from "./gameInterface.js";

const CATEGORIES = [
  { name: "Animals", words: ["Dolphin", "Giraffe", "Penguin", "Octopus", "Kangaroo", "Peacock"] },
  { name: "Food", words: ["Pancakes", "Sushi", "Watermelon", "Popcorn", "Tacos", "Cupcake"] },
  { name: "Places", words: ["Airport", "Library", "Aquarium", "Museum", "Beach", "Stadium"] },
  { name: "Objects", words: ["Umbrella", "Backpack", "Telescope", "Headphones", "Skateboard", "Lantern"] },
  { name: "Nature", words: ["Volcano", "Rainbow", "Glacier", "Desert", "Thunderstorm", "Waterfall"] },
  { name: "Movies", words: ["Jaws", "Frozen", "Avatar", "Coco", "Titanic", "Shrek"] }
];

const REVEAL_MS = 45_000;
const DISCUSSION_MS = 90_000;
const VOTING_MS = 30_000;

function pickRandom(items) {
  return items[randomInt(items.length)];
}

function startPhase(state, phase, duration) {
  return { ...state, phase, phaseEndsAt: Date.now() + duration };
}

function resolveVote(state) {
  const tally = Object.fromEntries(state.players.map((player) => [player.id, 0]));
  for (const targetId of Object.values(state.votes)) {
    if (Object.hasOwn(tally, targetId)) tally[targetId] += 1;
  }
  const highScore = Math.max(0, ...Object.values(tally));
  const leaders = Object.keys(tally).filter((playerId) => tally[playerId] === highScore && highScore > 0);
  const caughtImposter = leaders.length === 1 && leaders[0] === state.imposterId;
  const winnerIds = state.players
    .filter((player) => caughtImposter ? player.id !== state.imposterId : player.id === state.imposterId)
    .map((player) => player.id);

  return {
    ...state,
    phase: "result",
    phaseEndsAt: null,
    status: "finished",
    result: {
      type: leaders.length > 1 || leaders.length === 0 ? "tie" : caughtImposter ? "caught" : "escaped",
      winnerTeam: caughtImposter ? "crew" : "imposter",
      winnerIds,
      tally,
      scoreAwards: Object.fromEntries(state.players.map((player) => {
        if (caughtImposter) return [player.id, player.id !== state.imposterId && state.votes[player.id] === state.imposterId ? 2 : 0];
        return [player.id, player.id === state.imposterId ? 3 : 0];
      }))
    }
  };
}

function createState(players) {
  if (!Array.isArray(players) || players.length < 3 || players.length > 10) {
    throw new Error("Imposter needs 3 to 10 players.");
  }
  const category = pickRandom(CATEGORIES);
  return {
    players: players.map(({ id, nickname }) => ({ id, nickname })),
    category: category.name,
    secretWord: pickRandom(category.words),
    imposterId: pickRandom(players).id,
    phase: "reveal",
    phaseEndsAt: Date.now() + REVEAL_MS,
    status: "playing",
    readyIds: [],
    votes: {},
    result: null
  };
}

const imposter = assertGameDefinition({
  id: "imposter",
  name: "Imposter",
  minPlayers: 3,
  maxPlayers: 10,

  createInitialState: createState,

  handleAction(state, playerId, action) {
    const player = state.players.find((entry) => entry.id === playerId);
    if (!player) throw new Error("You are not a player in this game.");

    if (action?.type === "play-again") {
      if (state.status !== "finished") throw new Error("The current game is still in progress.");
      return createState(state.players);
    }

    if (action?.type === "forfeit") {
      if (state.status !== "playing") return state;
      const winnerTeam = playerId === state.imposterId ? "crew" : "imposter";
      const winnerIds = state.players.filter((entry) => winnerTeam === "crew" ? entry.id !== state.imposterId && entry.id !== playerId : entry.id === state.imposterId).map((entry) => entry.id);
      return {
        ...state,
        phase: "result",
        phaseEndsAt: null,
        status: "finished",
        result: {
          type: "forfeit", winnerTeam, winnerIds, departedPlayerId: playerId, tally: {},
          scoreAwards: Object.fromEntries(state.players.map((entry) => [entry.id, 0]))
        }
      };
    }

    if (state.status !== "playing") throw new Error("This game has already finished.");

    if (action?.type === "ready") {
      if (state.phase !== "reveal") throw new Error("The reveal phase is over.");
      if (state.readyIds.includes(playerId)) throw new Error("You have already confirmed your reveal.");
      const readyIds = [...state.readyIds, playerId];
      const next = { ...state, readyIds };
      return readyIds.length === state.players.length ? startPhase(next, "discussion", DISCUSSION_MS) : next;
    }

    if (action?.type === "vote") {
      if (state.phase !== "voting") throw new Error("Voting is not open.");
      if (state.votes[playerId]) throw new Error("You have already voted.");
      if (typeof action.targetId !== "string" || action.targetId === playerId || !state.players.some((entry) => entry.id === action.targetId)) {
        throw new Error("Choose another player in this game.");
      }
      const votes = { ...state.votes, [playerId]: action.targetId };
      const next = { ...state, votes };
      return Object.keys(votes).length === state.players.length ? resolveVote(next) : next;
    }

    throw new Error("That action is not available in this phase.");
  },

  getPhaseDuration(state) {
    return state.phaseEndsAt ? Math.max(0, state.phaseEndsAt - Date.now()) : null;
  },

  handleTimeout(state) {
    if (state.status !== "playing") return state;
    if (state.phase === "reveal") return startPhase(state, "discussion", DISCUSSION_MS);
    if (state.phase === "discussion") return startPhase({ ...state, votes: {} }, "voting", VOTING_MS);
    if (state.phase === "voting") return resolveVote(state);
    return state;
  },

  getPublicState(state, playerId) {
    const player = state.players.find((entry) => entry.id === playerId);
    const isImposter = player?.id === state.imposterId;
    const isRevealOrActive = state.phase !== "result";
    const result = state.result;

    return {
      phase: state.phase,
      status: state.status,
      phaseEndsAt: state.phaseEndsAt,
      players: state.players.map(({ id, nickname }) => ({ id, nickname })),
      isParticipant: Boolean(player),
      category: player || state.phase === "result" ? state.category : null,
      role: player && isRevealOrActive ? isImposter ? "imposter" : "crew" : null,
      secretWord: state.phase === "result" || player && !isImposter && isRevealOrActive ? state.secretWord : null,
      hasConfirmedReveal: state.readyIds.includes(playerId),
      readyCount: state.readyIds.length,
      votesCast: Object.keys(state.votes).length,
      hasVoted: Boolean(state.votes[playerId]),
      voteOptions: state.phase === "voting" && player ? state.players.filter((entry) => entry.id !== playerId).map(({ id, nickname }) => ({ id, nickname })) : [],
      imposterId: state.phase === "result" ? state.imposterId : null,
      resultType: result?.type || null,
      winnerTeam: result?.winnerTeam || null,
      winnerIds: result?.winnerIds || [],
      tally: result?.tally || null
    };
  },

  getResult(state) {
    if (state.status !== "finished" || !state.result) return null;
    return { ...state.result, scoreAwards: state.result.scoreAwards || {} };
  }
});

export default imposter;
