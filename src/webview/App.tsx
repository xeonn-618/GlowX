import { useCallback, useEffect, useRef, useState } from "react";
import { sendToUxp, onUxpMessage } from "./bridge";
import styles from "./App.module.css";

// ── Types ────────────────────────────────────────────────────────────────────

interface LayerPixels {
  width: number;
  height: number;
  channels: number;
  buffer: Uint8Array;
}

type Status = "idle" | "loading" | "ready" | "committing" | "error";

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [layerPixels, setLayerPixels] = useState<LayerPixels | null>(null);

  // ── UXP message listener ────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onUxpMessage((msg) => {
      if (msg.type === "LAYER_PIXELS") {
        setLayerPixels({
          width: msg.width,
          height: msg.height,
          channels: msg.channels,
          buffer: msg.buffer,
        });
        setStatus("ready");
      } else if (msg.type === "COMMIT_DONE") {
        setStatus("ready");
      } else if (msg.type === "ERROR") {
        setErrorMsg(msg.message);
        setStatus("error");
      }
    });
    return unsubscribe;
  }, []);

  // ── Draw pixels to canvas whenever layerPixels changes ─────────────────
  useEffect(() => {
    if (!layerPixels || !canvasRef.current) return;

    const { width, height, buffer } = layerPixels;
    const canvas = canvasRef.current;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rgba = new Uint8ClampedArray(
      buffer.buffer as ArrayBuffer,
      buffer.byteOffset,
      buffer.byteLength
    );
    const imageData = new ImageData(rgba, width, height);
    ctx.putImageData(imageData, 0, 0);
  }, [layerPixels]);

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleRefresh = useCallback(() => {
    setStatus("loading");
    setErrorMsg("");
    // Request a downsampled preview (max 512px on the longest side)
    sendToUxp({ type: "REQUEST_ACTIVE_LAYER", maxPreviewDim: 512 });
  }, []);

  const handleApply = useCallback(() => {
    if (!layerPixels) return;
    setStatus("committing");
    sendToUxp({
      type: "COMMIT_LAYER",
      name: "GlowX Effect",
      width: layerPixels.width,
      height: layerPixels.height,
      blendMode: "normal",
      opacity: 100,
      buffer: layerPixels.buffer,
    });
  }, [layerPixels]);

  // ── Render ───────────────────────────────────────────────────────────────
  const isLoading = status === "loading";
  const isCommitting = status === "committing";
  const isBusy = isLoading || isCommitting;
  const hasLayer = status === "ready" && layerPixels !== null;

  return (
    <div className={styles.panel}>
      {/* Header */}
      <header className={styles.header}>
        <span className={styles.logoMark}>⬡</span>
        <span className={styles.title}>GlowX</span>
      </header>

      {/* Canvas preview area */}
      <div className={styles.previewFrame}>
        {status === "idle" && (
          <div className={styles.placeholder}>
            <span className={styles.placeholderIcon}>⬡</span>
            <p className={styles.placeholderText}>
              Select a layer and click<br />
              <strong>Refresh Layer</strong> to preview
            </p>
          </div>
        )}

        {isLoading && (
          <div className={styles.placeholder}>
            <span className={styles.spinnerText}>Loading…</span>
          </div>
        )}

        {status === "error" && (
          <div className={styles.errorBox}>
            <span className={styles.errorIcon}>⚠</span>
            <p className={styles.errorText}>{errorMsg}</p>
          </div>
        )}

        {hasLayer && (
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            aria-label="Active layer preview"
          />
        )}

        {/* Keep canvas mounted but hidden when no layer yet to retain ref */}
        {!hasLayer && (
          <canvas ref={canvasRef} style={{ display: "none" }} />
        )}
      </div>

      {/* Layer info strip */}
      {hasLayer && layerPixels && (
        <div className={styles.infoStrip}>
          <span className={styles.infoLabel}>SIZE</span>
          <span className={styles.infoValue}>
            {layerPixels.width} × {layerPixels.height}
          </span>
          <span className={styles.infoLabel}>CH</span>
          <span className={styles.infoValue}>{layerPixels.channels}</span>
        </div>
      )}

      {/* Sticky bottom action bar */}
      <footer className={styles.actionBar}>
        <button
          className={styles.btnSecondary}
          onClick={handleRefresh}
          disabled={isBusy}
          aria-label="Refresh active layer"
        >
          {isLoading ? "Loading…" : "Refresh Layer"}
        </button>
        <button
          className={styles.btnPrimary}
          onClick={handleApply}
          disabled={isBusy || !hasLayer}
          aria-label="Apply effect to new layer"
        >
          {isCommitting ? "Applying…" : "Apply to Layer"}
        </button>
      </footer>
    </div>
  );
}
