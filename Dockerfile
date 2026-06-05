FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI inside the image so users do not need to install it on
# the host machine.
RUN npm install -g @anthropic-ai/claude-code

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev \
  && mkdir -p /app/runtime/data /app/runtime/sessions /app/runtime/workspace /app/runtime/.claude/projects \
  && chown -R node:node /app

USER node

ENTRYPOINT ["node", "scripts/docker-entrypoint.mjs"]
CMD ["node", "dist/src/cli.js", "--config", ".qqbotrc.toml"]
