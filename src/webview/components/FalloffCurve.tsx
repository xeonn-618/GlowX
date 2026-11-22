import React, { useRef, useEffect, useState, useCallback } from "react";
import styles from "./FalloffCurve.module.css";

interface FalloffCurveProps {
  falloff: number; // 0.1 – 3.0
  onChange: (value: number) => void;
  defaultValue?: number;
  disabled?: boolean;
}

export const FalloffCurve: React.FC<FalloffCurveProps> = ({
  falloff,
  onChange,
  defaultValue = 1.0,
  disabled = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Redraw curve spline whenever falloff changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Padding inside the 84px well
    const padX = 14;
    const padY = 12;
    const plotW = width - padX * 2;
    const plotH = height - padY * 2;

    // 1. Draw subtle grid lines (3 horizontal, 3 vertical)
    ctx.strokeStyle = "#242429";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i <= 3; i++) {
      const gx = padX + (plotW * i) / 4;
      ctx.moveTo(gx, padY);
      ctx.lineTo(gx, padY + plotH);

      const gy = padY + (plotH * i) / 4;
      ctx.moveTo(padX, gy);
      ctx.lineTo(padX + plotW, gy);
    }
    ctx.stroke();

    // 2. Compute Spline Coordinates for 6 Dual-Kawase pyramid levels
    // Formula: y = 1.0 / (1.0 + (level * falloff))
    const points: [number, number][] = [];
    const steps = 40;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps; // 0 to 1
      const level = t * 5.0; // Level 0 to 5
      const weight = 1.0 / (1.0 + level * falloff);
      const px = padX + t * plotW;
      const py = padY + plotH - weight * plotH;
      points.push([px, py]);
    }

    // 3. Draw 12% Opacity Fill Underneath Spline
    const accentColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent-primary")
        .trim() || "#f4f4f6";

    ctx.beginPath();
    ctx.moveTo(padX, padY + plotH);
    for (const [px, py] of points) {
      ctx.lineTo(px, py);
    }
    ctx.lineTo(padX + plotW, padY + plotH);
    ctx.closePath();

    ctx.fillStyle = "rgba(244, 244, 246, 0.12)";
    // If accent color is colored (e.g. #7dd3fc), use subtle colored fill
    if (accentColor.startsWith("#") && accentColor.length === 7) {
      const r = parseInt(accentColor.slice(1, 3), 16);
      const g = parseInt(accentColor.slice(3, 5), 16);
      const b = parseInt(accentColor.slice(5, 7), 16);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.12)`;
    }
    ctx.fill();

    // 4. Draw 2px Spline Stroke
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    // 5. Draw 9px × 9px Draggable Control Handle at representative mid-point (level 2)
    const midT = 0.4;
    const midLevel = midT * 5.0;
    const midWeight = 1.0 / (1.0 + midLevel * falloff);
    const hx = padX + midT * plotW;
    const hy = padY + plotH - midWeight * plotH;

    // Handle shadow & border
    ctx.fillStyle = "#f4f4f6";
    ctx.strokeStyle = "#08080a";
    ctx.lineWidth = 1.5;

    const hSize = 9;
    const radius = 2;
    const x0 = hx - hSize / 2;
    const y0 = hy - hSize / 2;

    ctx.beginPath();
    ctx.roundRect(x0, y0, hSize, hSize, radius);
    ctx.fill();
    ctx.stroke();
  }, [falloff]);

  // Canvas size sync
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          canvas.width = Math.round(width * window.devicePixelRatio);
          canvas.height = Math.round(height * window.devicePixelRatio);
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
        }
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  const updateFromPointer = useCallback(
    (clientY: number) => {
      if (!canvasRef.current || disabled) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const padY = 12;
      const plotH = rect.height - padY * 2;
      const relY = Math.max(0, Math.min(1, (clientY - rect.top - padY) / plotH));

      // Invert Y: dragging upward increases weight (lower falloff), dragging downward decreases weight (higher falloff)
      // weight = 1.0 - relY in [0.05, 0.95]
      // At level 2.0: weight = 1.0 / (1.0 + 2.0 * falloff) => falloff = (1.0 / weight - 1.0) / 2.0
      const weight = Math.max(0.12, Math.min(0.95, 1.0 - relY));
      const computedFalloff = Math.max(0.1, Math.min(3.0, (1.0 / weight - 1.0) / 2.0));
      onChange(Number(computedFalloff.toFixed(2)));
    },
    [disabled, onChange]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    updateFromPointer(e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDragging) {
      updateFromPointer(e.clientY);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDragging) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setIsDragging(false);
    }
  };

  const handleDoubleClick = () => {
    if (!disabled) {
      onChange(defaultValue);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <span className={styles.headerLabel}>FALLOFF CURVE (INVERSE-SQUARE)</span>
        <span className={`${styles.headerValue} tabular-nums`}>
          λ = {falloff.toFixed(2)}
        </span>
      </div>

      <div
        ref={containerRef}
        className={styles.well}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        title="Drag vertically to adjust inverse-square falloff decay. Double-click to reset (1.0)."
      >
        <canvas ref={canvasRef} className={styles.canvas} />
      </div>
    </div>
  );
};
