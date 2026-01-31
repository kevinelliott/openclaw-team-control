/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { dark: '#0d1117', card: '#161b22', hover: '#21262d' },
        border: { default: '#30363d', active: '#58a6ff' },
        text: { primary: '#e6edf3', secondary: '#8b949e', muted: '#484f58' }
      }
    }
  },
  plugins: []
}
