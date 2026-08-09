# Build context is sdk/ (the parent folder), so the file:../js dep resolves.
# Deploy from sdk/mcp: fly deploy .. -c fly.toml
# Prereq: npm run build in sdk/js and sdk/mcp (dist/ is copied, not built here).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY js ./js
COPY mcp/package.json ./mcp/
COPY mcp/dist ./mcp/dist
WORKDIR /app/mcp
RUN npm install --omit=dev --no-audit --no-fund
EXPOSE 8080
CMD ["node", "dist/http.js"]
