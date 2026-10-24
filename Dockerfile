# Kaigakure — Python extractor + Node API + static frontend
#
# Needs: Python 3.11+, yt-dlp, gallery-dl, ffmpeg, and Chromium for Telegram.
# Size is the tradeoff for being able to read real social media.
#
# Storage: KAIGAKURE_DATA is left UNSET by default so data stays inside the
# container at app/data. That works everywhere, including Render's free tier
# (which gives a writable filesystem but no persistent disk). Set
# KAIGAKURE_DATA and mount a volume if you want files to survive a restart.
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

# --- Node app ---------------------------------------------------------
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server/ ./server/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Writable scratch space inside the container (jobs, zips, cookies).
RUN mkdir -p /app/data/jobs /app/data/tmp /app/data/accounts

EXPOSE 3000
ENV PORT=3000

# Playwright browsers are baked into the base image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:3000/api/health')" || exit 1

CMD ["node", "server/index.js"]
