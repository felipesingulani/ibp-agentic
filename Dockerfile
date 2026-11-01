# Render free (Docker) — Node 22 + Python OR-Tools pro solver A4.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN python3 -m venv solver/.venv && solver/.venv/bin/pip install --no-cache-dir ortools
COPY . .
ENV PORT=10000
EXPOSE 10000
# migra + seed idempotentes a cada boot, depois sobe a API
CMD ["sh", "-c", "npm run migrate && npm run seed && npm start"]
