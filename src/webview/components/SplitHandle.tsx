import React, { useRef, useState, useCallback } from "react";
import styles from "./SplitHandle.module.css";

interface SplitHandleProps {
  splitPos: number; // 0.0 – 1.0
  onChange: (newPos: number) => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

export const SplitHandle: React.FC<SplitHandleProps> = ({
  splitPos,
  onChange,
  containerRef,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(
    (clientX: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const raw = (clientX - rect.left) / rect.width;
      const clamped = Math.max(0.02, Math.min(0.98, raw));
      onChange(Number(clamped.toFixed(3)));
    },
    [containerRef, onChange]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    updatePosition(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDragging) {
      updatePosition(e.clientX);
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

  const leftPercent = `${(splitPos * 100).toFixed(2)}%`;

  return (
    <div
      ref={handleRef}
      className={`${styles.splitRoot} ${isDragging ? styles.dragging : ""}`}
      style={{ left: leftPercent }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      title="Drag to compare original (left) vs composite glow (right)"
    >
      {/* 1px Vertical hairline */}
      <div className={styles.hairline} />

      {/* 18px x 26px 4px-radius grip handle */}
      <div className={styles.grip}>
        <svg
          width="10"
          height="12"
          viewBox="0 0 10 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={styles.gripIcon}
        >
          {/* Split arrow indicators ◄ ► */}
          <path d="M3.5 3L1 6L3.5 9" stroke="var(--text-secondary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6.5 3L9 6L6.5 9" stroke="var(--text-secondary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
};
