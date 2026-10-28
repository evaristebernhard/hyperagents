FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/scripts/env.mjs ./scripts/env.mjs
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
ENV APP_HOST=0.0.0.0 APP_PORT=8787 APP_DATA_DIR=/app/.data APP_SERVE_DIST=1
EXPOSE 8787
VOLUME ["/app/.data"]
CMD ["node", "server/index.mjs"]
