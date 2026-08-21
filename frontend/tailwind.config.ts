import type { Config } from "tailwindcss";

// 1-bit pixel brand: slate ink on broken-white cream, matching the on-chain NFT palette.
// Every color resolves through a CSS variable so the same utility classes render the dark
// theme when <html class="dark"> is set (see globals.css for both palettes).
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        cream: { DEFAULT: "var(--c-cream)", 2: "var(--c-cream2)", 3: "var(--c-cream3)" },
        ink: { DEFAULT: "var(--c-ink)", strong: "var(--c-ink-strong)", soft: "var(--c-ink-soft)" },
        line: "var(--c-line)",
        accent: "var(--c-accent)",
        good: "var(--c-good)",
        warn: "var(--c-warn)",
      },
      fontFamily: {
        pixel: ["var(--font-silkscreen)", "monospace"],
        sans: ["var(--font-grotesk)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        pixel: "3px 3px 0 var(--c-shadow)",
        "pixel-sm": "2px 2px 0 var(--c-shadow)",
      },
      borderRadius: { none: "0" },
    },
  },
  plugins: [],
};

export default config;
