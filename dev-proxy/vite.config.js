import { defineConfig } from 'vite'

// Port defaults = prod (GHCR images). Dev overrides set via env vars.
const p = (key, fallback) => process.env[key] || fallback
const isDev = (key) => process.env[key] === '1'

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      // ── Backends (immer rewrite, Ports ändern sich nicht) ────────
      '/backend/datasets': {
        target: `http://dataset_backend:${p('DATASET_BACKEND_PORT', '5033')}`,
        rewrite: (path) => path.replace(/^\/backend\/datasets/, ''),
        ws: true,
      },
      '/backend': {
        target: `http://webmap_backend:${p('WEBMAP_BACKEND_PORT', '5031')}`,
        rewrite: (path) => path.replace(/^\/backend/, ''),
        ws: true,
      },
      '/authentification/backend': {
        target: `http://authentification_backend:${p('AUTH_BACKEND_PORT', '5032')}`,
        rewrite: (path) => path.replace(/^\/authentification\/backend/, ''),
        ws: true,
      },
      '/authentification': {
        target: `http://authentification_frontend:${p('AUTH_FRONTEND_PORT', '5022')}`,
        rewrite: (path) => path.replace(/^\/authentification/, ''),
      },

      // ── Frontends (rewrite nur wenn GHCR/prod, nicht bei Vite dev) ─
      '/dashboard': {
        target: `http://dashboard_frontend:${p('DASHBOARD_FRONTEND_PORT', '5023')}`,
        ws: true,
        ...(isDev('DASHBOARD_DEV')
          ? {}
          : { rewrite: (path) => path.replace(/^\/dashboard/, '') }),
      },
      '/webmap': {
        target: `http://webmap_frontend:${p('WEBMAP_FRONTEND_PORT', '5021')}`,
        ws: true,
        ...(isDev('WEBMAP_DEV')
          ? {}
          : { rewrite: (path) => path.replace(/^\/webmap/, '') }),
      },
    },
  },
  plugins: [
    {
      name: 'root-redirect',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/' || req.url === '') {
            res.writeHead(302, { Location: '/webmap/' })
            res.end()
            return
          }
          next()
        })
      },
    },
  ],
})
