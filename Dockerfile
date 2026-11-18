FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js db.js ./
COPY public ./public
COPY cards ./cards
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
