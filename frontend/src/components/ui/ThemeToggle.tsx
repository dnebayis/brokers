"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

// Toggles the `dark` class on <html>. The inline script in layout.tsx applies the saved
// choice before first paint; this button only has to flip and persist it.
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      window.localStorage.setItem("coattail.theme", next ? "dark" : "light");
    } catch {
      /* private mode — theme simply won't persist */
    }
  }

  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="w-[38px] h-[38px] border-2 border-ink bg-cream-2 shadow-pixel-sm grid place-items-center text-ink-strong hover:text-accent"
    >
      {/* Render both and reveal after mount to avoid a server/client icon mismatch. */}
      {mounted ? <Icon name={dark ? "sun" : "moon"} className="w-[16px] h-[16px]" /> : <span className="w-[16px] h-[16px]" />}
    </button>
  );
}
