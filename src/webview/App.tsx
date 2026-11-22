import { useCallback, useEffect, useRef, useState } from "react";
import { sendToUxp, onUxpMessage } from "./bridge";
import {
  DualKawaseGlowEngine,
  renderGlowOffscreen,
  type GlowEngineOptions,
  DEFAULT_GLOW_OPTIONS,
} from "./engine/glowRenderer";
import { Slider } from "./components/Slider";
import { FalloffCurve } from "./components/FalloffCurve";
import { SplitHandle } from "./components/SplitHandle";
import { Crosshair } from "./components/Crosshair";
import styles from "./App.module.css";

// ── Presets ──────────────────────────────────────────────────────────────────

interface Preset {
  id: string;
  name: string;
  options: Partial<GlowEngineOptions>;
  isCustom?: boolean;
}

const PRESETS: Preset[] = [
  {
    id: "default",
    name: "Default Glow",
    options: {
      intensity: 1.5,
      radius: 16.0,
      threshold: 0.15,
      knee: 0.5,
      falloff: 1.0,
      aspectRatio: 1.0,
      angle: 0.0,
      chromaShift: 2.0,
      exposure: 0.0,
      saturation: 1.0,
      rolloff: 1.0,
      dither: 0.5,
      tint: "#f4f4f6",
      blendMode: "screen",
    },
  },
  {
    id: "deepAnamorphic",
    name: "Deep Anamorphic",
    options: {
      intensity: 3.0,
      radius: 30.0,
      threshold: 0.08,
      knee: 0.7,
      falloff: 0.6,
      aspectRatio: 3.2,
      angle: 0.0,
      chromaShift: 4.5,
      exposure: 0.2,
      saturation: 1.25,
      rolloff: 1.4,
      dither: 0.6,
      tint: "#7dd3fc",
      blendMode: "screen",
    },
  },
  {
    id: "subtleFilmic",
    name: "Subtle Filmic",
    options: {
      intensity: 0.85,
      radius: 10.0,
      threshold: 0.25,
      knee: 0.4,
      falloff: 1.6,
      aspectRatio: 1.0,
      angle: 0.0,
      chromaShift: 1.0,
      exposure: -0.2,
      saturation: 0.9,
      rolloff: 1.8,
      dither: 0.8,
      tint: "#f4f4f6",
      blendMode: "screen",
    },
  },
  {
    id: "sodiumVapor",
    name: "Sodium Vapor",
    options: {
      intensity: 2.4,
      radius: 22.0,
      threshold: 0.12,
      knee: 0.6,
      falloff: 0.9,
      aspectRatio: 1.15,
      angle: 0.0,
      chromaShift: 3.2,
      exposure: 0.1,
      saturation: 1.4,
      rolloff: 1.2,
      dither: 0.5,
      tint: "#f59e0b",
      blendMode: "linearDodge",
    },
  },
  {
    id: "cyberNeon",
    name: "Cyber Neon",
    options: {
      intensity: 3.2,
      radius: 20.0,
      threshold: 0.05,
      knee: 0.8,
      falloff: 0.8,
      aspectRatio: 2.2,
      angle: 15.0,
      chromaShift: 5.5,
      exposure: 0.3,
      saturation: 1.8,
      rolloff: 0.8,
      dither: 0.5,
      tint: "#ec4899",
      blendMode: "linearDodge",
    },
  },
  {
    id: "opticalIce",
    name: "Optical Ice",
    options: {
      intensity: 2.0,
      radius: 18.0,
      threshold: 0.1,
      knee: 0.5,
      falloff: 1.1,
      aspectRatio: 1.8,
      angle: -5.0,
      chromaShift: 3.0,
      exposure: 0.0,
      saturation: 1.3,
      rolloff: 1.1,
      dither: 0.6,
      tint: "#38bdf8",
      blendMode: "screen",
    },
  },
];

const QUICK_CHIPS = ["#f4f4f6", "#7dd3fc", "#f59e0b", "#ec4899", "#38bdf8"];

type Status = "idle" | "loading" | "ready" | "committing" | "error";

interface LayerPixels {
  width: number;
  height: number;
  channels: number;
  buffer: Uint8Array;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<DualKawaseGlowEngine | null>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [layerPixels, setLayerPixels] = useState<LayerPixels | null>(null);

