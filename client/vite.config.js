import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3335,
    proxy: {
      '/api': 'http://localhost:3334',
      '/socket.io': { target: 'http://localhost:3334', ws: true }
    }
  }
})
