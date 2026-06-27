# ClipForge AI — v3.0.0

AI-powered video clipping SaaS powered by **Google Gemini**. Upload a video or paste a YouTube link → Gemini watches the actual video and finds the best viral moments → FFmpeg renders 9:16 vertical clips with professional captions → download and post.

No auto-posting. No fake demo clips. Every clip is a real rendered MP4.

---

## AI Brain: Google Gemini (Free)

ClipForge AI uses **Google Gemini 2.0 Flash** as the primary AI provider.

**Why Gemini:**
- **Free tier** — 1,500 requests/day, 15 req/min, no credit card required
- **Video understanding** — Gemini watches the actual video file (not just text transcript)
- **1M token context** — can analyze full transcripts without truncation
- **Structured JSON output** — guaranteed parseable responses every time
- **Multimodal** — understands faces, expressions, energy, visual props

**What Gemini powers:**
| Feature | How Gemini helps |
|---|---|
| Viral clip detection | Watches the video directly — sees facial expressions, energy, speaker changes |
| Clip selection (3 different sections) | Enforces temporal diversity across the full video |
| Hook generation | 6-style hooks per clip (curiosity, shock, value, story, controversy, sales) |
| Title generation | Platform-optimized titles for TikTok, YouTube, Instagram |
| Descriptions | Native captions for every major platform |
| Hashtag generation | Platform-specific hashtag sets |
| Thumbnail ideas | Vivid visual description + text overlay suggestion |
| B-roll suggestions | Specific search queries for stock footage |
| Sound effect suggestions | Mood-matched audio cues |
| Transcript fallback | Audio transcription when no Whisper key is available |
| QA review | Post-render quality check for every exported clip |

---

## Getting your free Gemini API key

1. Go to **[aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)**
2. Sign in with your Google account
3. Click **Create API key**
4. Copy the key (starts with `AIza...`)
5. Paste it in the admin dashboard → **Gemini AI** section, or add it to `.env`:
   ```
   GEMINI_API_KEY=AIzaSy...
   AI_PROVIDER=gemini
   ```

**Free tier limits (as of 2025):**
- 15 requests per minute
- 1,500 requests per day
- 1,000,000 tokens per minute
- No credit card required

**Important — privacy notice:** When Gemini video analysis is enabled, uploaded videos are temporarily sent to Google's File API for analysis and **automatically deleted** after processing (48-hour maximum TTL). Do not use Gemini video analysis for sensitive/private content unless you have user consent. You can disable video analysis and use transcript-only mode by setting `AI_PROVIDER=openai` with a fallback LLM key.

---

## What it does

1. **Upload a video file** (mp4, mov, webm, m4v) or paste a YouTube URL
2. Gemini analyzes the video (or transcript) and finds the best viral moments
3. FFmpeg renders each moment as a 9:16 vertical clip with:
   - Professional karaoke captions (word-by-word, emphasis detection)
   - Face-tracked framing with natural composition
   - Optional brand watermark
4. Gemini generates rich metadata: titles, descriptions, hashtags, thumbnail ideas
5. Gemini QA reviews each clip for quality and platform readiness
6. Download any clip with one click

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
- `GEMINI_API_KEY` — your free Google Gemini key from [aistudio.google.com](https://aistudio.google.com/app/apikey)

Everything else is optional. Gemini handles viral detection, hooks, titles, hashtags, and QA without any other API key.

Then start:

```bash
npm start
# App runs at http://localhost:4173
```

Default login: `ava@clipforge.local` / `demo12345`

---

## Full pipeline requirements

| Requirement | Used for | How to get |
|---|---|---|
| **FFmpeg** | Rendering 9:16 clips, thumbnails, audio extraction | `brew install ffmpeg` |
| **yt-dlp** | Downloading YouTube videos for processing | `pip install yt-dlp` |
| **GEMINI_API_KEY** | Viral detection, hooks, titles, hashtags, QA, video analysis | Free at [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **LLM_API_KEY** (optional) | Whisper word-level transcription (better caption timing) | OpenAI or Groq key |
| **YOUTUBE_API_KEY** (optional) | Better metadata for YouTube imports | Google Cloud Console |

File upload works without yt-dlp. Clip rendering requires FFmpeg. Gemini is free and replaces all paid LLM providers for the AI reasoning layer.

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

Copy `.env.example` to `.env` and configure:

```bash
# ── PRIMARY AI BRAIN (free) ──────────────────────────────────
GEMINI_API_KEY=AIzaSy...      # Get free key at aistudio.google.com/app/apikey
AI_PROVIDER=gemini             # Use gemini as the primary AI brain

# ── OPTIONAL: Whisper transcription (better caption word timing) ──
LLM_PROVIDER=openai            # openai | groq | xai | emergent
LLM_API_KEY=sk-...             # OpenAI key enables Whisper word-level timestamps
LLM_MODEL=gpt-4o-mini          # Model for fallback chat (Gemini handles most tasks)

# ── TOOLS ────────────────────────────────────────────────────
FFMPEG_PATH=ffmpeg             # Path to ffmpeg binary
YTDLP_PATH=yt-dlp              # Path to yt-dlp binary
YOUTUBE_API_KEY=               # Optional: YouTube Data API v3

# ── MEDIA GENERATION (optional paid features) ────────────────
MUAPI_API_KEY=                 # muapi.ai — Kling, Seedance, FLUX, Wav2Lip
HIGGSFIELD_API_KEY=            # higgsfield.ai — cinematic video
ELEVENLABS_API_KEY=            # ElevenLabs — AI voiceover
```

**Note:** `GEMINI_API_KEY` is the only key needed for full AI functionality. All other keys are optional enhancements.

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
