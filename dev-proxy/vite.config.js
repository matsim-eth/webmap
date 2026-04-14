import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',

    proxy: {
      // ─────────────── Backends ───────────────
      '/backend/datasets': {
        target: 'http://dataset_backend:5033',
        rewrite: (path) => path.replace(/^\/backend\/datasets/, ''),
        ws: true,
      },

      '/backend': {
        target: 'http://webmap_backend:5031',
        rewrite: (path) => path.replace(/^\/backend/, ''),
        ws: true,
      },

      '/authentification/backend': {
        target: 'http://authentification_backend:5032',
        rewrite: (path) =>
          path.replace(/^\/authentification\/backend/, ''),
        ws: true,
      },

      // ─────────────── Frontends ───────────────
      '/authentification': {
        target: 'http://authentification_frontend:5022',
        rewrite: (path) => path.replace(/^\/authentification/, ''),
      },

      '/dashboard': {
        target: 'http://dashboard_frontend:5122',
        ws: true,
      },

      '/webmap': {
        target: 'http://webmap_frontend:5121',
        ws: true,
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