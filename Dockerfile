# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Install deps first for better caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["npm","start"]
