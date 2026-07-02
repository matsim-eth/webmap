FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

FROM base AS dev
EXPOSE 5122
CMD ["npm","run","dev","--","--host","0.0.0.0","--port","5122"]

FROM base AS build
RUN npm run build

FROM nginx:1.27-alpine AS prod
# The reverse proxy forwards /dashboard/… unchanged and vite builds with
# base '/dashboard/', so the bundle must live under html/dashboard and
# nginx must listen on the port the proxy upstream points at (5023).
COPY webconfig/nginx.conf /etc/nginx/nginx.conf
COPY webconfig/frontend_prod.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html/dashboard
EXPOSE 5023
