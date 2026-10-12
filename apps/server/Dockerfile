FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
RUN npm ci
COPY apps/server/src ./apps/server/src
RUN npm run build --workspace=@sd-virtual/server

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
EXPOSE 3100
CMD ["node", "apps/server/dist/index.js"]
