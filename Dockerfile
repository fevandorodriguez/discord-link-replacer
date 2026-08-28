FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY config.json ./
USER node
CMD ["node", "src/index.js"]
