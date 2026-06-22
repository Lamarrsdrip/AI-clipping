# ClipForge AI — v2.0.0 (2026 Rebuild)

AI-powered video clipping SaaS. Upload a video or paste a YouTube link → AI finds the best viral moments → renders 9:16 vertical clips with captions → you download and post.

No auto-posting. No fake demo clips. Every clip is a real rendered MP4.

---

## What it does

1. **Upload a video file** (mp4, mov, webm, m4v) or paste a YouTube URL
2. AI analyzes the video and finds the best viral moments (transcript + LLM, or heuristic fallback)
3. FFmpeg renders each moment as a 9:16 vertical clip with:
   - Title text overlay
   - Hook caption overlay
   - Proper aspect ratio crop
4. Each clip gets a virality score, rationale, hooks, captions, hashtags, and platform upload guide
5. Download any clip with one click

---

## Quick start (local)

### Prerequisites

```bash
# macOS
brew install node ffmpeg yt-dlp

# Ubuntu/Debian
sudo apt install -y ffmpeg python3-pip && pip install yt-dlp
```

Node.js 20+ is required.

### Setup

```bash
git clone https://github.com/Lamarrsdrip/AI-clipping.git
cd AI-clipping
npm install
cp .env.example .env
```

Edit `.env` and fill in at minimum:
- `LLM_API_KEY` — your OpenAI or Emergent API key (for viral moment detection)

Then start:

```bash
npm start
# App runs at http://localhost:4173
```

Default login: `ava@clipforge.local` / `demo12345`

---

## Full pipeline requirements

| Requirement | Used for | How to install |
|---|---|---|
| **FFmpeg** | Rendering 9:16 clips, thumbnails, audio extraction | `brew install ffmpeg` |
| **yt-dlp** | Downloading YouTube videos for processing | `pip install yt-dlp` |
| **LLM API key** | AI viral moment detection, hooks, captions, hashtags | Set `LLM_API_KEY` |
| **YouTube API key** | Better metadata for YouTube imports (optional) | Set `YOUTUBE_API_KEY` |

File upload works without yt-dlp. Clip rendering requires FFmpeg.

---

## How clip generation works

1. **Upload** → server streams file to `storage/uploads/`, probes duration with FFmpeg, generates a thumbnail
2. **Import** → YouTube link fetches metadata via YouTube API or yt-dlp fallback
3. **Process** → server downloads source video (if YouTube), tries Whisper transcription for uploaded files, runs viral moment detection (AI + heuristic fallback)
4. **Render** → FFmpeg renders each moment as a 9:16 MP4 with drawtext captions
5. **Thumbnail** → FFmpeg extracts a still from each rendered clip
6. **Download** → clips served from `/media/clips/{id}.mp4`

---

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Public system status (ffmpeg, yt-dlp, LLM, memory) |
| `/api/session` | GET | Current user + tool readiness |
| `/api/upload` | POST | Upload a video file |
| `/api/import` | POST | Import YouTube metadata |
| `/api/process` | POST | Start clip generation job |
| `/api/job` | PATCH | Cancel / retry / delete a job |
| `/api/library` | GET | All videos, jobs, and clips |
| `/api/clip` | PATCH | Update clip metadata |
| `/api/admin/*` | Various | Admin-only: AI settings, users, billing, bank |

---

## Environment variables

See `.env.example` for full documentation. Critical ones:

```
LLM_API_KEY=           # Required: OpenAI or Emergent key
LLM_PROVIDER=openai    # openai or emergent
FFMPEG_PATH=ffmpeg     # Path to ffmpeg binary
YTDLP_PATH=yt-dlp      # Path to yt-dlp binary
```

---

## Docker (production)

```bash
docker build -t clipforge-ai .
docker run -p 4173:4173 \
  -e LLM_API_KEY=your_key \
  -e LLM_PROVIDER=openai \
  -v $(pwd)/storage:/app/storage \
  -v $(pwd)/data:/app/data \
  clipforge-ai
```

The Docker image includes FFmpeg and yt-dlp.

---

## Deploy to Render

1. Connect your GitHub repo to Render
2. Use the `render.yaml` config (already in repo)
3. Set environment variables in Render dashboard:
   - `LLM_API_KEY`
   - `LLM_PROVIDER`
   - `YOUTUBE_API_KEY` (optional)
4. Use a Docker-based service (not Node) so FFmpeg and yt-dlp are available

**Note:** Render free tier may get blocked by YouTube for direct downloads. File upload always works as a fallback.

---

## System health check

Visit **Settings** in the app to see real-time status of ffmpeg, yt-dlp, the AI provider, and memory usage.

Or call the API directly: `GET /api/health`

---

## Known limitations (MVP)

- No auto-posting to TikTok/Instagram/YouTube. Download clips and post manually.
- JSON file database (`data/db.json`) — fine for MVP, switch to Postgres for scale
- Whisper transcription for uploads requires an OpenAI-compatible API key

---

## Version history

- **v2.0.0** (2026-06) — Full rebuild: clip thumbnails, Whisper transcription for uploads, fixed download gate, system health endpoint, improved UI
- **v0.1.x** — Initial Codex build

---

## Tech stack

- Node.js (no framework) — `server.js`
- Vanilla JS SPA — `public/app.js`
- FFmpeg for video rendering
- yt-dlp for YouTube downloads
- OpenAI-compatible LLM for viral moment detection
- OpenAI Whisper for audio transcription
- JSON file database (MVP) or Postgres
