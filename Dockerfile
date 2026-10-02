FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
ENV NODE_ENV=production
EXPOSE 80
USER node
CMD ["npm", "start"]
