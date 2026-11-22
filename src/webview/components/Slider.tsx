import React, { useRef, useState, useCallback } from "react";
import styles from "./Slider.module.css";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  precision?: number;
  unit?: string;
  defaultValue?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export const Slider: React.FC<SliderProps> = ({
  label,
  value,
  min,
  max,
  step = 0.05,
  precision = 2,
  unit = "",
  defaultValue,
  onChange,
  disabled = false,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editString, setEditString] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  const updateFromPointer = useCallback(
    (clientX: number) => {
      if (!trackRef.current || disabled) return;
      const rect = trackRef.current.getBoundingClientRect();
      const rawPct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const rawVal = min + rawPct * (max - min);
      const stepped = Math.round(rawVal / step) * step;
      const clamped = Math.max(min, Math.min(max, stepped));
      const rounded = Number(clamped.toFixed(precision));
      onChange(rounded);
    },
    [min, max, step, precision, disabled, onChange]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    updateFromPointer(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDragging) {
      updateFromPointer(e.clientX);
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

  const handleReset = () => {
    if (disabled) return;
    if (defaultValue !== undefined) {
      onChange(defaultValue);
    }
  };

  const startEdit = () => {
    if (disabled) return;
    setEditString(value.toFixed(precision));
    setIsEditing(true);
  };

  const commitEdit = () => {
    setIsEditing(false);
    const parsed = parseFloat(editString);
    if (!isNaN(parsed)) {
      const clamped = Math.max(min, Math.min(max, parsed));
      const rounded = Number(clamped.toFixed(precision));
      onChange(rounded);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      commitEdit();
    } else if (e.key === "Escape") {
      setIsEditing(false);
    }
  };

  return (
    <div className={`${styles.sliderRow} ${disabled ? styles.disabled : ""}`}>
      {/* Label and Numeric Readout */}
      <div className={styles.labelRow}>
        <span
          className={styles.label}
          onDoubleClick={handleReset}
          title={defaultValue !== undefined ? `Double-click to reset (${defaultValue})` : label}
        >
          {label}
        </span>

        {isEditing ? (
          <input
            type="text"
            className={styles.editInput}
            value={editString}
            autoFocus
            onChange={(e) => setEditString(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span
            className={`${styles.readout} tabular-nums`}
            onClick={startEdit}
            onDoubleClick={handleReset}
            title="Click to edit, double-click to reset"
          >
            {value.toFixed(precision)}
            {unit && <span className={styles.unit}>{unit}</span>}
          </span>
        )}
      </div>

      {/* 3px Precision Track with 10x12 Thumb */}
      <div
        ref={trackRef}
        className={styles.trackArea}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleReset}
      >
        <div className={styles.track}>
          <div className={styles.fill} style={{ width: `${pct}%` }} />
          <div
            className={styles.thumb}
            style={{ left: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
};
