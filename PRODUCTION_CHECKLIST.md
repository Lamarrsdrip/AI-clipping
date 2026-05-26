# Production Checklist

## App

- [ ] Private login credentials changed.
- [ ] Public signup policy confirmed.
- [ ] `.env` configured.
- [ ] `ffmpeg` installed on server.
- [ ] `yt-dlp` installed on server.
- [ ] LLM provider configured and Test AI passes.
- [ ] YouTube Data API key configured.

## Database

- [ ] Postgres created.
- [ ] Migrations applied.
- [ ] Local JSON storage replaced by Postgres adapter.
- [ ] Backups enabled.

## Storage

- [ ] R2/S3 bucket created.
- [ ] Upload adapter implemented.
- [ ] Public/download URLs secured.
- [ ] Large local files excluded from git.

## Safety

- [ ] Originality checklist required before download.
- [ ] Rights/reuse confirmation required before processing.
- [ ] Source credit field available.
- [ ] Commentary/transformation controls available.
- [ ] No copyright bypass/evasion features.

## Deployment

- [ ] Railway/Render service created.
- [ ] Domain connected.
- [ ] HTTPS enabled.
- [ ] Health check added.
- [ ] Logs monitored.

## GitHub

- [ ] `.env` ignored.
- [ ] `storage/` outputs ignored.
- [ ] `data/db.json` ignored.
- [ ] Initial commit created.
- [ ] Remote repo added.
- [ ] Push completed.
