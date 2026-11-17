FROM node:20-alpine

WORKDIR /app

COPY package*.json .npmrc ./

RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node . .

ENV NODE_ENV=production
USER node

EXPOSE 3000

CMD ["node", "api.js"]
