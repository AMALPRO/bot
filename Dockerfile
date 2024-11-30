# Use official Node.js LTS image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Set environment to production
ENV NODE_ENV=production

# Copy package files first to leverage Docker cache
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application code
COPY . .

# Set Chromium path for Puppeteer (if needed)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Use dumb-init as init system
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Run the bot
CMD ["node", "index.js"]

# Optional: Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs
USER nodejs
