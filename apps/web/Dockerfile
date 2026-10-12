FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/tsconfig.json ./apps/web/
COPY vite.config.ts ./
RUN npm ci
COPY apps/web ./apps/web
RUN npm run build --workspace=@sd-virtual/web

FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
