FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
# config.json lives under /app/data, not /app itself, because compose
# bind-mounts a *directory* there (see compose.yml) rather than the file
# directly. A single-file bind mount turns that path into its own mount
# point, and rename() onto a mount point returns EBUSY on Linux -- exactly
# what the admin panel's atomic write-then-rename does on every mode
# toggle. Every COPY/RUN above this line runs as root, so /app and
# everything under it is root:root 0755 by default; without the chown
# below, `USER node` has no write bit on /app/data and the toggle 500s
# with EACCES before it even reaches the mount-point problem.
COPY config.json ./data/config.json
RUN chown -R node:node /app/data
ENV LINKFIX_CONFIG_FILE=/app/data/config.json
USER node
CMD ["node", "src/index.js"]
