FROM node:20-alpine

# git/openssh: Baileys depende de libsignal-node, que el lockfile resuelve desde GitHub
RUN apk add --no-cache git openssh-client \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# auth_info = sesión de WhatsApp (debe montarse como volumen persistente)
RUN mkdir -p /app/logs /app/auth_info

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/ >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
