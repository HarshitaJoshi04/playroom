import ticTacToe from "./ticTacToe.js";
import imposter from "./imposter.js";
import scribble from "./scribble.js";
import { assertGameDefinition } from "./gameInterface.js";

const registry = new Map();

export function registerGame(game) {
  const definition = assertGameDefinition(game);
  if (registry.has(definition.id)) throw new Error(`Game id already registered: ${definition.id}`);
  registry.set(definition.id, definition);
  return definition;
}

export function getGame(id) {
  return registry.get(id) || null;
}

export function listGames() {
  return [...registry.values()].map(({ id, name, minPlayers, maxPlayers }) => ({ id, name, minPlayers, maxPlayers }));
}

registerGame(ticTacToe);
registerGame(imposter);
registerGame(scribble);
