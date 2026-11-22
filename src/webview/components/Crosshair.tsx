import React from "react";

interface CrosshairProps {
  className?: string;
  style?: React.CSSProperties;
}

export const Crosshair: React.FC<CrosshairProps> = ({ className, style }) => {
  return (
    <svg
      width="7"
      height="7"
      viewBox="0 0 7 7"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{
        width: "7px",
        height: "7px",
        display: "block",
        flexShrink: 0,
        pointerEvents: "none",
        ...style,
      }}
      aria-hidden="true"
    >
      <line x1="3.5" y1="0" x2="3.5" y2="7" stroke="var(--crosshair-color, #52525c)" strokeWidth="1" />
      <line x1="0" y1="3.5" x2="7" y2="3.5" stroke="var(--crosshair-color, #52525c)" strokeWidth="1" />
    </svg>
  );
};
