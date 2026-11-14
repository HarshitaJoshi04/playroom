import { useEffect, useRef, useState } from "react";
import { SERVER_URL, socket } from "../socket";
import useVoiceRecorder from "../hooks/useVoiceRecorder";

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

function VoiceNotePlayer({ src, label = "voice note", preview = false }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playError, setPlayError] = useState("");
  const progress = duration ? Math.min(100, (currentTime / duration) * 100) : 0;

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    setPlayError("");
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
    } catch {
      setPlayError("This voice note could not be played.");
    }
  }

  return (
    <div className={`voice-note-player ${preview ? "voice-note-preview" : ""}`}>
      <button
        type="button"
        className="voice-play-btn"
        onClick={togglePlayback}
        aria-label={`${playing ? "Pause" : "Play"} ${label}`}
        title={`${playing ? "Pause" : "Play"} ${label}`}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM15 5h3v14h-3z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8c0-.8.9-1.3 1.6-.9l11 6.6a1.7 1.7 0 0 1 0 2.9l-11 6.6c-.7.4-1.6-.1-1.6-.9z" /></svg>
        )}
      </button>
      <div className="voice-note-track">
        <div className="voice-waveform" aria-hidden="true">
          {Array.from({ length: 24 }, (_, index) => <i key={index} style={{ "--wave-height": `${20 + ((index * 17) % 55)}%` }} />)}
        </div>
        <div className="voice-progress"><i style={{ width: `${progress}%` }} /></div>
        <div className="voice-note-times"><time>{formatDuration(currentTime)}</time><time>{formatDuration(duration)}</time></div>
      </div>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentTime(0); }}
        onError={() => setPlayError("This voice note could not be loaded.")}
      />
      {playError && <span className="voice-play-error" role="status">{playError}</span>}
    </div>
  );
}

function resolveAudioUrl(url) {
  try { return new URL(url, SERVER_URL).href; } catch { return ""; }
}

export default function ChatBox({ messages, currentNickname, currentPlayerId, roomCode, onSend, error }) {
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const bottomRef = useRef(null);
  const recorder = useVoiceRecorder();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(event) {
    event.preventDefault();
    const cleanText = text.trim();
    if (!cleanText && !recorder.audioBlob) return;
    if (cleanText.length > 500) {
      setSendError("Messages can be up to 500 characters.");
      return;
    }

    setSendError("");
    setIsUploading(true);
    try {
      let audioUrl = "";
      if (recorder.audioBlob) {
        const formData = new FormData();
        const ext = recorder.audioBlob.type.includes("ogg") ? "ogg" : recorder.audioBlob.type.includes("mp4") ? "mp4" : "webm";
        formData.append("roomCode", roomCode);
        formData.append("socketId", socket.id);
        formData.append("audio", recorder.audioBlob, `voice-message.${ext}`);
        const response = await fetch(`${SERVER_URL}/api/upload`, { method: "POST", body: formData });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.url) throw new Error(result.error || "Audio upload failed. Please try again.");
        audioUrl = result.url;
      }

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("The server did not respond. Check your connection and try again.")), 12000);
        onSend({ text: cleanText, audioUrl }, (response) => {
          clearTimeout(timeout);
          if (response?.ok) resolve();
          else reject(new Error(response?.error || "Could not send your message. Try again."));
        });
      });

      setText("");
      recorder.deleteRecording();
    } catch (sendErrorResult) {
      setSendError(sendErrorResult.message || "Could not send your message. Try again.");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section className="chat-box" aria-label="Room chat">
      <div className="chat-heading"><h3>Party chat</h3><span>{messages.length} recent</span></div>
      <div className="chat-messages" aria-live="polite">
        {messages.length === 0 ? (
          <p className="chat-empty">No messages yet. Break the ice and say hello!</p>
        ) : messages.map((message) => {
          const mine = message.senderId ? message.senderId === currentPlayerId : message.nickname === currentNickname;
          return (
            <article className={`chat-message ${mine ? "mine" : "theirs"}`} key={message.id}>
              <div className="chat-meta"><strong>{mine ? "You" : message.nickname}</strong><time dateTime={message.timestamp}>{formatTime(message.timestamp)}</time></div>
              {message.text && <p>{message.text}</p>}
              {message.audioUrl && <VoiceNotePlayer src={resolveAudioUrl(message.audioUrl)} label={`voice note from ${message.nickname}`} />}
            </article>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {(recorder.isRecording || recorder.audioBlob) && (
        <div className={`recording-panel ${recorder.isRecording ? "active" : ""}`}>
          {recorder.isRecording ? (
            <>
              <span className="recording-dot" />
              <span className="recording-label">Recording</span>
              <time>{formatDuration(recorder.duration)} / 0:15</time>
              <button type="button" className="stop-recording-btn" onClick={recorder.stopRecording}>Stop</button>
            </>
          ) : (
            <>
              <span className="preview-label">Voice preview</span>
              <VoiceNotePlayer src={recorder.previewUrl} label="recording preview" preview />
              <div className="preview-actions">
                <button type="button" className="text-action" onClick={recorder.recordAgain}>Record again</button>
                <button type="button" className="text-action delete-action" onClick={recorder.deleteRecording}>Delete recording</button>
              </div>
            </>
          )}
        </div>
      )}

      {(sendError || recorder.error || error) && <p className="chat-error">{sendError || recorder.error || error}</p>}
      <form className="chat-form" onSubmit={sendMessage}>
        <button
          type="button"
          className={`mic-btn ${recorder.isRecording ? "recording" : ""}`}
          aria-label={recorder.isRecording ? "Recording in progress" : "Start voice recording"}
          title={recorder.isRecording ? "Recording in progress" : "Record a voice message"}
          onClick={recorder.startRecording}
          disabled={recorder.isRecording || Boolean(recorder.audioBlob) || isUploading || !socket.connected}
        >
          <span aria-hidden="true">🎙️</span>
        </button>
        <input aria-label="Chat message" type="text" maxLength={500} placeholder="Write a message..." value={text} onChange={(event) => { setText(event.target.value); setSendError(""); }} />
        <button type="submit" disabled={(!text.trim() && !recorder.audioBlob) || isUploading || !socket.connected}>
          {isUploading ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
