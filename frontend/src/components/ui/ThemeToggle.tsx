"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

// Theme resolution is script-free (see globals.css): with no saved choice the OS
// preference applies via prefers-color-scheme; a saved choice is enforced here after
// mount by adding .dark or .light to <html>, which overrides the media query both ways.
function osPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(theme: "dark" | "light" | null) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem("coattail.theme");
    } catch {
      /* private mode */
    }
    const theme = saved === "dark" || saved === "light" ? saved : null;
    apply(theme);
    setDark(theme ? theme === "dark" : osPrefersDark());
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    apply(next ? "dark" : "light");
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
      {/* Render after mount to avoid a server/client icon mismatch. */}
      {mounted ? <Icon name={dark ? "sun" : "moon"} className="w-[16px] h-[16px]" /> : <span className="w-[16px] h-[16px]" />}
    </button>
  );
}
