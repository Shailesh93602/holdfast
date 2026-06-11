FROM node:22-slim

WORKDIR /app

# Install runtime deps only (tsx runs the TS directly; no build step needed).
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Apply Drizzle migrations when the container boots (fresh DB on first deploy).
ENV RUN_MIGRATIONS_ON_BOOT=true
EXPOSE 3000

CMD ["npm", "start"]
