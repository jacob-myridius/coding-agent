# Multi-stage Docker build for Implementation Worker

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY functions/ ./functions/

# Copy CLI agent if present
COPY myridius-cli-agent-*.tgz ./

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/host.json ./

# Copy CLI agent
COPY myridius-cli-agent-*.tgz ./

# Install CLI agent
RUN npm install ./myridius-cli-agent-*.tgz

# Install git (required for git operations)
RUN apk add --no-cache git

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set ownership
RUN chown -R nodejs:nodejs /app

USER nodejs

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost/api/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Start the worker
CMD ["node", "dist/worker/worker.js"]

