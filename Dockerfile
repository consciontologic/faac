# Digest-pinned official Node image; Dependabot proposes reviewed updates.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
LABEL org.opencontainers.image.source="https://github.com/consciontologic/faac" \
      org.opencontainers.image.description="A durable terminal coding agent using hosted free models" \
      org.opencontainers.image.licenses="MIT"
# Workspace projects may need their own language toolchains; extend this image.
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates git bash ripgrep python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /home/node/.local/share/faac \
    && chown -R node:node /workspace /home/node/.local
WORKDIR /opt/faac
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/dist/ ./dist/
COPY --from=build /build/node_modules/ ./node_modules/
COPY data/baseline.json ./data/baseline.json
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY docs/project/ATTRIBUTION.md ./docs/project/ATTRIBUTION.md
RUN ln -s /opt/faac/dist/cli.js /usr/local/bin/faac
ENV FAAC_HOME=/home/node/.local/share/faac
USER node
WORKDIR /workspace
ENTRYPOINT ["faac"]
