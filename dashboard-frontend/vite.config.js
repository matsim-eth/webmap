import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  server: {
    port: 5122,
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: {
      clientPort: 80,
      path: '/dashboard/',
    },
  },
})
