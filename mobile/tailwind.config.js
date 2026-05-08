/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // ── Cairn design tokens (dark theme — default for mobile) ──────────
        // Backgrounds
        bg:        "#0d0d0d",   // --background
        surface:   "#141414",   // --surface
        surface2:  "#1a1a1a",   // --surface-2
        surface3:  "#222222",   // --surface-3
        // Borders
        border:    "#2a2a2a",   // --border
        borderSubtle: "#1f1f1f", // --border-subtle
        // Accent
        accent:    "#7c6af7",   // --accent  (violet)
        accentHover: "#9281ff", // --accent-hover
        // Text
        textPrimary:   "#e8e4dc", // --text-primary
        textSecondary: "#9e9a94", // --text-secondary
        textTertiary:  "#66635f", // --text-tertiary
        // Semantic
        success: "#3ecf8e",
        warning: "#f59e0b",
        danger:  "#ef4444",
        info:    "#60a5fa",
        // Muted
        muted:   "#666360",
        mutedFg: "#a09c96",
        // Priority colours (match desktop PRIORITY_COLOR)
        pLow:    "#3f3f46",
        pMedium: "#7c6af7",
        pHigh:   "#f97316",
        pUrgent: "#ef4444",
        // Column accent colours (match COLUMN_COLORS)
        colBacklog:    "#666360",
        colTodo:       "#60a5fa",
        colInProgress: "#f59e0b",
        colReview:     "#a78bfa",
        colDone:       "#3ecf8e",
      },
      fontFamily: {
        sans: ["System", "ui-sans-serif"],
        mono: ["ui-monospace", "monospace"],
      },
      borderRadius: {
        sm:  "4px",
        md:  "8px",
        lg:  "12px",
        xl:  "16px",
        "2xl": "20px",
      },
    },
  },
  plugins: [],
};
