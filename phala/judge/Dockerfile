# Build from the repository root:  docker build -f phala/judge/Dockerfile -t elyra-court-judge .
# Then push and PIN THE DIGEST in docker-compose.yml: the digest is what the compose-hash (RTMR3) attests.
FROM node:22-slim AS build
WORKDIR /app
COPY sdk/src sdk/src
COPY phala/judge/package.json phala/judge/tsconfig.json phala/judge/
COPY phala/judge/src phala/judge/src
WORKDIR /app/phala/judge
RUN npm install --no-audit --no-fund && npx tsc -p . && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app/phala/judge
COPY --from=build /app/phala/judge/package.json ./
COPY --from=build /app/phala/judge/node_modules ./node_modules
COPY --from=build /app/phala/judge/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/phala/judge/src/main.js"]
