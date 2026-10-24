# Kaigakure — Python extractor + Node API + static frontend
#
# Two stages. The Playwright Python image ships Chromium + Python but NOT Node,
# so Node comes from its own official image and node_modules is copied across.
#
# Needs: Python 3.12, yt-dlp, gallery-dl, ffmpeg, Chromium (Telegram), Node 22.
# Size is the tradeoff for being able to read real social media.
#
# Storage: KAIGAKURE_DATA is left UNSET by default so data stays inside the
# container at app/data. That works everywhere, including Render's free tier
# (which gives a writable filesystem but no persistent disk). Set
# KAIGAKURE_DATA and mount a volume if you want files to survive a restart.

# --- Node dependencies ------------------------------------------------
# Isolated so the final image carries only node_modules, not the whole Node
# toolchain. npm ci needs package-lock.json to exist.
FROM node:22-bookworm-slim AS nodebuild
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- Final image ------------------------------------------------------
FROM mcr.microsoft.com/playwright/python:v1.49.0-noble

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# --- Python extractor deps --------------------------------------------
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ffmpeg (muxing + audio extraction)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Node runtime, copied out of the build stage above. The Playwright Python base
# image ships no Node at all, and Ubuntu's apt nodejs is 18.x (EOL, too old for
# Playwright 1.49). Copying the binary keeps the version exact and the image
# free of a second package manager.
COPY --from=nodebuild /usr/local/bin/node /usr/local/bin/node
COPY --from=nodebuild /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/bin/node /usr/local/bin/nodejs \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- Node app ---------------------------------------------------------
COPY --from=nodebuild /build/node_modules ./node_modules
COPY server/ ./server/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY package.json ./

# Writable scratch space inside the container (jobs, zips, cookies).
RUN mkdir -p /app/data/jobs /app/data/tmp /app/data/accounts

EXPOSE 3000
ENV PORT=3000

# Playwright browsers are baked into the base image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/index.js"]
