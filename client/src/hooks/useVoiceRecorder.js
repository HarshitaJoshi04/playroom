import { useCallback, useEffect, useRef, useState } from "react";

const MAX_DURATION_SECONDS = 15;

function getSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
    .find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

export default function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const previewUrlRef = useRef("");

  const releaseMicrophone = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else releaseMicrophone();
    setIsRecording(false);
  }, [releaseMicrophone]);

  const startRecording = useCallback(async () => {
    setError("");
    setDuration(0);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording is not supported in this browser. Try a recent version of Chrome, Edge, or Firefox.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || chunksRef.current[0]?.type || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size) {
          const url = URL.createObjectURL(blob);
          previewUrlRef.current = url;
          setAudioBlob(blob);
          setPreviewUrl(url);
        }
        releaseMicrophone();
        recorderRef.current = null;
      };
      recorder.onerror = () => {
        setError("Recording stopped unexpectedly. Please try again.");
        releaseMicrophone();
        setIsRecording(false);
      };

      recorder.start(250);
      setIsRecording(true);
      timerRef.current = setInterval(() => {
        const seconds = Math.min(MAX_DURATION_SECONDS, Math.floor((Date.now() - startedAtRef.current) / 1000));
        setDuration(seconds);
        if (seconds >= MAX_DURATION_SECONDS) stopRecording();
      }, 200);
    } catch (recordingError) {
      releaseMicrophone();
      if (recordingError?.name === "NotAllowedError" || recordingError?.name === "SecurityError") {
        setError("Microphone permission was denied. Allow microphone access in your browser settings and try again.");
      } else if (recordingError?.name === "NotFoundError" || recordingError?.name === "DevicesNotFoundError") {
        setError("No microphone was found. Connect a microphone and try again.");
      } else {
        setError("Could not start recording. Check your microphone and try again.");
      }
    }
  }, [releaseMicrophone, stopRecording]);

  const deleteRecording = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = "";
    setPreviewUrl("");
    setAudioBlob(null);
    setDuration(0);
    setError("");
  }, []);

  const recordAgain = useCallback(() => {
    deleteRecording();
    startRecording();
  }, [deleteRecording, startRecording]);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseMicrophone();
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, [releaseMicrophone]);

  return { isRecording, duration, audioBlob, previewUrl, error, startRecording, stopRecording, deleteRecording, recordAgain, clearError: () => setError("") };
}
