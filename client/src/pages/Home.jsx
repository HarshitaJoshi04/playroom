
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { socket } from "../socket";
import { getPlayerIdentity, saveRoomSession } from "../identity";

export default function Home() {
  const navigate = useNavigate();
  const location = useLocation();

  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState(() => (new URLSearchParams(window.location.search).get("room") || "").toUpperCase());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const identity = getPlayerIdentity();

  function createRoom() {
    if (!nickname.trim()) {
      setError("Please enter your nickname.");
      return;
    }

    setLoading(true);
    setError("");

    socket.emit("room:create", { nickname, ...identity }, (res) => {
      setLoading(false);

      if (res.ok) {
        saveRoomSession({ nickname: nickname.trim(), code: res.code, ...identity });
        navigate(`/room/${res.code}`);
      } else {
        setError(res.error);
      }
    });
  }

  function joinRoom() {
    if (!nickname.trim()) {
      setError("Please enter your nickname.");
      return;
    }

    if (!roomCode.trim()) {
      setError("Please enter a room code.");
      return;
    }

    setLoading(true);
    setError("");

    socket.emit(
      "room:join",
      { nickname, code: roomCode, ...identity },
      (res) => {
        setLoading(false);

        if (res.ok) {
          saveRoomSession({ nickname: nickname.trim(), code: res.code, ...identity });
          navigate(`/room/${res.code}`);
        } else {
          setError(res.error);
        }
      }
    );
  }

  return (
    <main className="home-page">
      <div className="home-shell">
        <header className="home-nav">
          <a className="home-brand" href="/" aria-label="Playroom home">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false"><path d="M7.2 8.2h9.6a4 4 0 0 1 3.8 3l1 3.7a2 2 0 0 1-3.2 2l-2.1-1.6H7.7l-2.1 1.6a2 2 0 0 1-3.2-2l1-3.7a4 4 0 0 1 3.8-3Z" /><path d="M8 10.8v3.4M6.3 12.5h3.4M15.5 11.6h.1M17.7 13.4h.1" /></svg>
            </span>
            <span className="brand-word">PLAY<span>ROOM</span></span>
          </a>
          <a className="header-join" href="#join-room">Join a room</a>
        </header>

        <div className="home-layout">
          <section className="home-hero">
            <div className="live-badge"><span />ROOMS ARE LIVE RIGHT NOW</div>
            <h1 className="hero-title">YOUR CREW.<br />YOUR <span>GAME.</span></h1>
            <p className="hero-copy">Create a private room, invite your friends, and jump between games without leaving the party.</p>

            {location.state?.notice && <p className="room-notice" role="status">{location.state.notice}</p>}

            <div className="nickname-field">
              <label htmlFor="home-nickname">Your nickname</label>
              <input
                id="home-nickname"
                type="text"
                placeholder="Enter your nickname"
                value={nickname}
                maxLength={20}
                autoComplete="nickname"
                onChange={(e) => setNickname(e.target.value)}
              />
            </div>

            <div className="home-actions">
              <button
                onClick={createRoom}
                disabled={loading}
                className="primary-btn home-create-btn"
              >
                {loading ? "Please wait..." : <>Create a room <span aria-hidden="true">→</span></>}
              </button>
              <a className="code-link" href="#join-room">#&nbsp; I have a code</a>
            </div>

            <details className="join-disclosure" id="join-room" open={Boolean(new URLSearchParams(location.search).get("room"))}>
              <summary>Join a room with a code</summary>
              <div className="join-code-fields">
                <label htmlFor="home-room-code">Room code</label>
                <input
                  id="home-room-code"
                  type="text"
                  placeholder="Enter 5-character room code"
                  value={roomCode}
                  maxLength={5}
                  onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                />
                <button
                  onClick={joinRoom}
                  disabled={loading}
                  className="secondary-btn join-submit"
                >
                  Join Room
                </button>
              </div>
            </details>

            {error && <p className="error home-error" role="alert">{error}</p>}

            <div className="social-proof" aria-label="Community activity">
              <div className="proof-avatars" aria-hidden="true">
                <span>ZA</span><span>TH</span><span>MK</span><span>+8</span>
              </div>
              <div className="proof-copy"><strong>2,400+ games played</strong><span>Tonight and counting</span></div>
            </div>
          </section>

          <aside className="preview-wrap" aria-label="Decorative live room preview">
            <div className="instant-chip"><span aria-hidden="true">ϟ</span> Instant play</div>
            <div className="room-preview-card">
              <div className="preview-header">
                <span className="preview-live"><i />LIVE ROOM</span>
                <span className="preview-code">PR-84X2</span>
              </div>
              <div className="preview-content">
                <section className="preview-game">
                  <span className="micro-label">NOW PLAYING</span>
                  <h2>TIC TAC TOE</h2>
                  <div className="tic-board" aria-label="Decorative tic tac toe board">
                    <div className="tic-cell mark-x">X</div><div className="tic-cell" /><div className="tic-cell mark-o">O</div>
                    <div className="tic-cell" /><div className="tic-cell mark-x">X</div><div className="tic-cell" />
                    <div className="tic-cell mark-o">O</div><div className="tic-cell" /><div className="tic-cell mark-x">X</div>
                  </div>
                </section>
                <section className="preview-chat" aria-label="Decorative room chat preview">
                  <span className="micro-label">ROOM CHAT</span>
                  <div className="preview-chat-message">
                    <span className="chat-avatar avatar-zara">Z</span>
                    <div><strong>Zara</strong><p>Winner picks the next game.</p></div>
                  </div>
                  <div className="preview-chat-message">
                    <span className="chat-avatar avatar-theo">T</span>
                    <div><strong>Theo</strong><p>Deal. Get ready.</p></div>
                  </div>
                  <div className="typing-bubble" aria-label="Someone is typing"><i /><i /><i /></div>
                </section>
              </div>
            </div>
            <div className="friends-chip"><span aria-hidden="true">♧</span> 6 friends in</div>
          </aside>
        </div>

        <footer className="home-footer">NO DOWNLOADS <span>•</span> NO SIGN-UPS <span>•</span> JUST PLAY</footer>
      </div>
    </main>
  );
}
