FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.html server.js README.md ./

EXPOSE 3000
CMD ["npm", "start"]