  // Custom presets from localStorage
  const [customPresets, setCustomPresets] = useState<Preset[]>(() => {
    try {
      const saved = localStorage.getItem("glowx_custom_presets");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [isCreatingPreset, setIsCreatingPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");

  // Settings State
  const [options, setOptions] = useState<GlowEngineOptions>({
    ...DEFAULT_GLOW_OPTIONS,
  });
  const [selectedPreset, setSelectedPreset] = useState<string>("default");
  const [shaderAdaptive, setShaderAdaptive] = useState<boolean>(false);

  // Collapsible section state
  const [sectionsOpen, setSectionsOpen] = useState({
    core: true,
    optics: true,
    color: true,
  });

  const toggleSection = (key: "core" | "optics" | "color") => {
    setSectionsOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Sync Shader-Adaptive Mode to CSS Custom Property --accent-primary
  useEffect(() => {
    if (shaderAdaptive) {
      document.documentElement.style.setProperty(
        "--accent-primary",
        options.tint
      );
    } else {
      document.documentElement.style.setProperty("--accent-primary", "#f4f4f6");
    }
  }, [shaderAdaptive, options.tint]);

  // Keep live engine updated at 60fps when options change
  const triggerRender = useCallback(
    (newOptions: GlowEngineOptions) => {
      if (!engineRef.current || !canvasRef.current || !layerPixels) return;
      engineRef.current.executePipeline(newOptions);
    },
    [layerPixels]
  );

  const updateOption = useCallback(
    <K extends keyof GlowEngineOptions>(key: K, val: GlowEngineOptions[K]) => {
      setOptions((prev) => {
        const next = { ...prev, [key]: val };
        triggerRender(next);
        return next;
      });
    },
    [triggerRender]
  );

  // All Presets combined (Built-in + Custom)
  const allPresets = [...PRESETS, ...customPresets];
  const activePreset = allPresets.find((p) => p.id === selectedPreset);
  const activePresetName = activePreset ? activePreset.name : "Deep Glow";

  // ── UXP Host IPC Setup ─────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onUxpMessage((msg) => {
      if (msg.type === "LAYER_PIXELS") {
        if (msg.purpose === "COMMIT") {
          // Offscreen full-resolution GPU pass
          // For Screen or Linear Dodge additive blend modes, render isolated Effect Only
          // (glow RGB on solid black with alpha 1.0) so Photoshop does not double-expose.
          try {
            const fullResBuffer = renderGlowOffscreen(
              msg.buffer,
              msg.width,
              msg.height,
              options
            );

            sendToUxp({
              type: "COMMIT_LAYER",
              name: `GlowX - ${activePresetName}`,
              width: msg.width,
              height: msg.height,
              blendMode:
                options.blendMode === "linearDodge"
                  ? "linearDodge"
                  : "screen",
              opacity: 100,
              buffer: fullResBuffer,
            });
          } catch (err) {
            console.error("[GlowX] Full-res render failed:", err);
            setErrorMsg(
              (err as Error).message || "Failed to render full-resolution glow."
            );
            setStatus("error");
          }
          return;
        }

        // Downsampled preview pixels
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
  }, [options, activePresetName]);

  // ── Initialize or resize preview canvas and WebGL2 engine ─────────────────
  useEffect(() => {
    if (!layerPixels || !canvasRef.current) return;

    const canvas = canvasRef.current;
    canvas.width = layerPixels.width;
    canvas.height = layerPixels.height;

    if (!engineRef.current) {
      const gl = canvas.getContext("webgl2", {
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });

      if (!gl) {
        setErrorMsg("WebGL2 is not supported in this environment.");
        setStatus("error");
        return;
      }

      engineRef.current = new DualKawaseGlowEngine(gl);
    }

    engineRef.current.setInputPixels(
      layerPixels.buffer,
      layerPixels.width,
      layerPixels.height
    );
    engineRef.current.executePipeline(options);
  }, [layerPixels]); // Only reallocates texture when layerPixels changes

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleRefresh = useCallback(() => {
    setStatus("loading");
    setErrorMsg("");
    sendToUxp({
      type: "REQUEST_ACTIVE_LAYER",
      maxPreviewDim: 512,
      purpose: "PREVIEW",
    });
  }, []);

  const handleApply = useCallback(() => {
    setStatus("committing");
    setErrorMsg("");
    sendToUxp({
      type: "REQUEST_ACTIVE_LAYER",
      maxPreviewDim: undefined,
      purpose: "COMMIT",
    });
  }, []);

  const handlePresetSelect = (presetId: string) => {
    setSelectedPreset(presetId);
    const found = allPresets.find((p) => p.id === presetId);
    if (found) {
      const newOpts: GlowEngineOptions = {
        ...options,
        ...found.options,
      };
      setOptions(newOpts);
      triggerRender(newOpts);
    }
  };

  const handleReset = () => {
    const defaultPreset = PRESETS[0];
    setSelectedPreset("default");
    const newOpts: GlowEngineOptions = {
      ...DEFAULT_GLOW_OPTIONS,
      ...defaultPreset.options,
    };
    setOptions(newOpts);
    triggerRender(newOpts);
  };

  const handleSavePreset = () => {
    const trimmed = newPresetName.trim();
    if (!trimmed) return;
    const newPreset: Preset = {
      id: `custom_${Date.now()}`,
      name: trimmed,
      options: { ...options },
      isCustom: true,
    };
    const next = [...customPresets, newPreset];
    setCustomPresets(next);
    try {
      localStorage.setItem("glowx_custom_presets", JSON.stringify(next));
    } catch {}
    setSelectedPreset(newPreset.id);
    setIsCreatingPreset(false);
    setNewPresetName("");
  };

  const handleDeleteCustomPreset = (id: string) => {
    const next = customPresets.filter((p) => p.id !== id);
    setCustomPresets(next);
    try {
      localStorage.setItem("glowx_custom_presets", JSON.stringify(next));
    } catch {}
    setSelectedPreset("default");
    handlePresetSelect("default");
  };

  const isLoading = status === "loading";
  const isCommitting = status === "committing";
  const isBusy = isLoading || isCommitting;
  const hasLayer = status === "ready" && layerPixels !== null;

  return (
    <div className={styles.panel}>
      {/* ── 1. Sticky Header Bar ────────────────────────────────────────── */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.opticalMark}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle
                cx="7"
                cy="7"
                r="5.5"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <circle cx="7" cy="7" r="2" fill="currentColor" />
            </svg>
          </div>
          <div className={styles.titleGroup}>
            <span className={styles.title}>GlowX</span>
            <div
              className={`${styles.statusDot} ${
                status === "ready"
                  ? styles.statusReady
                  : status === "loading" || status === "committing"
                  ? styles.statusBusy
                  : status === "error"
                  ? styles.statusError
                  : styles.statusIdle
              }`}
              title={`Status: ${status}`}
            />
          </div>
        </div>

        <div className={styles.headerRight}>
          <select
            className={styles.presetSelect}
            value={selectedPreset}
            onChange={(e) => handlePresetSelect(e.target.value)}
            disabled={isBusy}
            title="Optical Glow Presets"
          >
            <optgroup label="Built-in Presets">
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {customPresets.length > 0 && (
              <optgroup label="Custom User Presets">
                {customPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          {/* Add Custom Preset Button */}
          <button
            className={styles.btnAddPreset}
            onClick={() => setIsCreatingPreset((prev) => !prev)}
            disabled={isBusy}
            title="Save current parameters as custom preset"
            aria-label="Save custom preset"
          >
            +
          </button>

          {/* Delete Custom Preset Button if currently selected */}
          {activePreset?.isCustom && (
            <button
              className={styles.btnDeletePreset}
              onClick={() => handleDeleteCustomPreset(activePreset.id)}
              disabled={isBusy}
              title="Delete this custom preset"
              aria-label="Delete custom preset"
            >
              ✕
            </button>
          )}

          <button
            className={styles.btnReset}
            onClick={handleReset}
            disabled={isBusy}
            title="Reset all settings to default"
            aria-label="Reset parameters"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M1.5 6C1.5 3.51472 3.51472 1.5 6 1.5C8.03227 1.5 9.74233 2.85077 10.2882 4.7"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <path
                d="M10.5 6C10.5 8.48528 8.48528 10.5 6 10.5C3.96773 10.5 2.25767 9.14923 1.7118 7.3"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <polyline
                points="10.5,2.5 10.5,5 8,5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points="1.5,9.5 1.5,7 4,7"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Save Preset Inline Tray ────────────────────────────────────── */}
      {isCreatingPreset && (
        <div className={styles.savePresetBar}>
          <span className={styles.savePresetLabel}>NEW PRESET:</span>
          <input
            type="text"
            className={styles.savePresetInput}
            placeholder="Preset Name..."
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSavePreset();
              if (e.key === "Escape") setIsCreatingPreset(false);
            }}
          />
          <button className={styles.savePresetBtn} onClick={handleSavePreset}>
            SAVE
          </button>
          <button
            className={styles.cancelPresetBtn}
            onClick={() => setIsCreatingPreset(false)}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── 2. Live Preview Viewport ────────────────────────────────────── */}
      <section className={styles.viewportSection}>
        <div ref={viewportRef} className={styles.previewFrame}>
          {/* Floating Top-Left Segmented View Toggle */}
          <div className={styles.floatingTopLeft}>
            <button
              className={`${styles.modeToggleBtn} ${
                options.viewMode === "composite" ? styles.modeToggleActive : ""
              }`}
              onClick={() => updateOption("viewMode", "composite")}
              title="Show composite (original + deep glow)"
            >
              Composite
            </button>
            <button
              className={`${styles.modeToggleBtn} ${
                options.viewMode === "effectOnly" ? styles.modeToggleActive : ""
              }`}
              onClick={() => updateOption("viewMode", "effectOnly")}
              title="Show deep glow effect only"
            >
              Effect Only
            </button>
            <button
              className={`${styles.modeToggleBtn} ${
                options.viewMode === "split" ? styles.modeToggleActive : ""
              }`}
              onClick={() => updateOption("viewMode", "split")}
              title="Show split screen wipe preview"
            >
              Split
            </button>
          </div>

          {/* Floating Top-Right Zoom / Resolution Badge */}
          {hasLayer && layerPixels && (
            <div className={styles.floatingTopRight}>
              <span>
                {layerPixels.width} × {layerPixels.height}
              </span>
            </div>
          )}

          {/* Draggable Vertical Split Wipe Handle */}
          {options.viewMode === "split" && hasLayer && (
            <SplitHandle
              splitPos={options.splitPos ?? 0.5}
              onChange={(pos) => updateOption("splitPos", pos)}
              containerRef={viewportRef}
            />
          )}

          {/* Empty / Busy / Error overlays */}
          {status === "idle" && (
            <div className={styles.placeholder}>
              <span className={styles.placeholderIcon}>⬡</span>
              <p className={styles.placeholderText}>
                Select an active layer and click
                <br />
                <strong>Refresh Layer</strong> to preview glow.
              </p>
            </div>
          )}

          {isLoading && (
            <div className={styles.placeholder}>
              <span className={styles.spinnerText}>
                Sampling layer buffer…
              </span>
            </div>
          )}

          {isCommitting && (
            <div className={styles.placeholder}>
              <span className={styles.spinnerText}>
                Rendering full-res Dual-Kawase pass…
              </span>
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
            className={styles.previewCanvas}
            style={{ display: hasLayer && !isBusy ? "block" : "none" }}
            aria-label="Active layer deep glow preview"
          />
        </div>
      </section>

      {/* ── 3. Scrollable Parameter Grid ─────────────────────────────────── */}
      <div className={styles.scrollArea}>
        {/* SECTION 1: BLOOM CORE */}
        <section className={styles.section}>
          <Crosshair className={styles.crosshairTopLeft} />
          <Crosshair className={styles.crosshairTopRight} />

          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("core")}
          >
            <span className={styles.sectionTitle}>1. Bloom Core</span>
            <span className={styles.sectionChevron}>
              {sectionsOpen.core ? "▾" : "▸"}
            </span>
          </div>

          {sectionsOpen.core && (
            <div className={styles.sectionBody}>
              <Slider
                label="Intensity"
                value={options.intensity}
                min={0.0}
                max={5.0}
                step={0.05}
                precision={2}
                defaultValue={1.5}
                onChange={(v) => updateOption("intensity", v)}
                disabled={isBusy}
              />

              <Slider
                label="Radius"
                value={options.radius}
                min={1.0}
                max={50.0}
                step={0.5}
                precision={1}
                unit="px"
                defaultValue={16.0}
                onChange={(v) => updateOption("radius", v)}
                disabled={isBusy}
              />

              <div className={styles.twoColRow}>
                <Slider
                  label="Threshold"
                  value={options.threshold}
                  min={0.0}
                  max={1.0}
                  step={0.01}
                  precision={2}
                  defaultValue={0.15}
                  onChange={(v) => updateOption("threshold", v)}
                  disabled={isBusy}
                />
                <Slider
                  label="Soft Knee"
                  value={options.knee}
                  min={0.0}
                  max={1.0}
                  step={0.02}
                  precision={2}
                  defaultValue={0.5}
                  onChange={(v) => updateOption("knee", v)}
                  disabled={isBusy}
                />
              </div>
            </div>
          )}
        </section>

        {/* SECTION 2: FALLOFF & OPTICS */}
        <section className={styles.section}>
          <Crosshair className={styles.crosshairTopLeft} />
          <Crosshair className={styles.crosshairTopRight} />

          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("optics")}
          >
            <span className={styles.sectionTitle}>2. Falloff & Optics</span>
            <span className={styles.sectionChevron}>
              {sectionsOpen.optics ? "▾" : "▸"}
            </span>
          </div>

          {sectionsOpen.optics && (
            <div className={styles.sectionBody}>
              {/* Interactive Falloff Curve Canvas Widget */}
              <FalloffCurve
                falloff={options.falloff}
                onChange={(v) => updateOption("falloff", v)}
                defaultValue={1.0}
                disabled={isBusy}
              />

              <Slider
                label="Falloff Decay"
                value={options.falloff}
                min={0.1}
                max={3.0}
                step={0.02}
                precision={2}
                defaultValue={1.0}
                onChange={(v) => updateOption("falloff", v)}
                disabled={isBusy}
              />

              {/* Anamorphic Stretch & Streak Angle */}
              <div className={styles.twoColRow}>
                <Slider
                  label="Anamorphic Stretch"
                  value={options.aspectRatio}
                  min={0.2}
                  max={5.0}
                  step={0.1}
                  precision={1}
                  unit="x"
                  defaultValue={1.0}
                  onChange={(v) => updateOption("aspectRatio", v)}
                  disabled={isBusy}
                />
                <Slider
                  label="Streak Angle"
                  value={options.angle}
                  min={-90.0}
                  max={90.0}
                  step={1.0}
                  precision={0}
                  unit="°"
                  defaultValue={0.0}
                  onChange={(v) => updateOption("angle", v)}
                  disabled={isBusy}
                />
              </div>

              {/* Chroma Shift & Highlight Roll-off */}
              <div className={styles.twoColRow}>
                <Slider
                  label="Chroma Shift (R/B)"
                  value={options.chromaShift}
                  min={0.0}
                  max={20.0}
                  step={0.2}
                  precision={1}
                  unit="px"
                  defaultValue={2.0}
                  onChange={(v) => updateOption("chromaShift", v)}
                  disabled={isBusy}
                />
                <Slider
                  label="Highlight Roll-Off"
                  value={options.rolloff}
                  min={0.0}
                  max={2.0}
                  step={0.05}
                  precision={2}
                  defaultValue={1.0}
                  onChange={(v) => updateOption("rolloff", v)}
                  disabled={isBusy}
                />
              </div>

              {/* Exposure & Glow Saturation */}
              <div className={styles.twoColRow}>
                <Slider
                  label="Exposure"
                  value={options.exposure}
                  min={-3.0}
                  max={3.0}
                  step={0.1}
                  precision={1}
                  unit="EV"
                  defaultValue={0.0}
                  onChange={(v) => updateOption("exposure", v)}
                  disabled={isBusy}
                />
                <Slider
                  label="Glow Saturation"
                  value={options.saturation}
                  min={0.0}
                  max={3.0}
                  step={0.05}
                  precision={2}
                  defaultValue={1.0}
                  onChange={(v) => updateOption("saturation", v)}
                  disabled={isBusy}
                />
              </div>

              {/* Anti-Banding Dither */}
              <Slider
                label="Anti-Banding Dither"
                value={options.dither}
                min={0.0}
                max={2.0}
                step={0.05}
                precision={2}
                defaultValue={0.5}
                onChange={(v) => updateOption("dither", v)}
                disabled={isBusy}
              />
            </div>
          )}
        </section>

        {/* SECTION 3: COLOR & COMPOSITE */}
        <section className={styles.section}>
          <Crosshair className={styles.crosshairTopLeft} />
          <Crosshair className={styles.crosshairTopRight} />

          <div
            className={styles.sectionHeader}
            onClick={() => toggleSection("color")}
          >
            <span className={styles.sectionTitle}>3. Color & Composite</span>
            <span className={styles.sectionChevron}>
              {sectionsOpen.color ? "▾" : "▸"}
            </span>
          </div>

          {sectionsOpen.color && (
            <div className={styles.sectionBody}>
              {/* Tint Swatch & Preset Chips */}
              <div className={styles.tintRow}>
                <div className={styles.tintHeader}>
                  <span className={styles.tintLabel}>Optical Tint</span>
                  <span className={styles.tintHex}>{options.tint}</span>
                </div>

                <div className={styles.swatchControls}>
                  <div
                    className={styles.activeSwatch}
                    style={{ backgroundColor: options.tint }}
                    title="Click to select custom tint"
                  >
                    <input
                      type="color"
                      className={styles.colorInputHidden}
                      value={options.tint}
                      onChange={(e) => updateOption("tint", e.target.value)}
                      disabled={isBusy}
                    />
                  </div>

                  <div className={styles.presetChips}>
                    {QUICK_CHIPS.map((chipHex) => (
                      <button
                        key={chipHex}
                        className={`${styles.chip} ${
                          options.tint.toLowerCase() === chipHex.toLowerCase()
                            ? styles.chipActive
                            : ""
                        }`}
                        style={{ backgroundColor: chipHex }}
                        onClick={() => updateOption("tint", chipHex)}
                        disabled={isBusy}
                        title={`Select ${chipHex}`}
                      />
                    ))}
                  </div>
                </div>

                {/* Shader-Adaptive Mode Checkbox */}
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    className={styles.checkboxInput}
                    checked={shaderAdaptive}
                    onChange={(e) => setShaderAdaptive(e.target.checked)}
                    disabled={isBusy}
                  />
                  <span>
                    Shader-Adaptive Mode (Sync UI accent to tint)
                  </span>
                </label>
              </div>

              {/* Blend Mode Segmented Tray */}
              <div className={styles.blendModeRow}>
                <span className={styles.blendModeLabel}>
                  Photoshop Blend Mode
                </span>
                <div className={styles.blendModeTray}>
                  <button
                    className={`${styles.blendModeBtn} ${
                      options.blendMode === "screen"
                        ? styles.blendModeActive
                        : ""
                    }`}
                    onClick={() => updateOption("blendMode", "screen")}
                    disabled={isBusy}
                  >
                    Screen
                  </button>
                  <button
                    className={`${styles.blendModeBtn} ${
                      options.blendMode === "linearDodge"
                        ? styles.blendModeActive
                        : ""
                    }`}
                    onClick={() => updateOption("blendMode", "linearDodge")}
                    disabled={isBusy}
                  >
                    Linear Dodge (Add)
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ── 4. Sticky Bottom Action Bar ──────────────────────────────────── */}
      <footer className={styles.actionBar}>
        <button
          className={styles.btnSecondary}
          onClick={handleRefresh}
          disabled={isBusy}
          aria-label="Refresh active layer preview"
        >
          {isLoading ? "Sampling…" : "Refresh Layer"}
        </button>
        <button
          className={styles.btnPrimary}
          onClick={handleApply}
          disabled={isBusy || !hasLayer}
          aria-label="Apply full-resolution glow to layer"
        >
          {isCommitting ? "Applying Full-Res…" : "Apply to Layer"}
        </button>
      </footer>
    </div>
  );
}
