
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { socket } from "../socket";
import ChatBox from "../components/ChatBox";
import ScribbleCanvas from "../components/ScribbleCanvas";
import { clearRoomSession, getPlayerIdentity, readRoomSession, saveRoomSession } from "../identity";

export default function Room() {
  const { code } = useParams();
  const navigate = useNavigate();

  const [players, setPlayers] = useState([]);
  const [hostId, setHostId] = useState("");
  const [currentPlayerId, setCurrentPlayerId] = useState("");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState([]);
  const [gameSelection, setGameSelection] = useState({ gameId: null, gameName: null, status: "unselected", games: [] });
  const [gameView, setGameView] = useState(null);
  const [gameError, setGameError] = useState("");
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [scribbleOptions, setScribbleOptions] = useState({ rounds: 3, drawSeconds: 60 });
  const [scribbleNotice, setScribbleNotice] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteNotice, setInviteNotice] = useState("");
  const [ticTacToePlayers, setTicTacToePlayers] = useState(["", ""]);
  const [ticTacToeBestOf, setTicTacToeBestOf] = useState(3);
  const [identity] = useState(() => getPlayerIdentity());
  const [nickname, setNickname] = useState(() => {
    try {
      const session = readRoomSession();
      return session?.code === code ? session.nickname || "" : "";
    } catch { return ""; }
  });

  useEffect(() => {
    function handleRoomUpdate(data) {
      setPlayers(data.players);
      setHostId(data.hostId);
      setCurrentPlayerId(data.currentPlayerId || identity.playerId);
    }

    function handleNewMessage(message) {
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].slice(-100));
    }

    function handleGameSelection(data) {
      setGameSelection(data);
      setGameError("");
    }

    function handleGameState(data) {
      setGameView(data);
      setGameError("");
    }

    function handleScribbleStroke(data) {
      if (!Array.isArray(data?.segments) || !data.segments.length) return;
      setGameView((current) => current?.gameId === "scribble" && current.state
        ? { ...current, state: { ...current.state, strokes: [...current.state.strokes, ...data.segments].slice(-5000) } }
        : current);
    }

    function handleScribbleNotice(data) {
      setScribbleNotice(data?.message || "");
      window.setTimeout(() => setScribbleNotice(""), 2800);
    }

    function handleRoomClosed(data) {
      clearRoomSession();
      navigate("/", { replace: true, state: { notice: data?.notice || "This room has been closed." } });
    }

    socket.on("room:update", handleRoomUpdate);
    socket.on("chat:new", handleNewMessage);
    socket.on("room:closed", handleRoomClosed);
    socket.on("game:selected", handleGameSelection);
    socket.on("game:state", handleGameState);
    socket.on("scribble:stroke", handleScribbleStroke);
    socket.on("scribble:notice", handleScribbleNotice);

    const session = readRoomSession();
    function loadRoom(res) {
      if (res?.ok) {
        setPlayers(res.players);
        setHostId(res.hostId);
        setCurrentPlayerId(res.currentPlayerId || identity.playerId);
        setMessages(Array.isArray(res.messages) ? res.messages : []);
        socket.emit("game:sync");
      } else if (session?.code === code && session.nickname) {
        socket.emit("room:join", { nickname: session.nickname, code, ...identity }, (joinRes) => {
          if (joinRes?.ok) {
            setNickname(session.nickname);
            setPlayers(joinRes.players || []);
            setHostId(joinRes.hostId || "");
            setCurrentPlayerId(joinRes.playerId || identity.playerId);
            setMessages(Array.isArray(joinRes.messages) ? joinRes.messages : []);
            saveRoomSession({ nickname: session.nickname, code: joinRes.code, ...identity });
            socket.emit("game:sync");
          } else if (/room (not found|no longer exists)/i.test(joinRes?.error || "")) {
            clearRoomSession();
            navigate("/", { replace: true, state: { notice: "This room has closed or is no longer available." } });
          } else setError(joinRes?.error || "Unable to rejoin this room.");
        });
      } else setError(res?.error || "Unable to load room.");
    }

    function handleSocketConnect() {
      socket.emit("room:get", loadRoom);
    }

    socket.on("connect", handleSocketConnect);
    if (socket.connected) handleSocketConnect();

    return () => {
      socket.off("room:update", handleRoomUpdate);
      socket.off("chat:new", handleNewMessage);
      socket.off("room:closed", handleRoomClosed);
      socket.off("game:selected", handleGameSelection);
      socket.off("game:state", handleGameState);
      socket.off("scribble:stroke", handleScribbleStroke);
      socket.off("scribble:notice", handleScribbleNotice);
      socket.off("connect", handleSocketConnect);
    };
  }, [code, navigate, identity]);

  useEffect(() => {
    const deadline = gameView?.state?.phaseEndsAt;
    if (!deadline) return undefined;
    const updateRemaining = () => setSecondsRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    const timer = window.setInterval(updateRemaining, 250);
    return () => window.clearInterval(timer);
  }, [gameView?.state?.phaseEndsAt]);

  function leaveRoom() {
    socket.emit("room:leave");
    clearRoomSession();
    navigate("/");
  }

  function selectGame(gameId) {
    setGameError("");
    socket.emit("game:select", { gameId }, (response) => {
      if (!response?.ok) setGameError(response?.error || "Could not select this game.");
    });
  }

  function startGame() {
    setGameError("");
    const options = gameSelection.gameId === "scribble" ? scribbleOptions
      : gameSelection.gameId === "tic-tac-toe" ? { playerIds: ticTacToePlayers, bestOf: ticTacToeBestOf }
        : {};
    socket.emit("game:start", { options }, (response) => {
      if (!response?.ok) setGameError(response?.error || "Could not start the game.");
    });
  }

  function sendGameAction(action) {
    setGameError("");
    socket.emit("game:action", { action }, (response) => {
      if (!response?.ok) setGameError(response?.error || "That move could not be made.");
    });
  }

  function sendStrokeBatch(segments, callback) {
    socket.emit("scribble:stroke", { segments }, callback);
  }

  function endGame() {
    if (!window.confirm("End the current game for everyone? The room and its chat will stay open.")) return;
    setGameError("");
    socket.emit("game:end", (response) => {
      if (!response?.ok) setGameError(response?.error || "Could not end the game.");
    });
  }

  async function copyInvitation(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      setInviteNotice(`${label} copied.`);
    } catch {
      setInviteNotice("Clipboard access is unavailable in this browser.");
    }
    window.setTimeout(() => setInviteNotice(""), 2200);
  }

  async function shareInvitation() {
    const frontendUrl = import.meta.env.VITE_FRONTEND_URL || window.location.origin;
    const url = `${frontendUrl.replace(/\/$/, "")}/?room=${encodeURIComponent(code)}`;
    if (!navigator.share) return copyInvitation(url, "Invitation link");
    try {
      await navigator.share({ title: "Join my VoiceWord Party room", text: `Join my room with code ${code}.`, url });
      setInviteNotice("Invitation shared.");
    } catch (shareError) {
      if (shareError?.name !== "AbortError") setInviteNotice("Could not share the invitation.");
    }
    window.setTimeout(() => setInviteNotice(""), 2200);
  }

  const isHost = hostId === currentPlayerId;
  const connectedCount = players.filter((player) => player.connected !== false).length;
  const currentGameState = gameView?.state;
  const board = currentGameState?.board || Array(9).fill(null);
  const winningPlayer = currentGameState?.players?.find((player) => player.id === (currentGameState.winnerId || currentGameState.lastMatch?.winnerId));
  const selectedGame = gameSelection.games.find((game) => game.id === gameSelection.gameId);
  const minimumPlayers = selectedGame?.minPlayers || 2;
  const isImposterGame = gameSelection.gameId === "imposter";
  const isScribbleGame = gameSelection.gameId === "scribble";
  const scribbleScoreById = new Map((currentGameState?.players || []).map((player) => [player.id, player.score]));
  const visibleScore = (player) => isScribbleGame ? scribbleScoreById.get(player?.id) ?? 0 : player?.score ?? 0;
  const matchPlayers = gameSelection.gameId === "tic-tac-toe" && currentGameState?.players?.length === 2
    ? currentGameState.players
    : ticTacToePlayers.map((id) => players.find((player) => player.id === id)).filter(Boolean);
  const scoreboardPlayers = matchPlayers.length === 2 ? matchPlayers : players.slice(0, 2);
  const visibleSecondsRemaining = currentGameState?.phaseEndsAt ? secondsRemaining : 0;
  const gameStatusText = currentGameState?.phase === "between"
    ? `${currentGameState.lastMatch?.type === "draw" ? "MATCH DRAW" : `${winningPlayer?.nickname || "PLAYER"} WINS THE MATCH`} · NEXT MATCH ${currentGameState.matchNumber + 1}`
    : currentGameState?.status === "playing"
    ? currentGameState.isYourTurn ? "YOUR TURN" : `${currentGameState.players.find((player) => player.mark === currentGameState.turnMark)?.nickname || "OPPONENT"}'S TURN`
    : currentGameState?.resultType === "draw"
      ? "IT'S A DRAW"
      : currentGameState?.resultType === "forfeit"
        ? `${winningPlayer?.nickname || "A PLAYER"} WINS BY FORFEIT`
        : currentGameState?.status === "finished"
          ? `${winningPlayer?.nickname || "PLAYER"} WINS`
          : gameSelection.status === "selected" ? "READY WHEN YOU ARE" : "SELECT A GAME TO BEGIN";

  return (
    <main className="room-page">
      <div className="room-app-shell">
        <header className="room-topbar">
          <div className="room-brand" aria-label="Playroom">
            <span className="room-brand-icon" aria-hidden="true">⌘</span>
            <span>PLAY<span>ROOM</span></span>
          </div>

          <div className="room-top-code">
            <span className="top-live"><i /> LIVE</span>
            <span className="top-code-label">ROOM CODE</span>
            <strong>{code}</strong>
            <button className="room-copy-btn" onClick={() => copyInvitation(code, "Room code")} aria-label="Copy room code" title="Copy room code">
              <span aria-hidden="true">▢</span>
            </button>
          </div>

          <div className="room-top-players" aria-label={`${players.length} players in room`}>
            {players.slice(0, 4).map((player, index) => (
              <span className={`top-player-avatar player-color-${index % 4} ${player.connected === false ? "is-disconnected" : ""}`} key={player.id} title={`${player.nickname}${player.connected === false ? " · reconnecting" : ""}`}>
                {player.nickname.charAt(0).toUpperCase()}
              </span>
            ))}
            {players.length > 4 && <span className="top-player-avatar player-more">+{players.length - 4}</span>}
          </div>

          <div className="room-top-actions">
            <button className="room-invite-btn" onClick={() => setInviteOpen((open) => !open)} aria-expanded={inviteOpen}>
              <span aria-hidden="true">♧</span> Invite friends
            </button>
            {isHost && (
              <button
                className="close-room-btn"
                onClick={() => socket.emit("room:close", (response) => {
                  if (!response?.ok) setError(response?.error || "Could not close the room.");
                })}
              >
                Close room
              </button>
            )}
            <button className="leave-btn room-leave-btn" onClick={leaveRoom} aria-label="Leave room" title="Leave room">↗</button>
          </div>
          {inviteOpen && (
            <div className="invite-panel" role="dialog" aria-label="Invite friends">
              <div><span className="room-eyebrow"><i /> INVITE TO ROOM</span><button type="button" className="invite-close" aria-label="Close invitations" onClick={() => setInviteOpen(false)}>×</button></div>
              <p>Send your friends the room code or a direct link.</p>
              <strong className="invite-room-code">{code}</strong>
              <button type="button" onClick={() => copyInvitation(code, "Room code")}>Copy room code</button>
              <button type="button" onClick={() => copyInvitation(`${(import.meta.env.VITE_FRONTEND_URL || window.location.origin).replace(/\/$/, "")}/?room=${encodeURIComponent(code)}`, "Invitation link")}>Copy invitation link</button>
              <button type="button" className="invite-share" onClick={shareInvitation}>Share invitation</button>
              {inviteNotice && <small role="status">{inviteNotice}</small>}
            </div>
          )}
        </header>

        <div className="room-workspace">
          <aside className="game-library" aria-label="Game library">
            <div className="library-heading">
              <span>GAME LIBRARY</span>
              <small>{gameSelection.games.length} ready</small>
            </div>
            <div className="library-list">
              {gameSelection.games.map((game) => (
                <button
                  className={`library-game ${gameSelection.gameId === game.id ? "is-selected" : ""}`}
                  key={game.id}
                  type="button"
                  disabled={!isHost || gameSelection.status === "playing"}
                  aria-pressed={gameSelection.gameId === game.id}
                  onClick={() => selectGame(game.id)}
                >
                  <span className={`game-icon ${game.id === "imposter" ? "game-icon-purple" : game.id === "scribble" ? "game-icon-amber" : "game-icon-lime"}`}>{game.id === "imposter" ? "?" : game.id === "scribble" ? "✎" : "XO"}</span>
                  <span className="library-game-copy"><strong>{game.name}</strong><small>{game.minPlayers === game.maxPlayers ? `${game.minPlayers} players` : `${game.minPlayers}–${game.maxPlayers} players`}</small></span>
                  {gameSelection.gameId === game.id && <i />}
                </button>
              ))}
              <div className="library-game game-unavailable">
                <span className="game-icon game-icon-purple">✦</span>
                <span className="library-game-copy"><strong>Brain Blitz</strong><small>Coming soon</small></span>
                <span className="game-chevron">⌁</span>
              </div>
              <div className="library-game game-unavailable">
                <span className="game-icon game-icon-amber">◉</span>
                <span className="library-game-copy"><strong>Quick Draw</strong><small>Coming soon</small></span>
                <span className="game-chevron">⌁</span>
              </div>
              <div className="library-game game-unavailable">
                <span className="game-icon game-icon-pink">WC</span>
                <span className="library-game-copy"><strong>Wild Cards</strong><small>Coming soon</small></span>
                <span className="game-chevron">⌁</span>
              </div>
            </div>
            <div className="library-note">
              <span aria-hidden="true">✦</span>
              <small>ROOM STATUS</small>
              <strong>{connectedCount < 2 ? "Waiting for a friend" : `${connectedCount} players in the room`}</strong>
              <div className="library-progress"><i style={{ width: `${Math.min(connectedCount / 10 * 100, 100)}%` }} /></div>
            </div>
            <div className="library-footnote">ROOM CODE <strong>{code}</strong></div>
          </aside>

          <section className="room-game-area">
            <div className="game-title-row">
              <div>
                <span className="room-eyebrow"><i /> {gameSelection.status === "playing" ? "NOW PLAYING" : gameSelection.status === "finished" ? "GAME FINISHED" : gameSelection.status === "ended" ? "GAME ENDED" : gameSelection.status === "selected" ? "GAME SELECTED" : "GAME LIBRARY"}</span>
                <h1>{gameSelection.gameName || "Choose a game"}</h1>
              </div>
              <div className="game-title-actions">
                <span className="watching-count">♧ {connectedCount} online · {players.length} seats</span>
                {isHost && gameSelection.gameId && gameSelection.status === "playing" && (
                  <button className="end-game-btn" type="button" onClick={endGame}>End game</button>
                )}
                {isHost && gameSelection.gameId && gameSelection.status === "selected" && (
                  <button className="start-game-btn" type="button" onClick={startGame} disabled={players.filter((player) => player.connected !== false).length < minimumPlayers || (gameSelection.gameId === "tic-tac-toe" && (ticTacToePlayers.some((id) => !id) || ticTacToePlayers[0] === ticTacToePlayers[1]))}>
                    Start game
                  </button>
                )}
                {currentGameState?.status === "finished" && currentGameState.isParticipant && gameView?.canPlayAgain && (
                  <button className="start-game-btn play-again-btn" type="button" onClick={() => sendGameAction({ type: "play-again" })}>
                    Play again
                  </button>
                )}
              </div>
            </div>

            {isHost && gameSelection.status !== "playing" && gameSelection.gameId === "tic-tac-toe" && !currentGameState && (
              <div className="ttt-series-setup">
                <span className="room-eyebrow"><i /> MATCH SETUP · 1 VS 1</span>
                <div className="ttt-setup-fields">
                  <label>Player 1<select value={ticTacToePlayers[0]} onChange={(event) => setTicTacToePlayers([event.target.value, ticTacToePlayers[1] === event.target.value ? "" : ticTacToePlayers[1]])}><option value="">Choose player</option>{players.filter((player) => player.connected !== false).map((player) => <option key={player.id} value={player.id}>{player.nickname}</option>)}</select></label>
                  <label>Player 2<select value={ticTacToePlayers[1]} onChange={(event) => setTicTacToePlayers([ticTacToePlayers[0] === event.target.value ? "" : ticTacToePlayers[0], event.target.value])}><option value="">Choose player</option>{players.filter((player) => player.connected !== false).map((player) => <option key={player.id} value={player.id} disabled={player.id === ticTacToePlayers[0]}>{player.nickname}</option>)}</select></label>
                  <label>Series<select value={ticTacToeBestOf} onChange={(event) => setTicTacToeBestOf(Number(event.target.value))}>{[1, 3, 5, 7].map((count) => <option key={count} value={count}>Best of {count}</option>)}</select></label>
                </div>
                <small>Other room players can watch the match.</small>
              </div>
            )}

            {gameSelection.gameId === "tic-tac-toe" && <div className="room-player-strip" aria-label={`Players in this room (${connectedCount} connected, ${players.length} reserved of 10)`}>
              <div className="score-competitor">
                <span className="score-avatar player-color-0">{scoreboardPlayers[0]?.nickname?.charAt(0).toUpperCase() || "?"}</span>
                <span className="score-player-copy"><strong>{scoreboardPlayers[0]?.nickname || "Waiting"}</strong>{scoreboardPlayers[0]?.id === hostId && <small>HOST</small>}{players.find((entry) => entry.id === scoreboardPlayers[0]?.id)?.connected === false && <small className="player-reconnecting">RECONNECTING</small>}</span>
                <b>{gameSelection.gameId === "tic-tac-toe" ? currentGameState?.matchWins?.[scoreboardPlayers[0]?.id] ?? 0 : visibleScore(scoreboardPlayers[0])}</b>
              </div>
              <div className="score-versus"><small>{gameSelection.gameId === "tic-tac-toe" ? `BEST OF ${currentGameState?.bestOf || ticTacToeBestOf}` : isScribbleGame ? "POINTS" : isImposterGame ? "PLAYERS" : "ROOM SCORE"}</small><strong>{gameSelection.gameId === "tic-tac-toe" && currentGameState ? `${currentGameState.draws} D` : "VS"}</strong></div>
              <div className="score-competitor score-competitor-right">
                <b>{gameSelection.gameId === "tic-tac-toe" ? currentGameState?.matchWins?.[scoreboardPlayers[1]?.id] ?? 0 : visibleScore(scoreboardPlayers[1])}</b>
                <span className="score-player-copy"><strong>{scoreboardPlayers[1]?.nickname || "Friend"}</strong>{scoreboardPlayers[1]?.id === hostId && <small>HOST</small>}{players.find((entry) => entry.id === scoreboardPlayers[1]?.id)?.connected === false && <small className="player-reconnecting">RECONNECTING</small>}</span>
                <span className="score-avatar player-color-1">{scoreboardPlayers[1]?.nickname?.charAt(0).toUpperCase() || "?"}</span>
              </div>
            </div>}

            <section className="room-leaderboard" aria-label="Room leaderboard"><span>ROOM LEADERBOARD</span>{[...players].sort((a, b) => (b.score || 0) - (a.score || 0) || a.nickname.localeCompare(b.nickname)).map((player, index) => <div key={player.id}><i>{index + 1}</i><strong>{player.nickname}</strong><b>{player.score || 0} pts</b></div>)}</section>

            {gameSelection.gameId === "tic-tac-toe" && players.length > 2 && (
              <div className="extra-players" aria-label="Additional players">
                {players.slice(2).map((player, index) => (
                  <div className="extra-player" key={player.id}>
                    <span className={`extra-player-avatar player-color-${(index + 2) % 4}`}>{player.nickname.charAt(0).toUpperCase()}</span>
                    <span>{player.nickname}</span>
                    {player.id === hostId && <small>HOST</small>}{player.connected === false && <small className="player-reconnecting">RECONNECTING</small>}
                  </div>
                ))}
              </div>
            )}

            {gameSelection.status === "ended" ? (
              <section className="imposter-stage" aria-live="polite"><div className="imposter-card game-ended-card"><span className="room-eyebrow"><i /> GAME ENDED</span><h2>The room is still open</h2><p>Room chat, voice messages, and scores are still here. Choose a game from the library to continue playing.</p>{isHost && <button type="button" className="start-game-btn" onClick={() => selectGame(null)}>Return to game library</button>}</div></section>
            ) : isScribbleGame ? (
              <section className="scribble-game-stage" aria-live="polite">
                {!currentGameState ? (
                  <div className="scribble-setup-card">
                    <span className="room-eyebrow"><i /> SCRIBBLE SETTINGS</span>
                    <h2>Set up the drawing match</h2>
                    <p>Everyone takes a turn drawing. Guess in the room chat before time runs out.</p>
                    {isHost ? (
                      <div className="scribble-settings">
                        <label>Rounds <select value={scribbleOptions.rounds} onChange={(event) => setScribbleOptions((current) => ({ ...current, rounds: Number(event.target.value) }))}>{[1, 2, 3, 4, 5].map((round) => <option key={round} value={round}>{round}</option>)}</select></label>
                        <label>Draw time <select value={scribbleOptions.drawSeconds} onChange={(event) => setScribbleOptions((current) => ({ ...current, drawSeconds: Number(event.target.value) }))}>{[60, 80, 90].map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label>
                        <small>Start when 2–10 players are ready.</small>
                      </div>
                    ) : <div className="scribble-settings-hint">The host will choose rounds and draw time.</div>}
                  </div>
                ) : currentGameState.phase === "choosing" ? (
                  <div className="scribble-phase-card">
                    <div className="scribble-turn-meta"><span>ROUND {currentGameState.round} / {currentGameState.rounds}</span><span>TURN {currentGameState.turnNumber} / {currentGameState.turnCount}</span></div>
                    {currentGameState.isDrawer ? (
                      <>
                        <span className="room-eyebrow"><i /> YOU ARE DRAWING</span>
                        <h2>Pick a word to draw</h2>
                        <p>Your choice is private. The other players only see blanks.</p>
                        <div className="scribble-word-choices">{currentGameState.choices.map((word) => <button type="button" key={word} onClick={() => sendGameAction({ type: "choose-word", word })}>{word}</button>)}</div>
                      </>
                    ) : (
                      <>
                        <span className="room-eyebrow"><i /> {currentGameState.drawerName} IS CHOOSING</span>
                        <h2>Get ready to guess</h2>
                        <p>The drawer has {visibleSecondsRemaining} seconds to pick a word. Your guesses go in room chat.</p>
                        <div className="scribble-waiting-dots"><i /><i /><i /></div>
                      </>
                    )}
                  </div>
                ) : currentGameState.phase === "drawing" ? (
                  <>
                    <div className="scribble-round-bar">
                      <div><span className="room-eyebrow"><i /> ROUND {currentGameState.round} / {currentGameState.rounds}</span><strong>{currentGameState.drawerName} is drawing</strong></div>
                      <div className="scribble-clock"><strong>{visibleSecondsRemaining}</strong><small>SECONDS</small></div>
                    </div>
                    <div className="scribble-word-display">
                      <small>{currentGameState.isDrawer ? "YOUR WORD" : "GUESS THE WORD"}</small>
                      <strong>{currentGameState.isDrawer ? currentGameState.word : currentGameState.wordMask.map((character) => character === " " ? "　" : character).join(" ")}</strong>
                      <span>{currentGameState.isDrawer ? "Draw clues without typing the answer." : `${currentGameState.guessedIds.length} / ${Math.max(0, currentGameState.players.filter((player) => player.connected && player.id !== currentGameState.drawerId).length)} guessed · type your guess in chat`}</span>
                    </div>
                    <div className="scribble-live-scores">{currentGameState.players.map((player) => <span key={player.id} className={player.id === currentGameState.drawerId ? "is-current-drawer" : ""}>{player.nickname}<b>{player.score}</b></span>)}</div>
                    <ScribbleCanvas
                      strokes={currentGameState.strokes}
                      isDrawer={currentGameState.isDrawer}
                      phase={currentGameState.phase}
                      onAction={sendGameAction}
                      onStrokeBatch={sendStrokeBatch}
                    />
                  </>
                ) : currentGameState.phase === "between" ? (
                  <div className="scribble-phase-card scribble-between-card">
                    <span className="room-eyebrow"><i /> TURN COMPLETE</span>
                    <h2>{currentGameState.turnSummary?.skipped ? "Drawer left — turn skipped" : "The word was…"}</h2>
                    {currentGameState.turnSummary?.word && <div className="scribble-revealed-word">{currentGameState.turnSummary.word}</div>}
                    <p>Drawn by {currentGameState.turnSummary?.drawerName || currentGameState.drawerName}. Next turn in {visibleSecondsRemaining}s.</p>
                    {currentGameState.turnSummary?.guessed?.length > 0 && <div className="scribble-turn-guesses">Guessed by {currentGameState.turnSummary.guessed.map((player, index) => <span key={player.id}>{index > 0 ? ", " : ""}<b>{player.nickname}</b> (+{player.score})</span>)}</div>}
                    <div className="scribble-turn-scores">{currentGameState.players.map((player) => <span key={player.id}><b>{player.nickname}</b><strong>{player.score}</strong></span>)}</div>
                  </div>
                ) : (
                  <div className="scribble-phase-card scribble-leaderboard-card">
                    <span className="room-eyebrow"><i /> MATCH COMPLETE</span>
                    <h2>Final leaderboard</h2>
                    <div className="scribble-leaderboard">{currentGameState.leaderboard.map((player, index) => <div className="scribble-leader-row" key={player.id}><span className="scribble-place">{index + 1}</span><strong>{player.nickname}{!player.connected && <small> LEFT</small>}</strong><b>{player.score} pts</b></div>)}</div>
                    <p>Winner{currentGameState.winnerIds.length === 1 ? "" : "s"}: {currentGameState.players.filter((player) => currentGameState.winnerIds.includes(player.id)).map((player) => player.nickname).join(", ")}</p>
                    {isHost && <button type="button" className="start-game-btn" onClick={() => selectGame(null)}>Return to game library</button>}
                  </div>
                )}
              </section>
            ) : isImposterGame ? (
              <section className={`imposter-stage imposter-${currentGameState?.phase || "waiting"}`} aria-live="polite">
                {!currentGameState ? (
                  <div className="imposter-card"><span className="room-eyebrow"><i /> IMPOSTER</span><h2>Gather 3–10 players</h2><p>Start the game when everyone is in the room.</p></div>
                ) : currentGameState.phase === "reveal" ? (
                  <div className="imposter-card imposter-reveal-card">
                    <span className="room-eyebrow"><i /> PRIVATE ROLE REVEAL</span>
                    <h2>{currentGameState.role === "imposter" ? "You are the Imposter" : "You are on the Crew"}</h2>
                    <p className="imposter-private-hint">{currentGameState.role === "imposter" ? "Blend in. You only know the category." : "Keep your word secret while you discuss."}</p>
                    <div className={`imposter-secret ${currentGameState.role === "imposter" ? "is-category" : ""}`}>
                      <small>{currentGameState.role === "imposter" ? "YOUR CATEGORY" : "YOUR SECRET WORD"}</small>
                      <strong>{currentGameState.role === "imposter" ? currentGameState.category : currentGameState.secretWord}</strong>
                    </div>
                    <p className="imposter-phase-note">{currentGameState.readyCount} / {currentGameState.players.length} players ready · discussion starts when everyone confirms or the reveal timer ends ({visibleSecondsRemaining}s).</p>
                    <button className="start-game-btn imposter-action-btn" type="button" disabled={currentGameState.hasConfirmedReveal} onClick={() => sendGameAction({ type: "ready" })}>
                      {currentGameState.hasConfirmedReveal ? "Waiting for the others…" : "I’ve seen my role"}
                    </button>
                  </div>
                ) : currentGameState.phase === "discussion" ? (
                  <div className="imposter-card imposter-discussion-card">
                    <span className="room-eyebrow"><i /> DISCUSSION PHASE</span>
                    <h2>Talk it out</h2>
                    <p>Use room chat and voice messages to figure out who doesn’t know the word. Keep the word subtle.</p>
                    <div className="imposter-countdown"><strong>{visibleSecondsRemaining}</strong><span>SECONDS LEFT</span></div>
                    <div className="imposter-phase-note">{currentGameState.players.length} players are in the round. Voting begins when time runs out.</div>
                  </div>
                ) : currentGameState.phase === "voting" ? (
                  <div className="imposter-card imposter-voting-card">
                    <span className="room-eyebrow"><i /> VOTING PHASE</span>
                    <h2>{currentGameState.hasVoted ? "Vote locked in" : "Who is the Imposter?"}</h2>
                    <p>{currentGameState.votesCast} / {currentGameState.players.length} votes submitted · {visibleSecondsRemaining}s remaining</p>
                    {!currentGameState.hasVoted && <div className="imposter-vote-list">{currentGameState.voteOptions.map((option) => (
                      <button className="imposter-vote-option" type="button" key={option.id} onClick={() => sendGameAction({ type: "vote", targetId: option.id })}>
                        <span className="extra-player-avatar">{option.nickname.charAt(0).toUpperCase()}</span><strong>{option.nickname}</strong><span>Vote</span>
                      </button>
                    ))}</div>}
                    {currentGameState.hasVoted && <div className="imposter-phase-note">Your vote is private. Waiting for the others…</div>}
                  </div>
                ) : (
                  <div className="imposter-card imposter-result-card">
                    <span className="room-eyebrow"><i /> ROUND RESULT</span>
                    <h2>{currentGameState.winnerTeam === "crew" ? "Crew wins!" : "Imposter wins!"}</h2>
                    <p>{currentGameState.resultType === "tie" ? "The vote was tied (or no one voted), so the Imposter escaped." : currentGameState.resultType === "forfeit" ? "A player left during the round." : currentGameState.resultType === "caught" ? "The crew correctly identified the Imposter." : "The crew voted for someone else."}</p>
                    <div className="imposter-result-reveal"><span>THE WORD</span><strong>{currentGameState.secretWord}</strong><span>THE IMPOSTER</span><strong>{currentGameState.players.find((player) => player.id === currentGameState.imposterId)?.nickname || "Unknown"}</strong></div>
                    {currentGameState.tally && <div className="imposter-tally">{currentGameState.players.map((player) => <span key={player.id}>{player.nickname}: <b>{currentGameState.tally[player.id] || 0}</b></span>)}</div>}
                    {isHost && <button type="button" className="start-game-btn" onClick={() => selectGame(null)}>Return to game library</button>}
                  </div>
                )}
              </section>
            ) : gameSelection.gameId === "tic-tac-toe" && currentGameState ? (
              <>
                <div className="board-turn-label"><i /> {gameStatusText} {currentGameState?.yourMark && <span>{currentGameState.yourMark}</span>}</div>
                {currentGameState.phase === "between" && <div className="ttt-match-intermission"><strong>Match {currentGameState.matchNumber} complete</strong><span>{currentGameState.matchWins[currentGameState.players[0].id]} – {currentGameState.matchWins[currentGameState.players[1].id]} · {currentGameState.draws} draws</span><button type="button" className="start-game-btn" onClick={() => sendGameAction({ type: "continue" })}>Continue to match {currentGameState.matchNumber + 1}</button></div>}
                {currentGameState.seriesComplete && <div className="ttt-series-result"><strong>{currentGameState.seriesWinnerId ? `${currentGameState.players.find((player) => player.id === currentGameState.seriesWinnerId)?.nickname} wins the series!` : "The series is a draw"}</strong><span>Match score {currentGameState.matchWins[currentGameState.players[0].id]} – {currentGameState.matchWins[currentGameState.players[1].id]} · {currentGameState.draws} draws · Best of {currentGameState.bestOf}</span>{isHost && <button type="button" className="start-game-btn" onClick={() => selectGame(null)}>Return to game library</button>}</div>}
                <div className="tic-room-board" aria-label="Live Tic Tac Toe board">
                  {board.map((mark, cell) => (
                    <button
                      className={`tic-room-cell ${mark === "X" ? "room-mark-x" : mark === "O" ? "room-mark-o" : ""}`}
                      key={cell}
                      type="button"
                      aria-label={`Cell ${cell + 1}${mark ? `, ${mark}` : ""}`}
                      disabled={currentGameState?.status !== "playing" || currentGameState.phase !== "playing" || !currentGameState.isYourTurn || Boolean(mark)}
                      onClick={() => sendGameAction({ type: "move", cell })}
                    >
                      {mark || ""}
                    </button>
                  ))}
                </div>
              </>
            ) : gameSelection.gameId === "tic-tac-toe" ? (
              <div className="imposter-card"><span className="room-eyebrow"><i /> MATCH SERIES · 1 VS 1</span><h2>Set up Tic Tac Toe</h2><p>The host chooses two players and a Best of 1, 3, 5, or 7 series. Other players can watch.</p></div>
            ) : (
              <div className="imposter-card"><span className="room-eyebrow"><i /> GAME LOBBY</span><h2>{players.length < minimumPlayers ? `Waiting for ${minimumPlayers - players.length} more player${minimumPlayers - players.length === 1 ? "" : "s"}` : "Ready to start"}</h2><p>{selectedGame ? `${selectedGame.name} supports ${selectedGame.minPlayers}–${selectedGame.maxPlayers} players.` : "Choose a game from the library to begin."}</p></div>
            )}

            {scribbleNotice && <p className="scribble-private-notice" role="status">{scribbleNotice}</p>}
            {gameError && <p className="error room-error" role="alert">{gameError}</p>}

            {connectedCount < 2 && <p className="waiting room-waiting">Share your room code and invite a friend!</p>}
            {connectedCount >= 2 && <p className="waiting room-waiting">Great! Your friends have joined.</p>}
            {error && <p className="error room-error">{error}</p>}
          </section>

          <aside className="room-chat-sidebar" aria-label="Room chat and voice messages">
            <ChatBox
              messages={messages}
              currentNickname={nickname}
              currentPlayerId={currentPlayerId}
              roomCode={code}
              error={error}
              onSend={(message, callback) => socket.emit("chat:send", message, callback)}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}
