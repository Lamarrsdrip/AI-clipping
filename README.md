# ClipForge AI

AI clipping tool for generating original, transformed, ready-to-post short videos from YouTube sources.

The MVP does **not** connect to TikTok, Instagram, Facebook, YouTube, or X. It creates clips, transformation controls, captions, posting copy, hashtags, and manual upload instructions.

## What It Does

- Import a YouTube video or channel.
- Select videos to process.
- Confirm rights or valid reuse purpose.
- Transcribe and detect clip-worthy moments.
- Render vertical clips when `yt-dlp`, FFmpeg, and an OpenAI-compatible LLM provider are configured.
- Generate demo draft clips when the media stack is missing.
- Add transformations:
  - custom intro hook text
  - AI summary overlay text
  - caption style
  - source credit
  - watermark/brand text
  - split-screen commentary layout setting
  - voiceover/commentary file selection
  - blurred vertical background/frame
  - zoom cuts, highlight effects, b-roll placeholders
- Provide a Manual Posting Assistant:
  - viral title
  - caption
  - hashtags
  - first comment
  - best posting time
  - TikTok / Instagram / Facebook / YouTube Shorts / X upload instructions
  - copy buttons
  - originality checklist

## Safety Boundary

This project does not include copyright-detection bypasses or tools meant to hide copied content. The focus is on user-controlled transformation, commentary/context, captions, source credit, branding, and rights confirmation.

## Install

```sh
cd ai-clip-saas
node server.js
```

Open:

```txt
http://127.0.0.1:4173
```

Demo private login:

```txt
Email: ava@clipforge.local
Password: demo12345
```

## Real Pipeline Requirements

Install:

```sh
brew install ffmpeg yt-dlp
```

Create `.env`:

```sh
cp .env.example .env
```

Add:

```txt
YOUTUBE_API_KEY=
LLM_PROVIDER=emergent
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=gpt-4o-mini
```

Optional production services:

```txt
DATABASE_URL=
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

## Folder Structure

```txt
server.js              Node backend/API/static server
public/                Mobile-first web app
data/                  Local JSON database for private/dev mode
storage/originals/     Downloaded source videos
storage/clips/         Generated clips
sql/schema.sql         Postgres schema draft
screenshots/           Place product screenshots here
SETUP.md               Local setup guide
DEPLOYMENT.md          Deployment guide
PRODUCTION_CHECKLIST.md Production readiness checklist
```

## GitHub

`.env`, generated videos, and local database files are ignored by `.gitignore`.
