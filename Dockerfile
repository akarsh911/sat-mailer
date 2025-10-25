FROM node:20-alpine

WORKDIR /usr/src/app

# Copy dependency files first for caching
COPY package*.json ./

RUN npm install --production

# Copy all source code
COPY . .

# Create logs folder (optional)
RUN mkdir -p /usr/src/app/logs
VOLUME ["/usr/src/app/logs"]

# Set environment variable for Firebase credentials
ENV GOOGLE_APPLICATION_CREDENTIALS=/usr/src/app/serviceAccountKey.json
ENV NODE_ENV=production

CMD ["node", "index.js"]
