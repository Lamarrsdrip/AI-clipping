FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=10000
ENV YTDLP_PATH=yt-dlp
ENV FFMPEG_PATH=ffmpeg
ENV YTDLP_JS_RUNTIME=node

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt \
  && python3 -m yt_dlp --version \
  && yt-dlp --version \
  && ffmpeg -version \
  && true

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 10000

CMD ["node", "server.js"]
