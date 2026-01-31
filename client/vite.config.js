import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3336,
    proxy: {
      '/api': 'http://localhost:3335',
      '/socket.io': { target: 'http://localhost:3335', ws: true }
    }
  }
})
