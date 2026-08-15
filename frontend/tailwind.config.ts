import type { Config } from "tailwindcss";

// 1-bit pixel brand: slate ink on broken-white cream. Matches the on-chain NFT palette.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        cream: { DEFAULT: "#EDE8DE", 2: "#F5F2EB", 3: "#E4DED2" },
        ink: { DEFAULT: "#4E5666", strong: "#343945", soft: "#757B8A" },
        line: "#CDC7BA",
        accent: "#A6412F",
        good: "#2F6B52",
        warn: "#8A6416",
      },
      fontFamily: {
        pixel: ["var(--font-silkscreen)", "monospace"],
        sans: ["var(--font-grotesk)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        pixel: "3px 3px 0 #4E5666",
        "pixel-sm": "2px 2px 0 #4E5666",
      },
      borderRadius: { none: "0" },
    },
  },
  plugins: [],
};

export default config;
