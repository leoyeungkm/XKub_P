"use client";

import { useEffect, useState } from "react";

/** Tracks the active theme by observing the `light` class on <html>,
 *  so components (e.g. the chart) can react to the theme toggle. */
export function useIsLight() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setLight(el.classList.contains("light"));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  return light;
}
