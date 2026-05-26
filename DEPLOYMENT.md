# Deployment Guide

Recommended production architecture:

```txt
Frontend: Vercel or static hosting
Backend/worker: Railway or Render
Database: Supabase Postgres
Storage: Cloudflare R2 or S3
DNS/domain: Cloudflare
```

For the current single-server MVP, deploy the whole app to Railway or Render first. Split frontend/backend later.

## Render Backend

Use Docker on Render for this project. The repo includes a `Dockerfile` that installs:

- `ffmpeg`
- `python3`
- `yt-dlp`

Render settings:

```txt
Runtime: Docker
Dockerfile Path: ./Dockerfile
```

The Docker build runs `yt-dlp --version` and `ffmpeg -version`, so deploy logs will fail early if either binary cannot be installed.

Runtime startup also logs the detected versions:

```txt
[startup] yt-dlp ready: ...
[startup] FFmpeg ready: ...
```

Keep these env vars:

```txt
YTDLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
```

## Railway / Native Node Backend

Set start command:

```sh
node server.js
```

Environment variables:

```txt
HOST=0.0.0.0
PORT=8080
APP_BASE_URL=https://app.yourdomain.com
YOUTUBE_API_KEY=
LLM_PROVIDER=emergent
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=gpt-4o-mini
DATABASE_URL=
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
YTDLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
```

If using a native Node runtime instead of Docker, you must install `yt-dlp` and `ffmpeg` yourself. Docker is recommended because it makes both binaries detectable in production.

## Supabase Postgres

1. Create Supabase project.
2. Copy connection string from Project Settings > Database.
3. Add it as `DATABASE_URL`.
4. Use `sql/schema.sql` as the starting migration.

Current MVP still uses local JSON unless database integration is expanded. The schema is prepared for the production migration step.

## Cloudflare R2 / S3

1. Create R2 bucket.
2. Create R2 API token.
3. Add S3-compatible keys to env.
4. Update storage adapter to upload generated clips and originals.

## Vercel Frontend Later

When splitting the app:

1. Move `public/` into a frontend app.
2. Deploy frontend to Vercel.
3. Set API base URL to Railway/Render backend.
4. Keep video rendering on backend/worker, not Vercel serverless.

## Domain

Recommended DNS:

```txt
app.yourdomain.com -> Railway/Render backend
www.yourdomain.com -> marketing site later
```

In Cloudflare DNS, add the CNAME target provided by Railway/Render.
