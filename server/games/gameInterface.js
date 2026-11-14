const REQUIRED_METHODS = [
  "createInitialState",
  "handleAction",
  "getPublicState",
  "getResult"
];

/**
 * @typedef {Object} GameDefinition
 * @property {string} id
 * @property {string} name
 * @property {number} minPlayers
 * @property {number} maxPlayers
 * @property {(players: Array<{id: string, nickname: string}>, options?: object) => unknown} createInitialState
 * @property {(state: unknown, playerId: string, action: unknown) => unknown} handleAction
 * @property {(state: unknown, playerId: string) => unknown} getPublicState
 * @property {(state: unknown) => ({type: string, winnerId?: string, loserId?: string}|null)} getResult
 * @property {((state: unknown) => (number|null))=} getPhaseDuration Optional server timer duration in milliseconds.
 * @property {((state: unknown) => unknown)=} handleTimeout Optional server-only timed phase transition.
 * @property {((state: unknown, playerId: string, text: string) => unknown)=} handleChatMessage Optional game-specific chat interception.
 * @property {((state: unknown, playerId: string, segments: unknown[]) => unknown)=} handleStrokeBatch Optional server-validated drawing input.
 * @property {((state: unknown, players: unknown[]) => boolean)=} canPlayAgain Optional game-specific replay eligibility.
 */

export function assertGameDefinition(game) {
  if (!game || typeof game.id !== "string" || !game.id || typeof game.name !== "string" || !game.name) {
    throw new TypeError("A game must define a non-empty id and name.");
  }
  if (!Number.isInteger(game.minPlayers) || !Number.isInteger(game.maxPlayers) || game.minPlayers < 1 || game.maxPlayers < game.minPlayers) {
    throw new TypeError(`Game ${game.id} must define valid minPlayers and maxPlayers values.`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof game[method] !== "function") throw new TypeError(`Game ${game.id} must implement ${method}().`);
  }
  const hasPhaseTimer = game.getPhaseDuration !== undefined || game.handleTimeout !== undefined;
  if (hasPhaseTimer && (typeof game.getPhaseDuration !== "function" || typeof game.handleTimeout !== "function")) {
    throw new TypeError(`Game ${game.id} must provide both getPhaseDuration() and handleTimeout() for timed phases.`);
  }
  if (game.handleChatMessage !== undefined && typeof game.handleChatMessage !== "function") throw new TypeError(`Game ${game.id} handleChatMessage must be a function.`);
  if (game.handleStrokeBatch !== undefined && typeof game.handleStrokeBatch !== "function") throw new TypeError(`Game ${game.id} handleStrokeBatch must be a function.`);
  if (game.canPlayAgain !== undefined && typeof game.canPlayAgain !== "function") throw new TypeError(`Game ${game.id} canPlayAgain must be a function.`);
  return game;
}
