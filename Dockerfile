FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . . 

RUN mkdir -p /app/logs /app/auth_info && \
    chmod -R 777 /app/auth_info

EXPOSE 3001

CMD ["node", "server.js"]