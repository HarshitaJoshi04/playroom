import { useEffect, useMemo, useRef, useState } from "react";

const COLORS = ["#33bce6", "#F4F1E8", "#A488FF", "#FF6B6B", "#FFB84D", "#43C9A9", "#5F9BFF", "#FF80B5"];

function segmentKey(segment) {
  return `${segment.strokeId}:${segment.x1}:${segment.y1}:${segment.x2}:${segment.y2}:${segment.size}:${segment.eraser}`;
}

function paintSegments(canvas, rect, segments) {
  if (!canvas || !rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  for (const segment of segments) {
    context.save();
    context.globalCompositeOperation = segment.eraser ? "destination-out" : "source-over";
    context.strokeStyle = segment.color;
    context.lineWidth = segment.size;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(segment.x1 * rect.width, segment.y1 * rect.height);
    context.lineTo(segment.x2 * rect.width, segment.y2 * rect.height);
    context.stroke();
    context.restore();
  }
}

function newStrokeId() {
  return globalThis.crypto?.randomUUID?.() || `stroke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function ScribbleCanvas({ strokes = [], isDrawer, phase, onAction, onStrokeBatch }) {
  const canvasRef = useRef(null);
  const pointerRef = useRef(null);
  const batchRef = useRef([]);
  const onStrokeBatchRef = useRef(onStrokeBatch);
  const [localSegments, setLocalSegments] = useState([]);
  const [color, setColor] = useState(COLORS[0]);
  const [brushSize, setBrushSize] = useState(6);
  const [eraser, setEraser] = useState(false);
  const [drawError, setDrawError] = useState("");
  const canDraw = isDrawer && phase === "drawing";

  useEffect(() => { onStrokeBatchRef.current = onStrokeBatch; }, [onStrokeBatch]);
  const mergedSegments = useMemo(() => {
    const serverKeys = new Set(strokes.map(segmentKey));
    return [...strokes, ...localSegments.filter((segment) => !serverKeys.has(segmentKey(segment)))];
  }, [strokes, localSegments]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const redraw = () => paintSegments(canvas, canvas.getBoundingClientRect(), mergedSegments);
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [mergedSegments]);

  function pointFor(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
  }

  function flushBatch() {
    if (!batchRef.current.length || !onStrokeBatchRef.current) return;
    const batch = batchRef.current;
    batchRef.current = [];
    onStrokeBatchRef.current(batch, (response) => {
      const keys = new Set(batch.map(segmentKey));
      if (response?.ok) setLocalSegments((current) => current.filter((segment) => !keys.has(segmentKey(segment))));
      else setDrawError(response?.error || "Drawing could not be synced. Check your connection.");
    });
  }

  useEffect(() => {
    if (!canDraw) return undefined;
    const interval = window.setInterval(flushBatch, 45);
    return () => { window.clearInterval(interval); flushBatch(); };
  }, [canDraw]);

  function addSegment(start, end, strokeId) {
    const segment = { strokeId, x1: start.x, y1: start.y, x2: end.x, y2: end.y, color, size: Number(brushSize), eraser };
    batchRef.current.push(segment);
    setLocalSegments((current) => [...current.slice(-180), segment]);
    if (batchRef.current.length >= 24) flushBatch();
  }

  function handlePointerDown(event) {
    if (!canDraw) return;
    event.preventDefault();
    const point = pointFor(event);
    const strokeId = newStrokeId();
    pointerRef.current = { ...point, strokeId };
    event.currentTarget.setPointerCapture(event.pointerId);
    addSegment(point, point, strokeId);
    setDrawError("");
  }

  function handlePointerMove(event) {
    if (!canDraw || !pointerRef.current) return;
    event.preventDefault();
    const next = pointFor(event);
    const previous = pointerRef.current;
    addSegment(previous, next, previous.strokeId);
    pointerRef.current = { ...next, strokeId: previous.strokeId };
  }

  function handlePointerUp(event) {
    if (!pointerRef.current) return;
    pointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    flushBatch();
  }

  return (
    <section className="scribble-canvas-panel" aria-label="Scribble drawing canvas">
      <div className="scribble-toolbar">
        <div className="scribble-tool-group" aria-label="Drawing tools">
          <button type="button" className={`scribble-tool-btn ${!eraser ? "active" : ""}`} onClick={() => setEraser(false)} disabled={!canDraw}>Pen</button>
          <button type="button" className={`scribble-tool-btn ${eraser ? "active" : ""}`} onClick={() => setEraser(true)} disabled={!canDraw}>Eraser</button>
          <button type="button" className="scribble-tool-btn" onClick={() => { onAction({ type: "canvas-undo" }); setDrawError(""); }} disabled={!canDraw || strokes.length === 0}>Undo</button>
          <button type="button" className="scribble-tool-btn clear" onClick={() => { onAction({ type: "canvas-clear" }); setLocalSegments([]); batchRef.current = []; }} disabled={!canDraw || (strokes.length === 0 && localSegments.length === 0)}>Clear</button>
        </div>
        <div className="scribble-tool-group scribble-palette" aria-label="Pen colors">
          {COLORS.map((swatch) => <button key={swatch} type="button" className={`scribble-color ${color === swatch ? "selected" : ""}`} style={{ "--swatch": swatch }} aria-label={`Choose ${swatch} color`} aria-pressed={color === swatch} disabled={!canDraw} onClick={() => { setColor(swatch); setEraser(false); }} />)}
        </div>
        <label className="scribble-size-control">Size <input type="range" min="2" max="24" value={brushSize} disabled={!canDraw} onChange={(event) => setBrushSize(event.target.value)} /><b>{brushSize}</b></label>
      </div>
      <div className={`scribble-canvas-wrap ${canDraw ? "is-drawable" : ""}`}>
        <canvas
          ref={canvasRef}
          className="scribble-canvas"
          aria-label={canDraw ? "Draw with your pointer or finger" : "Live drawing"}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
        {!canDraw && <span className="scribble-canvas-caption">{phase === "choosing" ? "Waiting for the drawer to pick a word…" : phase === "between" ? "Next turn coming up" : "Watch the live drawing"}</span>}
      </div>
      {drawError && <p className="scribble-error" role="alert">{drawError}</p>}
      <span className="scribble-canvas-footnote">Drawings stay in this room and clear between turns.</span>
    </section>
  );
}
