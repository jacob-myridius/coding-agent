# Stage 1: compile TypeScript from the parent package (src/ → dist/)
FROM node:20-alpine AS ts-builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Stage 2: production image
FROM node:20-alpine

WORKDIR /app

# Install git and bash (bash required by Myridius CLI for shell execution)
RUN apk add --no-cache git bash

# Install parent production dependencies (needed by compiled dist/ modules at runtime)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled TypeScript output (used by test-execution.js via ../dist/src/...)
COPY --from=ts-builder /app/dist ./dist

# Copy the CLI agent tarball (referenced by worker/package.json as file:../<tgz>)
COPY myridius-cli-agent-*.tgz ./

# Copy worker source (self-contained app with its own package.json)
COPY worker/ ./worker/

# Install worker dependencies
WORKDIR /app/worker
RUN npm ci

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 80

CMD ["node", "worker.js"]
