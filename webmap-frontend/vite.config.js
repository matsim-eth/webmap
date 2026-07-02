import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// vite.config.js
export default defineConfig(({ command }) => ({
  base: '/webmap/',
  plugins: [react()],
  // Strip console/debugger from production bundles only — dev keeps the
  // logs (they are the main debugging tool on the dev-mode deployment).
  esbuild: command === 'build' ? { drop: ['console', 'debugger'] } : undefined,
  build: {
    // The two heavyweights get their own long-term-cacheable chunks: a code
    // change in the app no longer re-downloads ~1.5 MB of mapbox/plotly.
    rollupOptions: {
      output: {
        manualChunks: {
          mapbox: ['mapbox-gl'],
          plotly: ['plotly.js', 'react-plotly.js'],
        },
      },
    },
  },
  server: {
    port: 5121,
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: {
      clientPort: 80,
      path: '/webmap/',
    },
  },
}))
