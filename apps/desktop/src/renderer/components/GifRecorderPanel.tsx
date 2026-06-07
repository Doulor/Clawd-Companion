import React, { useRef, useState } from "react";
import { useI18n } from "../useI18n";

export function GifRecorderPanel() {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);
  const [ready, setReady] = useState(false);
  const [gifData, setGifData] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    try {
      const canvas = document.querySelector("canvas") || document.querySelector(".pet-stage");
      if (!canvas) return;
      chunksRef.current = [];
      setRecording(true);
      setReady(false);
      setGifData(null);
      const stream = (canvas as HTMLElement).tagName === "CANVAS"
        ? (canvas as HTMLCanvasElement).captureStream(10)
        : await navigator.mediaDevices.getDisplayMedia({ video: true });
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        const reader = new FileReader();
        reader.onloadend = () => { setGifData(reader.result as string); setReady(true); };
        reader.readAsDataURL(blob);
        stream.getTracks().forEach(t => t.stop());
      };
      recorder.start();
      setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 5000);
    } catch (e) { console.warn("[GIF] Record failed:", e); setRecording(false); }
  };

  const saveGif = async () => {
    if (gifData) {
      await window.companion.saveGif(gifData);
    }
  };

  return (
    <div className="panel-group-card">
      <h3 className="panel-title">{t("gif.title", "Animation Recording")}</h3>
      <p className="note">{t("gif.hint", "Record desktop pet animation to WebM video (5 seconds).")}</p>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="ghost-btn" onClick={startRecording} disabled={recording}>
          {recording ? t("gif.recording", "Recording... (5s)") : t("gif.record", "Record Animation")}
        </button>
        {ready && <button className="ghost-btn" onClick={saveGif}>{t("gif.save", "Save as WebM")}</button>}
      </div>
    </div>
  );
}
