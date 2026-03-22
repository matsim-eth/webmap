FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

FROM base AS dev
EXPOSE 5023
CMD ["npm","run","dev","--","--host","0.0.0.0","--port","5023"]

FROM base AS build
RUN npm run build

FROM nginx:1.27-alpine AS prod
COPY --from=build /app/dist /usr/share/nginx/html
RUN printf 'server {\n  listen 5023;\n  location /dashboard/ {\n    alias /usr/share/nginx/html/;\n    try_files $uri $uri/ /dashboard/index.html;\n  }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 5023
