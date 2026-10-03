/** @type {import('tailwindcss').Config} */
export default {
  // The client's renderer and developer panels draw inside play mode (E4, E5).
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../client/src/render/**/*.{ts,tsx}", "../client/src/ui/{dev-panels,perf-hud,admin-console,components}.tsx"],
  theme: { extend: {} },
  plugins: [],
};
