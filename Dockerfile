FROM node:22-alpine
WORKDIR /app
COPY package.json server.js jev.js store.js ./
COPY public ./public
ENV PORT=3000 DATA_FILE=/data/state.json
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
