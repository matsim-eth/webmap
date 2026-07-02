FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

FROM base AS dev
EXPOSE 5121
CMD ["npm","run","dev","--","--host","0.0.0.0","--port","5121"]

FROM base AS build
RUN npm run build

FROM nginx:1.27-alpine AS prod
# The reverse proxy forwards /webmap/… unchanged and vite builds with
# base '/webmap/', so the bundle must live under html/webmap and nginx
# must listen on the port the proxy upstream points at (5021) — the
# stock image config (port 80, html root) serves nothing behind it.
COPY webconfig/nginx.conf /etc/nginx/nginx.conf
COPY webconfig/frontend_prod.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html/webmap
EXPOSE 5021