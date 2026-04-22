import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// vite.config.js
export default defineConfig({
  base: '/webmap/',
  plugins: [react()],
  server: {
    port: 5121,
    host: '0.0.0.0',
    hmr: {
      clientPort: 80,
      path: '/webmap/',
    },
  },
})