"use client";

// Chart on top, activity below, with a draggable divider the user can pull to
// set the split. The chart height is persisted so it sticks across visits.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const KEY = "xkub.chartHeight";
const MIN = 280;
const MAX = 900;

export default function ResizableColumn({ chart, activity }: { chart: (h: number) => ReactNode; activity: ReactNode }) {
  const [height, setHeight] = useState(460);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const saved = Number(localStorage.getItem(KEY));
    if (saved >= MIN && saved <= MAX) setHeight(saved);
  }, []);

  const onMove = useCallback((e: MouseEvent) => {
    if (!drag.current) return;
    const next = Math.min(MAX, Math.max(MIN, drag.current.startH + (e.clientY - drag.current.startY)));
    setHeight(next);
  }, []);

  const stop = useCallback(() => {
    drag.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", stop);
    setHeight((h) => { localStorage.setItem(KEY, String(h)); return h; });
  }, [onMove]);

  const start = (e: React.MouseEvent) => {
    drag.current = { startY: e.clientY, startH: height };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  return (
    <div className="flex min-w-0 flex-col">
      {chart(height)}
      <div
        onMouseDown={start}
        onDoubleClick={() => { setHeight(460); localStorage.setItem(KEY, "460"); }}
        title="Drag to resize · double-click to reset"
        className="group flex h-3 cursor-row-resize items-center justify-center"
      >
        <div className="h-0.5 w-10 rounded-full bg-line transition-colors group-hover:bg-accent" />
      </div>
      {activity}
    </div>
  );
}
