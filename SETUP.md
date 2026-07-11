# Local Setup

## 1. Run the Private MVP

```sh
cd /Users/libertyelectronics/ai-clip-saas
node server.js
```

Open:

```txt
http://127.0.0.1:4173
```

Login:

```txt
Email: ava@clipforge.local
Password: demo12345
```

## 2. Enable Real Clip Generation

Install media tools:

```sh
brew install ffmpeg yt-dlp
```

Create env file:

```sh
cp .env.example .env
```

Edit `.env`:

```txt
YOUTUBE_API_KEY=your_youtube_data_api_key
GEMINI_API_KEY=your_gemini_api_key
AI_PROVIDER=gemini
GEMINI_MODEL=gemini-2.5-flash-lite
```

Restart:

```sh
node server.js
```

## 3. Workflow

1. Paste YouTube video/channel URL.
2. Select videos.
3. Confirm rights or valid reuse purpose.
4. Generate clips.
5. Open clip posting guide.
6. Add transformation settings.
7. Complete originality checklist.
8. Download clip.
9. Manually post to platform.

## 4. Notes

- Billing uses local bank transfer verification.
- Public signup is enabled for the web MVP.
- No TikTok/Meta/YouTube/X OAuth is needed.
- File upload works without YouTube credentials. YouTube link import needs yt-dlp and/or a YouTube Data API key.
- If Gemini and fallback LLM keys are unavailable, clip selection falls back to deterministic transcript/visual windows, but rendering still requires FFmpeg.
