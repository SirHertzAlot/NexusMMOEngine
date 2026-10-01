/** @type {import('tailwindcss').Config} */

/**
 * The theme's colours are CSS variables holding bare HSL channels
 * (src/app.css). Declaring them here with `<alpha-value>` lets Tailwind
 * generate every utility for them — including opacity modifiers like
 * `bg-card/90`, which the hand-written classes this replaces could not.
 */
const hsl = (name) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: hsl("background"),
        foreground: hsl("foreground"),
        card: { DEFAULT: hsl("card"), foreground: hsl("card-foreground") },
        primary: { DEFAULT: hsl("primary"), foreground: hsl("primary-foreground") },
        secondary: { DEFAULT: hsl("secondary"), foreground: hsl("secondary-foreground") },
        accent: { DEFAULT: hsl("accent"), foreground: hsl("accent-foreground") },
        muted: { foreground: hsl("muted-foreground") },
        border: hsl("border"),
        input: hsl("input"),
        ring: hsl("ring"),
      },
    },
  },
  plugins: [],
};
