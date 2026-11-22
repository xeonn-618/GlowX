import { useCallback, useEffect, useRef, useState } from "react";
import { sendToUxp, onUxpMessage } from "./bridge";
import { renderGlowToCanvas, renderGlowOffscreen } from "./engine/glowRenderer";
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
        // If purpose is COMMIT, process full-resolution offscreen WebGL2 pass & commit
        if (msg.purpose === "COMMIT") {
          try {
            const fullResRendered = renderGlowOffscreen(
              msg.buffer,
              msg.width,
              msg.height
            );

            sendToUxp({
              type: "COMMIT_LAYER",
              name: "GlowX Effect",
              width: msg.width,
              height: msg.height,
              blendMode: "screen",
              opacity: 100,
              buffer: fullResRendered,
            });
          } catch (err) {
            console.error("[GlowX] Full-res shader render failed:", err);
            setErrorMsg((err as Error).message || "Failed to render full-resolution glow.");
            setStatus("error");
          }
          return;
        }

        // Otherwise it's a downsampled preview
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

  // ── Draw glow to canvas whenever layerPixels changes ────────────────────
  useEffect(() => {
    if (!layerPixels || !canvasRef.current) return;

    const { width, height, buffer } = layerPixels;
    renderGlowToCanvas(canvasRef.current, buffer, width, height);
  }, [layerPixels]);

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleRefresh = useCallback(() => {
    setStatus("loading");
    setErrorMsg("");
    // Request an aspect-correct preview (max 512px on the longest dimension)
    sendToUxp({
      type: "REQUEST_ACTIVE_LAYER",
      maxPreviewDim: 512,
      purpose: "PREVIEW",
    });
  }, []);

  const handleApply = useCallback(() => {
    setStatus("committing");
    setErrorMsg("");
    // Request full doc.width × doc.height resolution (maxPreviewDim: undefined)
    sendToUxp({
      type: "REQUEST_ACTIVE_LAYER",
      maxPreviewDim: undefined,
      purpose: "COMMIT",
    });
  }, []);

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
            <span className={styles.spinnerText}>Loading preview…</span>
          </div>
        )}

        {isCommitting && (
          <div className={styles.placeholder}>
            <span className={styles.spinnerText}>Rendering & Applying full-res…</span>
          </div>
        )}

        {status === "error" && (
          <div className={styles.errorBox}>
            <span className={styles.errorIcon}>⚠</span>
            <p className={styles.errorText}>{errorMsg}</p>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ display: hasLayer && !isBusy ? "block" : "none" }}
          aria-label="Active layer glow preview"
        />
      </div>

      {/* Layer info strip */}
      {hasLayer && layerPixels && (
        <div className={styles.infoStrip}>
          <span className={styles.infoLabel}>PREVIEW</span>
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
          aria-label="Refresh active layer preview"
        >
          {isLoading ? "Loading…" : "Refresh Layer"}
        </button>
        <button
          className={styles.btnPrimary}
          onClick={handleApply}
          disabled={isBusy || !hasLayer}
          aria-label="Apply full-resolution glow to layer"
        >
          {isCommitting ? "Applying…" : "Apply to Layer"}
        </button>
      </footer>
    </div>
  );
}
