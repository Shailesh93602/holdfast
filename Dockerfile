FROM node:22-slim

WORKDIR /app

# Install runtime deps only (tsx runs the TS directly; no build step needed).
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Apply Drizzle migrations + self-seed the demo catalog on boot (fresh DB on
# first deploy). Both are idempotent/guarded.
ENV RUN_MIGRATIONS_ON_BOOT=true
ENV SEED_ON_BOOT=true
EXPOSE 3000

CMD ["npm", "start"]
