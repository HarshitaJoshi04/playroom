import { assertGameDefinition } from "./gameInterface.js";

const WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];
const MATCH_GAP_MS = 4000;

function findWinningMark(board) {
  for (const [a, b, c] of WINNING_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

function createSeries(players, bestOf = 3) {
  if (!Array.isArray(players) || players.length !== 2 || players[0].id === players[1].id) throw new Error("Tic Tac Toe needs exactly two different players.");
  if (![1, 3, 5, 7].includes(bestOf)) throw new Error("Choose Best of 1, 3, 5, or 7.");
  const seriesPlayers = players.map(({ id, nickname }) => ({ id, nickname }));
  return {
    players: seriesPlayers,
    bestOf,
    wins: Object.fromEntries(seriesPlayers.map(({ id }) => [id, 0])),
    draws: 0,
    matchNumber: 1,
    xStarterIndex: 0,
    board: Array(9).fill(null),
    turnMark: "X",
    phase: "playing",
    phaseEndsAt: null,
    status: "playing",
    lastMatch: null,
    result: null
  };
}

function beginNextMatch(state) {
  const xStarterIndex = state.xStarterIndex === 0 ? 1 : 0;
  return {
    ...state,
    xStarterIndex,
    matchNumber: state.matchNumber + 1,
    board: Array(9).fill(null),
    turnMark: "X",
    phase: "playing",
    phaseEndsAt: null,
    lastMatch: null
  };
}

function completeMatch(state, result) {
  const wins = { ...state.wins };
  let draws = state.draws;
  if (result.type === "win") wins[result.winnerId] += 1;
  else draws += 1;
  const majority = Math.floor(state.bestOf / 2) + 1;
  const seriesWinner = state.players.find((player) => wins[player.id] >= majority);
  const exhausted = state.matchNumber >= state.bestOf;
  const next = { ...state, wins, draws, phase: "between", phaseEndsAt: Date.now() + MATCH_GAP_MS, lastMatch: result };
  if (seriesWinner || exhausted) {
    const winnerId = seriesWinner?.id || (wins[state.players[0].id] > wins[state.players[1].id] ? state.players[0].id : wins[state.players[1].id] > wins[state.players[0].id] ? state.players[1].id : null);
    return { ...next, phase: "result", phaseEndsAt: null, status: "finished", result: { type: winnerId ? "series-win" : "series-draw", winnerId, winnerIds: winnerId ? [winnerId] : state.players.map(({ id }) => id), wins, draws } };
  }
  return next;
}

const ticTacToe = assertGameDefinition({
  id: "tic-tac-toe",
  name: "Tic Tac Toe",
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(players, options = {}) {
    return createSeries(players, options.bestOf ?? 3);
  },

  handleAction(state, playerId, action) {
    const player = state.players.find((entry) => entry.id === playerId);
    if (!player) throw new Error("You are not a player in this game.");

    if (action?.type === "play-again") {
      if (state.status !== "finished") throw new Error("The current series is still in progress.");
      return createSeries(state.players, state.bestOf);
    }
    if (action?.type === "continue") {
      if (state.phase !== "between" || state.status !== "playing") throw new Error("There is no match to continue.");
      return beginNextMatch(state);
    }
    if (action?.type === "forfeit") {
      if (state.status !== "playing") return state;
      const winner = state.players.find((entry) => entry.id !== playerId);
      return { ...state, phase: "result", phaseEndsAt: null, status: "finished", result: { type: "forfeit", winnerId: winner?.id || null, winnerIds: winner ? [winner.id] : [], loserId: playerId, wins: state.wins, draws: state.draws } };
    }

    if (action?.type !== "move") throw new Error("Unsupported Tic Tac Toe action.");
    if (state.status !== "playing" || state.phase !== "playing") throw new Error("This match is not accepting moves.");
    const mark = state.xStarterIndex === 0 ? playerId === state.players[0].id ? "X" : "O" : playerId === state.players[1].id ? "X" : "O";
    if (mark !== state.turnMark) throw new Error("Wait for your turn.");
    if (!Number.isInteger(action.cell) || action.cell < 0 || action.cell > 8) throw new Error("Choose a valid board cell.");
    if (state.board[action.cell] !== null) throw new Error("That cell is already taken.");
    const board = [...state.board];
    board[action.cell] = mark;
    const winningMark = findWinningMark(board);
    if (winningMark) {
      const winnerIndex = winningMark === "X" ? state.xStarterIndex : 1 - state.xStarterIndex;
      return completeMatch({ ...state, board }, { type: "win", winnerId: state.players[winnerIndex].id, winnerMark: winningMark });
    }
    if (board.every(Boolean)) return completeMatch({ ...state, board }, { type: "draw" });
    return { ...state, board, turnMark: mark === "X" ? "O" : "X" };
  },

  getPhaseDuration(state) {
    return state.phase === "between" && state.phaseEndsAt ? Math.max(0, state.phaseEndsAt - Date.now()) : null;
  },

  handleTimeout(state) {
    if (state.phase === "between" && state.status === "playing") return beginNextMatch(state);
    return state;
  },

  getPublicState(state, playerId) {
    const player = state.players.find((entry) => entry.id === playerId);
    const mark = player ? (state.players[state.xStarterIndex].id === playerId ? "X" : "O") : null;
    return {
      board: [...state.board],
      players: state.players.map(({ id, nickname }) => ({ id, nickname, mark: state.players[state.xStarterIndex].id === id ? "X" : "O", matchWins: state.wins[id] })),
      status: state.status,
      phase: state.phase,
      phaseEndsAt: state.phaseEndsAt,
      yourMark: mark,
      turnMark: state.turnMark,
      isYourTurn: state.status === "playing" && state.phase === "playing" && mark === state.turnMark,
      isParticipant: Boolean(player),
      winnerId: state.result?.winnerId || null,
      winnerMark: state.lastMatch?.winnerMark || null,
      resultType: state.lastMatch?.type || state.result?.type || null,
      lastMatch: state.lastMatch,
      bestOf: state.bestOf,
      matchNumber: state.matchNumber,
      matchWins: { ...state.wins },
      draws: state.draws,
      seriesWinnerId: state.result?.winnerId || null,
      seriesComplete: state.status === "finished"
    };
  },

  canPlayAgain(state, players) {
    return state.status === "finished" && state.players.every(({ id }) => players.some((entry) => entry.id === id && entry.connected !== false));
  },

  getResult(state) {
    if (state.status !== "finished" || !state.result) return null;
    const scoreAwards = Object.fromEntries(state.players.map(({ id }) => [id, state.result.winnerId ? (id === state.result.winnerId ? 3 : 0) : 1]));
    return { ...state.result, scoreAwards };
  }
});

export default ticTacToe;
