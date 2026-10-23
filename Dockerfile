# Container image for any host (Fly.io, Railway, Google Cloud Run, a school server).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# Demo school by default; use "npm start" with real settings for production (see README).
CMD ["npm", "run", "demo"]
