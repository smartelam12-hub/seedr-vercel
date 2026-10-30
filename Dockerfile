# Lightweight Node.js 20 on Alpine Linux
FROM node:20-alpine

# Install aria2
RUN apk add --no-cache aria2 ca-certificates

# Create app directory
WORKDIR /app

# Copy application files
COPY package.json ./
COPY server.js ./
COPY public ./public

# Create downloads and data directory
RUN mkdir -p /app/downloads /app/data

# Environment variables
ENV PORT=3000
ENV NODE_ENV=production

# Expose web port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
