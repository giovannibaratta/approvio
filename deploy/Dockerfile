FROM node:22-alpine AS builder

# Enable corepack for Yarn 2+
RUN corepack enable

WORKDIR /app

# Copy configuration files
COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.json tsconfig-google.json nest-cli.json webpack.config.js ./

# Copy .yarn for Yarn berry (releases/plugins)
COPY .yarn ./.yarn

# Copy source code and assets
COPY prisma ./prisma
COPY app ./app
COPY scripts ./scripts

# Install dependencies and build
RUN yarn install --frozen-lockfile
RUN yarn prisma:generate
RUN yarn build

# --- Runner Stage ---
FROM node:22-alpine AS runner

WORKDIR /app

# Copy production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy generated artifacts and migrations
COPY --from=builder /app/generated ./generated

# Expose port (Backend uses 3000)
EXPOSE 3000

# --- Backend Target ---
FROM runner AS backend
CMD ["node", "dist/backend/main.js"]

# --- Worker Target ---
FROM runner AS worker
CMD ["node", "dist/worker/main"]
