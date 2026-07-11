# ClipForge AI — VPS Deployment Audit

**Date:** 2026-07-11
**Commit deployed:** `e33c7ad8` (`main`)
**Public URL:** https://173-212-249-202.sslip.io
**VPS:** `173.212.249.202` (Windows Server 2022 Datacenter)

## Verdict, up front

The platform is genuinely live and was tested end-to-end (signup → upload → transcribe → analyze → render → ffprobe-verified download) — not just a homepage check. Two things are intentionally incomplete, both flagged rather than hidden:

- No `GEMINI_API_KEY` / `LLM_API_KEY` supplied — AI viral-detection, hooks, and real transcription are dormant (the app degrades gracefully instead of crashing).
- This VPS already runs a live MetaTrader 5 / XAU trading terminal that wasn't mentioned going in. ClipForge was throttled to protect it, but a full VPS reboot test is still pending explicit confirmation before running it.

## What this VPS actually is

| | |
|---|---|
| OS | Windows Server 2022 Datacenter (build 20348) |
| CPU | AMD EPYC, 4 cores / 4 threads |
| RAM | 8 GB total (~4.6–4.9 GB free in practice) |
| Disk | 150 GB total, 133 GB free (C:) |
| GPU | None — Microsoft Basic Display Adapter only, QEMU/KVM virtual host |

**Pre-existing workload found:** a live MetaTrader 5 terminal (`terminal64.exe`) plus custom scheduled tasks (`audits`, `scripts`) — existing XAU trading EA infrastructure. Flagged before installing anything; confirmed to proceed with ClipForge throttled so the trading bot always wins resource contention.

## Architecture: simpler than the original brief assumed, on purpose

The original deployment brief sketched a Postgres + Redis + worker-fleet architecture. The actual repository is a single Node.js process — building the elaborate version anyway would have meant inventing services the app doesn't use and burning RAM this box doesn't have.

- **Backend:** one Node process (`server.js`, raw `http`, no framework), file-based DB (`data/db.json`) — the only data layer actually wired up. `DATABASE_URL`/Postgres exists only as a dormant settings flag with no query code behind it; left alone rather than half-built.
- **Jobs:** in-process queue capped at `MAX_CONCURRENT_RENDER_JOBS=1` — no Redis/BullMQ exists or is needed.
- **Video:** FFmpeg (full GPL build — libx264, libx265, libass for captions, libmp3lame) + yt-dlp, native Windows binaries.
- **Face tracking:** Python subprocess (`face_track.py`) — OpenCV Haar-cascade tier confirmed working.

**Why native Windows, not Docker:** Docker Desktop/WSL2 on Windows Server adds ~1–2 GB of VM overhead before ClipForge runs a single byte of video — a real cost on an 8 GB box already hosting a trading terminal. Node, Python, and FFmpeg run as native binaries under NSSM-managed Windows services instead, which also gives direct, reliable process-priority control.

## What's running, where

| Layer | Implementation | Location |
|---|---|---|
| Reverse proxy / HTTPS | Caddy 2.11.4 — automatic Let's Encrypt cert, HTTP→HTTPS redirect, security headers | `C:\ClipForge\Caddyfile` |
| App | Node.js 22.23.1, bound to `127.0.0.1` only | `C:\ClipForge\app` |
| Video/audio | FFmpeg N-125519 (full GPL), yt-dlp 2026.07.04 | `C:\ClipForge\runtime\ffmpeg` |
| Face tracking | Python 3.13.14 + OpenCV 5.0.0 (Haar tier) | `C:\Program Files\Python313` |
| Database | File-based (`db.json`), as designed | `C:\ClipForge\data` |
| Uploads / clips / thumbs | Persistent disk storage | `C:\ClipForge\storage` |
| Logs | Rotating (10 MB) stdout/stderr per service | `C:\ClipForge\data\logs` |
| Backups | Timestamped, 7-day retention, daily at 3am | `C:\ClipForge\backups` |
| Ops scripts | deploy / status / restart / logs / backup | `C:\ClipForge\scripts` |

No domain was on file for this project, so the public URL uses `sslip.io` (wildcard DNS resolving to the embedded IP) — Caddy issues it a genuine Let's Encrypt certificate. Point a real domain's A record at `173.212.249.202` whenever one is available to move the cert over.

## Auto-start and crash recovery

Both services run as Windows services (NSSM), `Start=Automatic`, independent of any logged-in session.

