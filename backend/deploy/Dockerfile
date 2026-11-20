FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --ignore-scripts && npm run build
FROM python:3.12-slim-bookworm AS certificates
FROM docker:29-cli AS dockercli
FROM node:24-bookworm-slim
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "apps/api/dist/index.js"]
