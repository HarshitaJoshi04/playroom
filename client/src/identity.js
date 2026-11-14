const IDENTITY_KEY = "voiceWordPartyIdentity";
const SESSION_KEY = "voiceWordPartySession";

function makeToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getPlayerIdentity() {
  try {
    const existing = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "null");
    if (existing && /^[a-zA-Z0-9_-]{16,80}$/.test(existing.playerId) && /^[a-f0-9]{64}$/.test(existing.reconnectToken)) return existing;
  } catch { /* Replace malformed local identity data. */ }
  const identity = {
    playerId: crypto.randomUUID().replaceAll("-", ""),
    reconnectToken: makeToken()
  };
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

export function readRoomSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || "null");
  } catch { return null; }
}

export function saveRoomSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearRoomSession() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}