- **Verified live:** mid-deployment, the app crashed on a real bug (a `python3` shim that Windows couldn't execute directly — see below). NSSM auto-restarted it with zero manual intervention.
- `ClipForgeCaddy` depends on `ClipForgeApp`, so start order is correct after any reboot.
- **Not yet tested:** a full VPS reboot — deliberately deferred (see "Open item" below).

## Security posture

| Check | Result |
|---|---|
| `.env` requested over HTTP | PASS — 404 |
| `.git/config` requested over HTTP | PASS — 404 |
| `data/db.json` requested over HTTP | PASS — 404 |
| App port 4173 reachable from the internet | PASS — times out (bound to 127.0.0.1) |
| Admin routes without a token | PASS — 401 |
| Admin routes with a non-admin token | PASS — 403 |
| User A's media fetched by User B | PASS — 403 |
| User A's media fetched unauthenticated | PASS — 401 |
| User A's media fetched by User A (owner) | PASS — 200 |

Firewall: only ports 80 and 443 are open publicly. RDP/WinRM rules were left exactly as found. Windows Defender and existing services were untouched.

## End-to-end verification (real test, real data)

Two throwaway test accounts were created and the actual product flow was run — not a synthetic check.

| Step | Result | Evidence |
|---|---|---|
| Signup / login | PASS | Real session token issued, both endpoints 200 |
| Upload (20s MP4) | PASS | Stored to persistent disk, thumbnail generated |
| Job queued → transcribe → analyze → render | PASS | Job reached `completed` at 100%, all 6 pipeline steps green |
| Caption/hook generation quality | BLOCKED | Runs on placeholder heuristic without an AI key |
| Output inspected with ffprobe | PASS | H.264 video, 1080×1920, 60fps, AAC 48kHz, 17.0s, 1.24 MB — decodable |
| Download over HTTPS as owner | PASS | 200, file matches ffprobe output |
| Failed-job path | PASS | A mid-render crash left a real, inspectable error in logs |

### A real bug hit and fixed live

The face-tracking step spawns `python3`, which isn't a native Windows command (only `python`/`py` are). The first fix — a `python3.bat` shim — crashed the whole Node process, because Windows can't execute a batch file directly without `cmd.exe` as an interpreter, and `spawn()` doesn't provide one. Replaced with a true `python3.exe` (a direct copy of `python.exe`) plus an explicit `PATH` on the service, which resolved it.

### Face tracking tier

`mediapipe` was installed as a bonus upgrade over the Haar-cascade baseline — pip install succeeded, but it fails at import time on this headless VPS (`PortAudio` can't initialize with no sound hardware present). Face tracking runs on **OpenCV Haar-cascade**, confirmed working (v5.0.0) — the same tier currently active in the Mac dev environment.

## What's missing, honestly

**Credentials needed:** `GEMINI_API_KEY` (free at aistudio.google.com — powers viral-moment detection, hooks, titles, QA) and/or `LLM_API_KEY` (OpenAI-compatible, also used for Whisper transcription) are not set. Set either via the Admin Dashboard settings screen or in `C:\ClipForge\app\.env`, then run `restart.ps1`. Stripe, YouTube Data API, TikTok/Meta/X OAuth, and S3 storage are optional and the app already reports them as unavailable rather than failing silently.

| Feature | Status | Why |
|---|---|---|
| GPU acceleration | NOT AVAILABLE | No GPU exists on this VM — verified via device inspection |
| AI viral-moment detection, hooks, titles | BLOCKED | Needs `GEMINI_API_KEY` or `LLM_API_KEY` |
| Real Whisper transcription | BLOCKED | Same as above |
| MediaPipe face-mesh (upgrade tier) | FAIL | Installed, but `PortAudio` import fails headless — Haar tier is the working fallback |
| Billing (Stripe) | NOT CONFIGURED | `CREDITS_ENABLED=false`, no keys — by design |
| Full VPS reboot test | PENDING | Deliberately deferred |

## Operating it day to day

```powershell
# Check status
powershell -File C:\ClipForge\scripts\status.ps1

# View logs
powershell -File C:\ClipForge\scripts\logs.ps1

# Restart services
powershell -File C:\ClipForge\scripts\restart.ps1

# Back up now
powershell -File C:\ClipForge\scripts\backup.ps1

# Ship an update (backs up DB, pulls main, npm install, build check,
# restarts services, health-checks, auto-rolls-back on failure)
powershell -File C:\ClipForge\scripts\deploy.ps1
```

**Restore a backup:**
1. Stop the app: `nssm stop ClipForgeApp`
2. Copy `C:\ClipForge\backups\<timestamp>\db.json` over `C:\ClipForge\data\db.json`
3. Restart: `powershell -File C:\ClipForge\scripts\restart.ps1`

## Full verification table

| Component | Status | Evidence |
|---|---|---|
| Frontend | PASS | 200 at public HTTPS URL |
| Backend API | PASS | `/api/health` responding |
| Database | PASS | File-based, as designed — real data written and read back |
| Redis / queue | N/A | App has no such dependency — in-process queue confirmed working |
| Worker | PASS | Real job: queued → transcribed → analyzed → rendered → completed |
| FFmpeg | PASS | Version + real render output verified with ffprobe |
| GPU | NOT AVAILABLE | No GPU hardware on this VM |
| Upload | PASS | Real file, persisted to disk |
| Transcription | BLOCKED | No AI key configured |
| AI analysis | BLOCKED | No AI key configured |
| Clip generation | PASS | Final MP4 verified with ffprobe |
| Captions | BLOCKED | Pipeline exists; not exercised without an AI key |
| Download | PASS | 200, file matches ffprobe evidence |
| Authentication | PASS | Real signup + login, both 200 |
| User isolation | PASS | Cross-user media fetch → 403 |
| Admin protection | PASS | No token → 401; non-admin token → 403 |
| Analytics | PASS | Library/dashboard reflects real job + video state |
| Automatic restart | PASS | NSSM auto-restarted the app after a real crash |
| Database backup | PASS | Real file created; daily 3am scheduled task registered |
| HTTPS | PASS | Valid Let's Encrypt certificate, redirect confirmed |
| Full end-to-end flow | PASS | Signup → upload → render → ffprobe-verified download |
| Full VPS reboot survival | PENDING | Not performed — awaiting confirmation given the live trading terminal |

## Open item: full VPS reboot

The deployment brief asks for verification that the platform survives a full VPS restart, and there's solid indirect evidence it will (services are `Automatic`, dependency order is correct, crash-recovery is proven). But a full reboot is the most disruptive, hardest-to-reverse action available here, and this box runs a live trading terminal that wasn't mentioned going in — it's unknown whether MT5 has its own auto-start configured. This was deliberately not performed without explicit confirmation of a safe time.

---

*Deployment directory: `C:\ClipForge` · Services: `ClipForgeApp`, `ClipForgeCaddy` (NSSM) · Repo: github.com/Lamarrsdrip/AI-clipping @ `main`, commit `e33c7ad8` — no app code was changed; deployment config lives on the VPS rather than in this repo since it's host-specific.*
