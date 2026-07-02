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
- `opencv-python-headless` + `mediapipe` (Reframe Engine v7 face tracking — see memory note below)

### ⚠️ Memory plan: required before face tracking runs for real

`face_track.py` now has its real dependencies (`opencv-python-headless`, `mediapipe`) available in
the image. Previously these were missing, so every clip silently fell back to a static center crop —
this is the fix that turns the app's actual differentiator on.

**This has a real memory cost that the `render.yaml` `starter` plan (512MB) was not sized for.**
`MAX_RSS_MB=420` only watches the Node process's own memory — it cannot see or protect against the
separate Python subprocess `face_track.py` spawns per render job, which loads mediapipe's Face Mesh
model and can add 150–300MB of RSS on top of Node's baseline. On a 512MB container that risks Render
hard-killing the whole service (not a graceful in-app fallback) under load.

**Before relying on this in production:** upgrade the Render plan to at least `standard` (2GB RAM,
~$25/mo vs. `starter`'s ~$7/mo) in `render.yaml` (`plan: standard`) and in the Render dashboard. This
is a recurring cost increase, so it's left as a manual decision rather than applied automatically.
Until upgraded, the code is safe either way — `face_track.py` still degrades gracefully to a static
crop if the dependencies fail to import — but a mid-render OOM kill under the old plan would surface
as a failed job instead of that graceful fallback.

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

If your existing Render service was created as a Node service and Render will not let you switch it to Docker, create a new Web Service:

1. Render dashboard > New > Web Service.
2. Select `Lamarrsdrip/AI-clipping`.
3. Choose `Docker` runtime.
4. Dockerfile path: `./Dockerfile`.
5. Add the same environment variables from the old service.
6. Deploy.
7. After it works, point your custom domain to the new Docker service and delete/suspend the old Node service.

The backend checks yt-dlp in this order:

```txt
YTDLP_PATH
yt-dlp
python3 -m yt_dlp
python -m yt_dlp
```

This means the app still works if Render can run the Python module but the binary shim is unreliable.

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
