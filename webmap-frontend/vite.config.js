import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// vite.config.js
export default defineConfig({
  base: '/webmap/',
  plugins: [react()],
  server: {
    port: 5021,
    host: '0.0.0.0'
  }
})