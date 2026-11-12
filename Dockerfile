FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY docs ./docs
ENV NODE_ENV=production
EXPOSE 4010
USER node
ENTRYPOINT ["node", "bin/pesalab.js", "--host", "0.0.0.0", "--data-dir", "/tmp/pesalab"]
