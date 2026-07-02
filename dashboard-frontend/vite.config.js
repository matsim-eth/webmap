import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: '/dashboard/',
  // Strip console/debugger from production bundles only — dev keeps the
  // logs (they are the main debugging tool on the dev-mode deployment).
  esbuild: command === 'build' ? { drop: ['console', 'debugger'] } : undefined,
  build: {
    // The two heavyweights get their own long-term-cacheable chunks: a code
    // change in the app no longer re-downloads several MB of plotly/mapbox.
    rollupOptions: {
      output: {
        manualChunks: {
          plotly: ['plotly.js', 'react-plotly.js'],
          mapbox: ['mapbox-gl'],
        },
      },
    },
  },
  server: {
    port: 5122,
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: {
      clientPort: 80,
      path: '/dashboard/',
    },
  },
}))
