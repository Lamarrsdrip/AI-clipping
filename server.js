import http from 'node:http';
import { createHash, createHmac, randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import Busboy from 'busboy';
import {
  GEMINI_COMPAT_BASE, GEMINI_FLASH, GEMINI_MODEL_CASCADE,
  parseGemini429, isGemini503, geminiUserMessage,
  geminiUploadFile, geminiDeleteFile, geminiGenerateWithFile, geminiGenerateText, geminiTranscribeFile,
} from './ai/providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.CLIPFORGE_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STORAGE_DIR = process.env.CLIPFORGE_STORAGE_DIR || path.join(__dirname, 'storage');
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || (() => {
  if (/ffmpeg(?:\.exe)?$/i.test(FFMPEG)) return FFMPEG.replace(/ffmpeg(?:\.exe)?$/i, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return 'ffprobe';
})();
const CREDITS_ENABLED = process.env.CREDITS_ENABLED !== 'false';
const CLIP_JOB_CREDIT_COST = Number(process.env.CLIP_JOB_CREDIT_COST || 5);
const MIN_CLIP_SOURCE_SECONDS = Number(process.env.MIN_CLIP_SOURCE_SECONDS || 15);
const IMPORT_RATE_LIMIT_MS = Number(process.env.IMPORT_RATE_LIMIT_MS || 8000);
const YTDLP_BLOCK_COOLDOWN_MS = Number(process.env.YTDLP_BLOCK_COOLDOWN_MS || 15 * 60 * 1000);
const YTDLP_COOKIES_PATH = process.env.YTDLP_COOKIES_PATH || path.join(DATA_DIR, 'youtube_cookies.txt');
// Clients tried, in order, when YouTube's bot-check blocks the default client. Each only
// runs if the previous attempt failed specifically with a bot-check error (not other failures).
const YOUTUBE_CLIENT_FALLBACKS = ['android_vr', 'ios', 'web_safari', 'tv_embedded'];
// Last-resort fallback: a reverse SSH tunnel from a residential machine (opened from
// that machine's side, not this server's) can expose a local SOCKS proxy here. When
// present, YouTube sees that machine's IP instead of this server's datacenter IP for
// the one request that needed it — everything else still goes direct. Optional by
// design: if nothing is listening, this is skipped with no effect on normal imports.
const YTDLP_PROXY_HOST = process.env.YTDLP_PROXY_HOST || '127.0.0.1';
const YTDLP_PROXY_PORT = Number(process.env.YTDLP_PROXY_PORT || 1080);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 300 * 1024 * 1024);
const MAX_CONCURRENT_RENDER_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_RENDER_JOBS || 1));
const PROCESS_TIMEOUT_MS = Number(process.env.PROCESS_TIMEOUT_MS || 10 * 60 * 1000);
const JOB_STALE_MS = Number(process.env.JOB_STALE_MS || 12 * 60 * 1000);
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45 * 1000);
const MAX_RSS_MB = Number(process.env.MAX_RSS_MB || 420);
const RENDER_WIDTH = Number(process.env.RENDER_WIDTH || 720);
const RENDER_HEIGHT = Number(process.env.RENDER_HEIGHT || 1280);
const TRANSCRIPTION_CHUNK_SECONDS = Math.max(120, Number(process.env.TRANSCRIPTION_CHUNK_SECONDS || 600));
const DIGITAL_SILENCE_MAX_DB = Number(process.env.DIGITAL_SILENCE_MAX_DB || -89);
const MIN_AUDIBLE_AUDIO_BITRATE = Number(process.env.MIN_AUDIBLE_AUDIO_BITRATE || 16000);
const STORAGE_RETENTION_DAYS = Math.max(1, Number(process.env.STORAGE_RETENTION_DAYS || 3));
const STORAGE_CLEANUP_INTERVAL_MS = Math.max(15 * 60 * 1000, Number(process.env.STORAGE_CLEANUP_INTERVAL_MS || 60 * 60 * 1000));
const importAttempts = new Map();
const importUserAttempts = new Map(); // userId → [timestamps] for rate-limiting by user
const ytdlpBlock = { until: 0, reason: '' };
let activeRenderJobs = 0;
const renderQueue = [];
const activeJobProcesses = new Map();

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(path.join(DATA_DIR, 'tmp'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'originals'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'clips'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'uploads'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'thumbs'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'transcripts'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'thumbnails'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'generations'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'audio'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'logos'), { recursive: true });

const seed = {
  users: [{
    id: 'user_demo',
    name: 'Ava Morgan',
    email: 'ava@clipforge.local',
    passwordHash: hashPassword('demo12345'),
    plan: 'Creator',
    credits: 120,
    role: 'admin',
    onboardingComplete: false,
    defaults: { captionStyle: 'Bold captions', platforms: ['TikTok', 'YouTube Shorts'] },
    createdAt: new Date().toISOString()
  }],
  subscriptions: [{
    id: 'sub_demo',
    userId: 'user_demo',
    planId: 'pro',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString()
  }],
  creditTransactions: [],
  projects: [],
  imports: [],
  videos: [],
  jobs: [],
  clips: [],
  scheduledPosts: [],
  socialAccounts: [],
  watchedChannels: [],
  apiSettings: [],
  aiLogs: [],
  importCache: [],
  bankAccounts: [{
    id: 'bank_default',
    bankName: 'Set bank name in Admin',
    accountName: 'Set account name',
    accountNumber: '0000000000',
    instructions: 'Transfer payment, then submit the reference for admin verification.',
    active: true,
    updatedAt: new Date().toISOString()
  }],
  paymentRequests: [],
  billingPlans: defaultPlans(),
  usageEvents: [],
  transcriptions: [],
  studioGenerations: [],
  audioGenerations: [],
  seriesJobs: [],
  seriesParts: [],
  storageCleanupRuns: []
};

const PLATFORMS = ['TikTok', 'YouTube Shorts', 'Instagram Reels', 'Facebook Reels', 'X'];

function postingAssistant(title, hook, platform = 'TikTok') {
  const hashtags = ['#shorts', '#reels', '#viralclips', '#creator', '#fyp'];
  return {
    suggestedTitle: hook || title,
    caption: `${hook || title}\n\nSave this if you want the full breakdown.`,
    hashtags,
    bestPlatform: platform,
    bestTime: '6:00 PM - 9:00 PM local time',
    firstComment: 'Full video source linked in bio / channel. What part should we clip next?',
    instructions: {
      TikTok: ['Download the MP4.', 'Open TikTok and tap +.', 'Upload the video.', 'Paste caption and hashtags.', 'Choose cover frame and post.'],
      'Instagram Reels': ['Download the MP4.', 'Open Instagram and create a Reel.', 'Upload the video.', 'Paste caption and hashtags.', 'Share to Reels.'],
      'Facebook Reels': ['Download the MP4.', 'Open Facebook Reels.', 'Upload the video.', 'Paste caption and hashtags.', 'Publish to your Page or profile.'],
      'YouTube Shorts': ['Download the MP4.', 'Open YouTube Studio or app.', 'Upload as a Short.', 'Paste title/caption and hashtags.', 'Publish.'],
      X: ['Download the MP4.', 'Create a new post on X.', 'Attach the video.', 'Paste caption and hashtags.', 'Post.']
    },
    checklist: [
      { id: 'download', label: 'Download video', done: false },
      { id: 'caption', label: 'Copy caption', done: false },
      { id: 'hashtags', label: 'Copy hashtags', done: false },
      { id: 'upload', label: 'Upload to platform', done: false },
      { id: 'paste', label: 'Paste caption', done: false },
      { id: 'post', label: 'Post', done: false },
      { id: 'mark', label: 'Mark as posted', done: false }
    ],
    posted: false
  };
}

function defaultTransformation(title = '') {
  return {
    introHookText: title ? `Here is the key idea: ${title}`.slice(0, 96) : '',
    summaryOverlay: 'AI summary overlay will be generated from the transcript.',
    captionStyle: 'Bold captions',
    sourceCredit: '',
    watermarkText: 'My Brand',
    splitScreenCommentary: false,
    voiceoverFilename: '',
    verticalFrame: 'Blurred background',
    effects: ['Zoom cuts', 'Highlight keywords'],
    brollPlaceholders: ['Add relevant screenshot', 'Add product/page visual'],
    editMode: 'Smart cut',
    pacingStyle: 'Fast TikTok cut',
    creatorVoice: 'Direct, clear, high-retention hooks',
    originalityChecklist: [
      { id: 'commentary', label: 'Added commentary or context', done: false },
      { id: 'captions', label: 'Added captions', done: true },
      { id: 'hook', label: 'Added own hook/title', done: true },
      { id: 'branding', label: 'Added branding/watermark', done: false },
      { id: 'credit', label: 'Added source credit if needed', done: false },
      { id: 'rights', label: 'I confirm I have rights or a valid reuse purpose', done: false }
    ]
  };
}

function buildViralIntelligence(video, moment, hook, index = 0) {
  const duration = Math.max(1, Math.round((moment.end || 0) - (moment.start || 0)));
  const score = Number(moment.score || 75);
  const reason = moment.reason || 'educational';
  const hookStrength = Math.min(10, Math.max(5, Math.round(score / 10)));
  const emotionalPunch = ['emotional', 'controversial', 'surprising'].includes(reason) ? 9 : 7;
  const shareability = ['controversial', 'actionable', 'surprising'].includes(reason) ? 9 : 7;
  const retentionRisk = duration > 45 ? 'Watch for a slow middle section. Use smart cut to tighten pacing.' : 'Low risk. Clip is short enough for strong retention.';
  const baseHook = hook || 'Watch this before you scroll';
  return {
    viralRecipe: {
      hookStrength,
      controversy: reason === 'controversial' ? 9 : 5,
      emotionalPunch,
      shareability,
      clarity: reason === 'educational' || reason === 'actionable' ? 9 : 7,
      retentionRisk
    },
    hookBattle: [
      baseHook,
      `Nobody talks about this part of ${video.channelTitle || 'the story'}`,
      `This is the moment most people miss`,
      `Watch this before you make the same mistake`,
      `The ending changes the whole point`,
      `This explains why it actually worked`,
      `Most people get this completely wrong`,
      `Here is the part that matters`,
      `This one detail changed everything`,
      `Save this before you forget it`
    ].map((text, rank) => ({ text: text.slice(0, 96), rank: rank + 1, score: Math.max(70, score - rank * 2) })),
    retentionTimeline: [
      { range: '0-3s', label: 'Hook', note: hookStrength >= 8 ? 'Strong scroll-stopper.' : 'Needs a sharper opening.' },
      { range: '4-12s', label: 'Context', note: 'Add context overlay so viewers understand fast.' },
      { range: '13-25s', label: 'Proof', note: 'Keep only the sentence that proves the hook.' },
      { range: 'Final 5s', label: 'Payoff', note: 'End on the strongest line, not a fade-out.' }
    ],
    smartEditPlan: {
      mode: duration > 35 ? 'Cut and join' : 'Smart trim',
      removedDeadAirSeconds: duration > 35 ? 2 : 0,
      segments: duration > 35 ? [
        { start: moment.start, end: Math.min(moment.start + 14, moment.end), label: 'hook/context' },
        { start: Math.min(moment.start + 16, moment.end - 8), end: moment.end, label: 'proof/payoff' }
      ] : [{ start: moment.start, end: moment.end, label: 'full moment' }],
      fillerWordsRemoved: ['um', 'uh', 'you know', 'like'],
      zoomCuts: [
        { at: 1.2, amount: '108%' },
        { at: Math.min(8, duration / 2), amount: '114%' }
      ]
    },
    platformVariants: [
      { platform: 'TikTok', edit: 'Fast hook, bigger captions, 24-35s target', scoreBoost: '+8%' },
      { platform: 'YouTube Shorts', edit: 'Clearer title, less slang, 35-55s target', scoreBoost: '+5%' },
      { platform: 'Instagram Reels', edit: 'Cleaner captions, visual polish, saveable caption', scoreBoost: '+6%' },
      { platform: 'X', edit: 'More context in title, direct first sentence', scoreBoost: '+4%' }
    ],
    originalityBooster: {
      score: 62,
      upgrades: [
        { label: 'Add commentary or personal take', boost: 15 },
        { label: 'Add source credit', boost: 5 },
        { label: 'Add brand watermark', boost: 8 },
        { label: 'Add AI summary overlay', boost: 10 }
      ]
    },
    brollPrompts: [
      `Fast visual showing the main idea from: ${video.title}`.slice(0, 120),
      'Close-up of analytics or comments proving the point',
      'Screenshot-style overlay highlighting the key phrase',
      'Quick reaction shot or split-screen commentary placeholder'
    ],
    clipSeries: [
      { part: 1, title: 'The hook', angle: 'Problem or surprising claim' },
      { part: 2, title: 'The proof', angle: 'Why the claim matters' },
      { part: 3, title: 'The lesson', angle: 'What viewers should do next' }
    ],
    learningTracker: {
      status: 'Ready after posting',
      metrics: ['views', 'saves', 'shares', 'comments', 'watch-through estimate'],
      note: 'Enter results after posting so the app can learn which hooks perform best.'
    },
    creatorVoiceMemory: {
      tone: 'Direct, energetic, useful',
      captionPreference: 'Bold captions with highlighted keywords',
      defaultCTA: 'Save this and post your take.'
    }
  };
}

// Legacy unsalted hash — kept only to verify passwords hashed before the scrypt migration.
function hashPasswordLegacy(password = '') {
  return createHash('sha256').update(`clipforge:${password}`).digest('hex');
}

// scrypt with a random per-user salt. Format: "scrypt:<saltHex>:<hashHex>"
function hashPassword(password = '', salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash = '') {
  if (storedHash.startsWith('scrypt:')) {
    const [, salt, hash] = storedHash.split(':');
    const candidate = scryptSync(password || '', salt, 64);
    const stored = Buffer.from(hash, 'hex');
    return candidate.length === stored.length && timingSafeEqual(candidate, stored);
  }
  // Legacy account — verify against the old unsalted hash for one last login.
  return storedHash === hashPasswordLegacy(password);
}

function defaultPlans() {
  return [
    { id: 'free',    name: 'Free',    monthlyPrice: 0,   creditsIncluded: 15,   maxVideoLength: 20,  maxClipsPerVideo: 3,    autoWatchAllowed: false, autoPostAllowed: false },
    { id: 'pro',     name: 'Pro',     monthlyPrice: 19,  creditsIncluded: 300,  maxVideoLength: 90,  maxClipsPerVideo: 8,    autoWatchAllowed: true,  autoPostAllowed: false },
    { id: 'creator', name: 'Creator', monthlyPrice: 49,  creditsIncluded: 800,  maxVideoLength: 180, maxClipsPerVideo: 20,   autoWatchAllowed: true,  autoPostAllowed: false },
    { id: 'studio',  name: 'Studio',  monthlyPrice: 99,  creditsIncluded: 1500, maxVideoLength: 600, maxClipsPerVideo: 100,  autoWatchAllowed: true,  autoPostAllowed: true  },
    { id: 'agency',  name: 'Agency',  monthlyPrice: 149, creditsIncluded: 2500, maxVideoLength: 999, maxClipsPerVideo: 9999, autoWatchAllowed: true,  autoPostAllowed: true  }
  ];
}

const API_SETTING_META = [
  ['YOUTUBE_API_KEY', 'YouTube Data API key'],
  ['GEMINI_API_KEY', 'Google Gemini API key — free at aistudio.google.com (powers viral detection, hooks, titles, hashtags, QA, and direct video analysis)'],
  ['GEMINI_MODEL', 'Gemini model to use (default: gemini-2.5-flash-lite). Options: gemini-2.5-flash-lite | gemini-2.5-flash | gemini-1.5-flash | gemini-1.5-flash-8b'],
  ['AI_PROVIDER', 'Primary AI brain: gemini | openai | groq | xai | emergent (default: gemini when GEMINI_API_KEY is set)'],
  ['LLM_PROVIDER', 'Fallback LLM provider (openai | groq | xai | together | emergent) — used when Gemini is unavailable'],
  ['LLM_API_KEY', 'Fallback LLM API key — also used for Whisper transcription if set'],
  ['LLM_BASE_URL', 'Fallback LLM OpenAI-compatible base URL'],
  ['LLM_MODEL', 'Fallback LLM model'],
  ['LLM_FALLBACK_PROVIDER', 'Secondary fallback LLM provider'],
  ['LLM_FALLBACK_API_KEY', 'Secondary fallback LLM API key'],
  ['LLM_FALLBACK_BASE_URL', 'Secondary fallback LLM base URL'],
  ['LLM_FALLBACK_MODEL', 'Secondary fallback LLM model'],
  ['MUAPI_API_KEY', 'Muapi.ai API key (text-to-video, image-to-video, FLUX, Kling, Seedance)'],
  ['DIGITAL_HUMAN_STUDIO_URL', 'Digital Human Studio URL (default: http://localhost:4200)'],
  ['HIGGSFIELD_API_KEY', 'Higgsfield AI API key (cinematic video & image generation)'],
  ['ELEVENLABS_API_KEY', 'ElevenLabs API key (AI voiceover / TTS)'],
  ['STRIPE_SECRET_KEY', 'Stripe secret key'],
  ['STRIPE_WEBHOOK_SECRET', 'Stripe webhook secret'],
  ['S3_ENDPOINT', 'Cloudflare R2/S3 endpoint'],
  ['S3_BUCKET', 'Cloudflare R2/S3 bucket'],
  ['S3_ACCESS_KEY_ID', 'Cloudflare R2/S3 access key'],
  ['S3_SECRET_ACCESS_KEY', 'Cloudflare R2/S3 secret key'],
  ['DATABASE_URL', 'Database URL']
];

function loadDb() {
  if (!existsSync(DB_FILE)) writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
  const db = JSON.parse(readFileSync(DB_FILE, 'utf8'));
  if (!Array.isArray(db.subscriptions)) db.subscriptions = [];
  if (!Array.isArray(db.creditTransactions)) db.creditTransactions = [];
  if (!Array.isArray(db.projects)) db.projects = [];
  if (!Array.isArray(db.scheduledPosts)) db.scheduledPosts = [];
  if (!Array.isArray(db.socialAccounts)) db.socialAccounts = [];
  if (!Array.isArray(db.watchedChannels)) db.watchedChannels = [];
  if (!Array.isArray(db.apiSettings)) db.apiSettings = [];
  if (!Array.isArray(db.aiLogs)) db.aiLogs = [];
  if (!Array.isArray(db.importCache)) db.importCache = [];
  if (!Array.isArray(db.bankAccounts)) db.bankAccounts = seed.bankAccounts;
  if (!Array.isArray(db.paymentRequests)) db.paymentRequests = [];
  if (!Array.isArray(db.billingPlans)) db.billingPlans = defaultPlans();
  if (!Array.isArray(db.usageEvents)) db.usageEvents = [];
  if (!Array.isArray(db.studioGenerations)) db.studioGenerations = [];
  if (!Array.isArray(db.transcriptions)) db.transcriptions = [];
  if (!Array.isArray(db.audioGenerations)) db.audioGenerations = [];
  if (!Array.isArray(db.seriesJobs)) db.seriesJobs = [];
  if (!Array.isArray(db.seriesParts)) db.seriesParts = [];
  if (!Array.isArray(db.storageCleanupRuns)) db.storageCleanupRuns = [];
  if (!Array.isArray(db.brandKits)) db.brandKits = [];
  for (const user of db.users) {
    if (!user.role) user.role = user.email === 'ava@clipforge.local' ? 'admin' : 'user';
    if (!user.passwordHash) user.passwordHash = hashPassword('demo12345');
    if (!user.defaults) user.defaults = { captionStyle: 'Bold captions', platforms: ['TikTok'] };
    if (user.onboardingComplete === undefined) user.onboardingComplete = false;
  }
  for (const [key, label] of API_SETTING_META) {
    if (!db.apiSettings.find(item => item.key === key)) {
      db.apiSettings.push({ key, label, value: process.env[key] || '', updatedAt: null });
    }
  }
  return db;
}

function saveDb(db) {
  if (!Array.isArray(db.subscriptions)) db.subscriptions = [];
  if (!Array.isArray(db.creditTransactions)) db.creditTransactions = [];
  if (!Array.isArray(db.projects)) db.projects = [];
  if (!Array.isArray(db.scheduledPosts)) db.scheduledPosts = [];
  if (!Array.isArray(db.socialAccounts)) db.socialAccounts = [];
  if (!Array.isArray(db.watchedChannels)) db.watchedChannels = [];
  if (!Array.isArray(db.apiSettings)) db.apiSettings = [];
  if (!Array.isArray(db.aiLogs)) db.aiLogs = [];
  if (!Array.isArray(db.importCache)) db.importCache = [];
  if (!Array.isArray(db.bankAccounts)) db.bankAccounts = seed.bankAccounts;
  if (!Array.isArray(db.paymentRequests)) db.paymentRequests = [];
  if (!Array.isArray(db.billingPlans)) db.billingPlans = defaultPlans();
  if (!Array.isArray(db.usageEvents)) db.usageEvents = [];
  if (!Array.isArray(db.studioGenerations)) db.studioGenerations = [];
  if (!Array.isArray(db.transcriptions)) db.transcriptions = [];
  if (!Array.isArray(db.audioGenerations)) db.audioGenerations = [];
  if (!Array.isArray(db.seriesJobs)) db.seriesJobs = [];
  if (!Array.isArray(db.seriesParts)) db.seriesParts = [];
  if (!Array.isArray(db.storageCleanupRuns)) db.storageCleanupRuns = [];
  if (!Array.isArray(db.brandKits)) db.brandKits = [];
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// db.json has no row-level locking. A handler that does `loadDb() → await someSlowCall() →
// saveDb(db)` is writing back a snapshot that can already be stale if another request wrote
// in between, silently clobbering that write (e.g. two concurrent renders each editing a
// different clip's fields both save the *whole* file, so whichever finishes last wins and
// the other request's change is lost even though they touched different records).
// dbMutation() gives call sites a way to opt into a serialized critical section: only one
// dbMutation() body runs at a time, and it always starts from the freshest on-disk state,
// so a fetch-mutate-save spanning an await can no longer lose a concurrent write. This does
// not replace a real database with row-level transactions (tracked as future work), but it
// closes the specific lost-update class for any call site that adopts it.
let _dbMutationChain = Promise.resolve();
function dbMutation(fn) {
  const run = _dbMutationChain.then(async () => {
    const db = loadDb();
    const result = await fn(db);
    saveDb(db);
    return result;
  });
  // Keep the chain alive even if this mutation throws, so later queued mutations still run.
  _dbMutationChain = run.catch(() => {});
  return run;
}

// ─── Session tokens ─────────────────────────────────────────────────────────
// HMAC-signed bearer tokens replace the old unsigned x-user-id header, which let
// anyone who obtained a user's UUID impersonate them. Secret is provided via
// SESSION_SECRET, or auto-generated once and persisted in db.json (gitignored)
// so tokens stay valid across restarts without requiring a new deploy env var.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_SECRET = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const db = loadDb();
  if (!db.meta) db.meta = {};
  if (!db.meta.sessionSecret) {
    db.meta.sessionSecret = randomBytes(32).toString('hex');
    saveDb(db);
  }
  return db.meta.sessionSecret;
})();

function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token = '') {
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig), expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.userId || !data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, apiJsonReplacer);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs: rawTimeoutMs, maxOutputBytes: rawMaxOutputBytes, jobId, label, ...spawnOptions } = options;
    const parts = String(command).trim().split(/\s+/).filter(Boolean);
    const executable = parts.shift();
    if (!executable) return reject(new Error('No command provided.'));
    const startedAt = Date.now();
    const commandLabel = label || command;
    // Log the complete command so filter chains can be audited
    console.log(`[process:start] ${commandLabel}`, { jobId: jobId || '', fullCommand: `${executable} ${[...parts, ...args].join(' ')}`, memory: memorySnapshot() });
    const child = spawn(executable, [...parts, ...args], { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    if (jobId) {
      if (!activeJobProcesses.has(jobId)) activeJobProcesses.set(jobId, new Set());
      activeJobProcesses.get(jobId).add(child);
    }
    let stdout = '';
    let stderr = '';
    const maxOutput = Number(rawMaxOutputBytes || 1024 * 1024);
    const timeoutMs = Number(rawTimeoutMs || PROCESS_TIMEOUT_MS);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (jobId) {
        const set = activeJobProcesses.get(jobId);
        if (set) {
          set.delete(child);
          if (!set.size) activeJobProcesses.delete(jobId);
        }
      }
      fn(value);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`${commandLabel} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs) : null;
    child.stdout.on('data', chunk => {
      if (stdout.length < maxOutput) stdout += chunk.toString().slice(0, maxOutput - stdout.length);
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < maxOutput) stderr += chunk.toString().slice(0, maxOutput - stderr.length);
    });
    child.on('error', error => {
      finish(reject, error);
    });
    child.on('close', code => {
      const durationMs = Date.now() - startedAt;
      console.log(`[process:exit] ${commandLabel}`, { jobId: jobId || '', code, durationMs, memory: memorySnapshot() });
      if (code === 0) finish(resolve, { stdout, stderr, durationMs });
      else finish(reject, new Error(stderr || `${commandLabel} exited with ${code}`));
    });
  });
}

function killActiveJobProcesses(jobId) {
  const set = activeJobProcesses.get(jobId);
  if (!set?.size) return 0;
  let killed = 0;
  for (const child of set) {
    try {
      child.kill('SIGKILL');
      killed += 1;
    } catch {}
  }
  activeJobProcesses.delete(jobId);
  return killed;
}

function cancelQueuedRenderJobsForVideo(videoId, message = 'Job cancelled because the source video was deleted.') {
  let cancelled = 0;
  for (let i = renderQueue.length - 1; i >= 0; i -= 1) {
    if (renderQueue[i]?.payload?.videoId !== videoId) continue;
    const [item] = renderQueue.splice(i, 1);
    item.reject(new Error(message));
    cancelled += 1;
  }
  return cancelled;
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    externalMb: Math.round(usage.external / 1024 / 1024),
    queueDepth: renderQueue.length,
    activeRenderJobs
  };
}

function logMemory(label) {
  console.log(`[memory] ${label}`, memorySnapshot());
}

function assertMemoryAvailable() {
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (rssMb >= MAX_RSS_MB) {
    throw new Error(`Server memory is high (${rssMb}MB). Try again in a minute or use a smaller video.`);
  }
}

const JOB_RUNNING_MAX_MS = Number(process.env.JOB_RUNNING_MAX_MS || 30 * 60 * 1000); // 30 minutes hard cap for running jobs

function recoverStaleJobs(reason = 'startup') {
  const db = loadDb();
  const now = Date.now();
  let changed = 0;
  for (const job of db.jobs) {
    if (!['queued', 'running'].includes(job.status)) continue;
    const last = Date.parse(job.updatedAt || job.createdAt || 0) || 0;
    const created = Date.parse(job.createdAt || 0) || last;
    const startedAt = Date.parse(job.startedAt || 0) || created;
    // A queued/running job that hasn't been updated in JOB_STALE_MS is stale
    const isStaleByUpdate = now - last > JOB_STALE_MS;
    // Full Series jobs legitimately run for as long as totalParts * per-part-render-time —
    // a 10-part series at ~5 real minutes per part is 50+ minutes of genuine, healthy work,
    // and each completed part refreshes `updatedAt`. The flat 30-minute runtime cap and the
    // ~22-minute creation-age cap below were tuned for short Viral Clips jobs; applying them
    // to series jobs killed real, actively-progressing renders (reproduced during testing: a
    // job that had successfully rendered 4 of 8 parts was killed here mid-part-5 even though
    // it was still making progress). Series jobs rely on isStaleByUpdate alone — no activity
    // for JOB_STALE_MS is still a genuine hang and gets caught.
    const isSeriesJob = ['series', 'full_series', 'full-video-series'].includes(String(job.payload?.workflowMode || '').toLowerCase());
    // A running job that has been running for > 30 minutes is definitely stuck
    const isStaleByRuntime = !isSeriesJob && job.status === 'running' && now - startedAt > JOB_RUNNING_MAX_MS;
    // A job created longer ago than PROCESS_TIMEOUT_MS + JOB_STALE_MS with no activity
    const isStaleByCreation = !isSeriesJob && now - created > PROCESS_TIMEOUT_MS + JOB_STALE_MS;
    if (isStaleByUpdate || isStaleByRuntime || isStaleByCreation) {
      job.status = 'failed';
      job.progress = 100;
      job.stage = 'failed';
      job.error = isStaleByRuntime
        ? `Job exceeded the 30-minute time limit and was automatically stopped. Start a retry.`
        : `Job stopped responding after restart or timeout. Start a retry.`;
      job.updatedAt = new Date().toISOString();
      job.recoveredBy = reason;
      changed += 1;
    }
  }
  if (changed) {
    saveDb(db);
    console.error('[jobs:recovered-stale]', { reason, changed, memory: memorySnapshot() });
  }
  return changed;
}

function isJobStopped(jobId) {
  const db = loadDb();
  const job = db.jobs.find(item => item.id === jobId);
  return !job || ['failed', 'cancelled', 'complete', 'completed'].includes(job.status);
}

async function hasCommand(command) {
  try {
    await run(command, command === FFMPEG ? ['-version'] : ['--version']);
    return true;
  } catch {
    return false;
  }
}

function ytdlpCandidates() {
  return Array.from(new Set([YTDLP, 'yt-dlp', 'python3 -m yt_dlp', 'python -m yt_dlp'].filter(Boolean)));
}

async function workingYtDlpCommand() {
  for (const candidate of ytdlpCandidates()) {
    if (await hasCommand(candidate)) return candidate;
  }
  return '';
}

async function ytDlpBaseArgs() {
  const args = [];
  const runtime = String(process.env.YTDLP_JS_RUNTIME || 'node').trim();
  if (runtime && runtime.toLowerCase() !== 'none') {
    const runtimeName = runtime.split(':')[0];
    if (await hasCommand(runtimeName)) args.push('--js-runtimes', runtime);
    else importLog('warn', 'yt-dlp JavaScript runtime not found', { runtime });
  }
  if (existsSync(YTDLP_COOKIES_PATH)) args.push('--cookies', YTDLP_COOKIES_PATH);
  // YouTube's "n" parameter (anti-throttling) now requires yt-dlp to fetch an official
  // remote solver script; without this, many videos report "Only images are available".
  args.push('--remote-components', 'ejs:github');
  return args;
}

// Fast, short-lived TCP probe -- does not use yt-dlp itself, so it can't hang on a
// dead proxy. Used to decide whether the residential-tunnel fallback is worth trying
// at all right now, since the tunnel is optional and often not connected.
function isProxyReachable(host = YTDLP_PROXY_HOST, port = YTDLP_PROXY_PORT, timeoutMs = 1200) {
  return new Promise(resolve => {
    const socket = netConnect({ host, port, timeout: timeoutMs });
    const finish = (ok) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// Runs yt-dlp with the default client first; if YouTube's bot-check blocks that specific
// attempt, retries with each fallback client in turn before giving up. Any non-bot-check
// error (private video, unsupported URL, etc.) fails immediately without wasting retries.
// As the true last resort -- after every client has been tried directly from this
// server's own IP -- if a residential SOCKS tunnel is currently connected, one more
// attempt is made through it. That tunnel is opened from the residential machine's
// side (see docs/youtube-proxy-tunnel.md); this server only ever dials localhost.
async function runYtDlpWithClientFallback(ytdlpCommand, extraArgs, runOptions = {}) {
  const baseArgs = await ytDlpBaseArgs();
  const attempts = [null, ...YOUTUBE_CLIENT_FALLBACKS];
  let lastError;
  for (let i = 0; i < attempts.length; i++) {
    const client = attempts[i];
    const clientArgs = client ? ['--extractor-args', `youtube:player_client=${client}`] : [];
    const args = [...baseArgs, ...clientArgs, ...extraArgs];
    try {
      const result = await run(ytdlpCommand, args, runOptions);
      if (i > 0) importLog('log', 'yt-dlp succeeded after client fallback', { client });
      return result;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '');
      if (!ytDlpBlockedByYouTube(message)) throw error;
      importLog('warn', 'yt-dlp attempt blocked by YouTube, trying next client', {
        client: client || 'default',
        remainingAttempts: attempts.length - i - 1
      });
    }
  }
  if (await isProxyReachable()) {
    const proxyArgs = [...baseArgs, `--proxy`, `socks5://${YTDLP_PROXY_HOST}:${YTDLP_PROXY_PORT}`, ...extraArgs];
    try {
      const result = await run(ytdlpCommand, proxyArgs, runOptions);
      importLog('log', 'yt-dlp succeeded via residential proxy tunnel (all direct client attempts were blocked)', {});
      return result;
    } catch (error) {
      lastError = error;
      importLog('warn', 'yt-dlp blocked even through the residential proxy tunnel', {
        raw: String(error?.message || error).slice(0, 400)
      });
    }
  } else {
    importLog('log', 'residential proxy tunnel not connected, skipping that fallback', {});
  }
  rememberYtDlpBlock(lastError);
  throw lastError;
}

async function commandVersion(command) {
  try {
    const { stdout, stderr } = await run(command, command === FFMPEG ? ['-version'] : ['--version']);
    return { ok: true, version: (stdout || stderr).split(/\r?\n/)[0] || 'installed' };
  } catch (error) {
    return { ok: false, version: '', error: error.message };
  }
}

const SOURCE_AUDIO_PRESENT = 'SOURCE_AUDIO_PRESENT';
const SOURCE_HAS_NO_AUDIO = 'SOURCE_HAS_NO_AUDIO';
const SOURCE_AUDIO_EXTRACTION_FAILED = 'SOURCE_AUDIO_EXTRACTION_FAILED';
const FINAL_AUDIO_VALID = 'FINAL_AUDIO_VALID';
const FINAL_AUDIO_SILENT = 'FINAL_AUDIO_SILENT';
const FINAL_AUDIO_MISSING = 'FINAL_AUDIO_MISSING';
const CAPTION_SYNC_VALID = 'CAPTION_SYNC_VALID';
const CAPTION_SYNC_OFFSET_DETECTED = 'CAPTION_SYNC_OFFSET_DETECTED';
const CAPTION_SYNC_DRIFT_DETECTED = 'CAPTION_SYNC_DRIFT_DETECTED';
const WORD_TIMESTAMPS_MISSING = 'WORD_TIMESTAMPS_MISSING';
const CAPTION_ALIGNMENT_LOW_CONFIDENCE = 'CAPTION_ALIGNMENT_LOW_CONFIDENCE';
const STALE_CAPTION_DATA = 'STALE_CAPTION_DATA';

function hasPathSeparator(value = '') {
  return /[\\/]/.test(String(value));
}

function ffmpegLocationArgs() {
  if (!hasPathSeparator(FFMPEG)) return [];
  return ['--ffmpeg-location', path.dirname(FFMPEG)];
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseVolumeStats(stderr = '') {
  const mean = numberOrNull(stderr.match(/mean_volume:\s*([-\d.]+)/)?.[1]);
  const max = numberOrNull(stderr.match(/max_volume:\s*([-\d.]+)/)?.[1]);
  return { meanVolumeDb: mean, maxVolumeDb: max };
}

function isEffectivelySilent(maxVolumeDb) {
  return maxVolumeDb === null || maxVolumeDb === undefined || !Number.isFinite(Number(maxVolumeDb)) || Number(maxVolumeDb) <= DIGITAL_SILENCE_MAX_DB;
}

async function probeMedia(filePath, { countPackets = false } = {}) {
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format'];
  if (countPackets) args.splice(4, 0, '-count_packets');
  const { stdout } = await run(FFPROBE, [...args, filePath], { label: 'ffprobe-media', timeoutMs: 30_000 });
  const probe = JSON.parse(stdout || '{}');
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find(s => s.codec_type === 'video') || null;
  const audioStream = streams.find(s => s.codec_type === 'audio') || null;
  return {
    path: filePath,
    probe,
    videoStream,
    audioStream,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    formatDuration: numberOrNull(probe.format?.duration),
    formatBitrate: numberOrNull(probe.format?.bit_rate),
    videoDuration: numberOrNull(videoStream?.duration),
    audioDuration: numberOrNull(audioStream?.duration),
    audioBitrate: numberOrNull(audioStream?.bit_rate),
    audioPackets: numberOrNull(audioStream?.nb_read_packets) ?? numberOrNull(audioStream?.nb_frames),
    width: numberOrNull(videoStream?.width),
    height: numberOrNull(videoStream?.height),
    fps: parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate || '0/1'),
  };
}

async function measureAudioVolume(filePath) {
  try {
    const { stderr } = await run(FFMPEG, [
      '-hide_banner', '-i', filePath,
      '-af', 'volumedetect', '-vn', '-sn', '-dn', '-f', 'null', '-',
    ], { label: 'audio-volumedetect', timeoutMs: 90_000, maxOutputBytes: 512 * 1024 });
    return parseVolumeStats(stderr);
  } catch (error) {
    return { meanVolumeDb: null, maxVolumeDb: null, error: String(error.message || error) };
  }
}

async function inspectSourceAudio(mediaPath) {
  try {
    const info = await probeMedia(mediaPath, { countPackets: true });
    if (!info.hasAudio) {
      return {
        status: SOURCE_HAS_NO_AUDIO,
        reason: 'No audio stream found in source media.',
        ...info,
      };
    }
    const volume = await measureAudioVolume(mediaPath);
    const silent = isEffectivelySilent(volume.maxVolumeDb);
    return {
      status: silent ? SOURCE_HAS_NO_AUDIO : SOURCE_AUDIO_PRESENT,
      reason: silent ? 'Source audio stream is present but effectively silent.' : 'Source audio is present and audible.',
      ...info,
      ...volume,
      silent,
    };
  } catch (error) {
    return {
      status: SOURCE_AUDIO_EXTRACTION_FAILED,
      reason: String(error.message || error),
      hasAudio: false,
      hasVideo: false,
      silent: true,
    };
  }
}

function resolveMediaDurationSeconds(video = {}, mediaInfo = {}) {
  const candidates = [
    mediaInfo.formatDuration,
    mediaInfo.videoDuration,
    mediaInfo.audioDuration,
    video.durationSeconds,
  ]
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value > 0.05);
  if (!candidates.length) return 0;
  return Number(candidates[0].toFixed(3));
}

function summarizeFormat(info = {}) {
  return {
    file: path.basename(info.path || ''),
    hasVideo: Boolean(info.hasVideo),
    hasAudio: Boolean(info.hasAudio),
    width: info.width || 0,
    height: info.height || 0,
    duration: info.formatDuration || info.videoDuration || info.audioDuration || 0,
    audioBitrate: info.audioBitrate || 0,
    videoCodec: info.videoStream?.codec_name || '',
    audioCodec: info.audioStream?.codec_name || '',
  };
}

function chooseBestDownloadedMedia(candidates = []) {
  const usable = candidates.filter(item => item && (item.hasVideo || item.hasAudio));
  const muxed = usable
    .filter(item => item.hasVideo && item.hasAudio)
    .sort((a, b) =>
      (b.height || 0) - (a.height || 0) ||
      (b.formatBitrate || 0) - (a.formatBitrate || 0) ||
      (b.size || 0) - (a.size || 0)
    )[0] || null;
  const videoOnly = usable
    .filter(item => item.hasVideo && !item.hasAudio)
    .sort((a, b) =>
      (b.height || 0) - (a.height || 0) ||
      (b.formatBitrate || 0) - (a.formatBitrate || 0) ||
      (b.size || 0) - (a.size || 0)
    )[0] || null;
  const audioOnly = usable
    .filter(item => item.hasAudio && !item.hasVideo)
    .sort((a, b) =>
      (b.audioBitrate || 0) - (a.audioBitrate || 0) ||
      (b.size || 0) - (a.size || 0)
    )[0] || null;
  return { muxed, videoOnly, audioOnly };
}

// Cache result — probe runs once per process lifetime
let _drawtextOk = null;
let _toolsCache = null; // cached once per process startup
async function drawtextSupported() {
  if (_drawtextOk !== null) return _drawtextOk;
  try {
    await run(FFMPEG, [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:size=64x64:duration=0.1',
      '-vf', "drawtext=text='x':fontsize=12", '-f', 'null', '-'
    ]);
    _drawtextOk = true;
  } catch {
    _drawtextOk = false;
    console.warn('[ffmpeg] drawtext filter unavailable (no libfreetype). Captions will be skipped. Install ffmpeg-full for text overlay support: brew install ffmpeg-full');
  }
  return _drawtextOk;
}

async function verifyMediaBinaries() {
  const ytdlpCommand = await workingYtDlpCommand();
  const ytdlp = ytdlpCommand ? await commandVersion(ytdlpCommand) : { ok: false, version: '', error: `Tried: ${ytdlpCandidates().join(', ')}` };
  const ffmpeg = await commandVersion(FFMPEG);
  if (ytdlp.ok) console.log(`[startup] yt-dlp ready via "${ytdlpCommand}": ${ytdlp.version}`);
  else console.error(`[startup] yt-dlp missing. ${ytdlp.error}`);
  if (ffmpeg.ok) console.log(`[startup] FFmpeg ready: ${ffmpeg.version}`);
  else console.error(`[startup] FFmpeg missing at "${FFMPEG}": ${ffmpeg.error}`);
  return { ytdlp, ffmpeg };
}

function importLog(level, message, details = {}) {
  const cleanDetails = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined && value !== ''));
  console[level === 'error' ? 'error' : 'log'](`[import:${level}] ${message}`, cleanDetails);
}

function friendlyYouTubeApiError(status, body = '') {
  const text = String(body || '');
  let reason = '';
  try {
    const parsed = JSON.parse(text);
    reason = parsed.error?.errors?.[0]?.reason || parsed.error?.status || parsed.error?.message || '';
  } catch {
    reason = text.slice(0, 160);
  }
  if (status === 400) return `YouTube API rejected the request${reason ? ` (${reason})` : ''}. Trying yt-dlp fallback.`;
  if (status === 403 && /quota/i.test(reason)) return 'YouTube API quota exceeded. Trying yt-dlp fallback.';
  if (status === 403) return `YouTube API key is invalid, restricted, or missing permission${reason ? ` (${reason})` : ''}. Trying yt-dlp fallback.`;
  return `YouTube API failed with ${status}${reason ? ` (${reason})` : ''}. Trying yt-dlp fallback.`;
}

function ytDlpBlockedByYouTube(message = '') {
  return /HTTP Error 429|Too Many Requests|Sign in to confirm you.?re not a bot|confirm you.?re not a bot/i.test(String(message));
}

function friendlyYtDlpError(error) {
  const text = String(error?.message || error || '');
  if (/YouTube blocked server download/i.test(text) || ytDlpBlockedByYouTube(text)) {
    return existsSync(YTDLP_COOKIES_PATH)
      ? 'YouTube blocked this download even with cookies configured — they may be expired. Ask an admin to re-upload fresh YouTube cookies in Admin → Settings, or upload the video file instead.'
      : 'YouTube blocked server download (sign-in/bot check). An admin can add YouTube cookies in Admin → Settings to fix this reliably, or upload the video file instead.';
  }
  if (/private video/i.test(text)) return 'Private video. Try a public video link or upload the file instead.';
  if (/members-only|members only/i.test(text)) return 'Members-only video. Upload a file you have permission to reuse.';
  if (/age.?restricted/i.test(text)) return 'Age-restricted video. Upload a permitted file instead.';
  if (/Unsupported URL|not a valid URL/i.test(text)) return 'Unsupported YouTube link. Paste a video, Shorts, playlist, channel, or @handle URL.';
  if (/No supported JavaScript runtime/i.test(text)) return 'Server video downloader needs a JavaScript runtime. Redeploy the Docker service, then try again or upload the file.';
  return 'YouTube download failed. Upload the video file instead.';
}

function rememberYtDlpBlock(error) {
  const message = String(error?.message || error || '');
  if (!ytDlpBlockedByYouTube(message)) return;
  ytdlpBlock.until = Date.now() + YTDLP_BLOCK_COOLDOWN_MS;
  ytdlpBlock.reason = friendlyYtDlpError(error);
  importLog('warn', 'yt-dlp paused after YouTube bot/rate-limit block', {
    cooldownSeconds: Math.round(YTDLP_BLOCK_COOLDOWN_MS / 1000),
    raw: message.slice(0, 1200)
  });
}

function assertYtDlpNotCoolingDown() {
  if (Date.now() < ytdlpBlock.until) {
    const seconds = Math.ceil((ytdlpBlock.until - Date.now()) / 1000);
    throw new Error(`${ytdlpBlock.reason || 'YouTube blocked server download. Upload the video file instead.'} Try server download again in ${seconds}s.`);
  }
}

function parseYouTubeUrl(input) {
  let url;
  try {
    const value = String(input || '').trim();
    if (!value) throw new Error('empty');
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    importLog('warn', 'malformed URL', { input });
    throw new Error('Paste a valid YouTube channel or video URL.');
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    importLog('warn', 'unsupported URL host', { host });
    throw new Error('Only YouTube URLs are supported in this MVP.');
  }
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || '';
    if (!/^[\w-]{11}$/.test(id)) throw new Error('That youtu.be link does not contain a valid video ID.');
    return { type: 'video', id, canonical: `https://www.youtube.com/watch?v=${id}`, original: url.toString() };
  }
  if (url.pathname === '/watch' && url.searchParams.get('v')) {
    const id = url.searchParams.get('v');
    if (!/^[\w-]{11}$/.test(id)) throw new Error('That YouTube watch link does not contain a valid video ID.');
    return { type: 'video', id, canonical: `https://www.youtube.com/watch?v=${id}`, original: url.toString() };
  }
  if (url.pathname === '/playlist' && url.searchParams.get('list')) {
    const id = url.searchParams.get('list');
    return { type: 'playlist', id, canonical: `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`, original: url.toString() };
  }
  if (url.pathname.startsWith('/shorts/')) {
    const id = url.pathname.split('/')[2];
    if (!/^[\w-]{11}$/.test(id)) throw new Error('That Shorts link does not contain a valid video ID.');
    return { type: 'video', id, canonical: `https://www.youtube.com/watch?v=${id}`, original: url.toString() };
  }
  if (url.pathname.startsWith('/channel/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/c/') || url.pathname.startsWith('/user/')) {
    const cleanPath = url.pathname.replace(/\/+$/, '');
    return { type: 'channel', id: cleanPath, canonical: `https://www.youtube.com${cleanPath}`, original: url.toString() };
  }
  if (url.pathname === '/' && url.searchParams.get('v')) {
    const id = url.searchParams.get('v');
    if (/^[\w-]{11}$/.test(id)) return { type: 'video', id, canonical: `https://www.youtube.com/watch?v=${id}`, original: url.toString() };
  }
  importLog('warn', 'unsupported YouTube URL shape', { pathname: url.pathname });
  throw new Error('Use a YouTube video URL or channel URL.');
}

function isoDurationToSeconds(value = 'PT0S') {
  const match = value.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function fetchYouTubeVideoWithApi(videoId) {
  const db = loadDb();
  const apiKey = settingValue(db, 'YOUTUBE_API_KEY');
  if (!apiKey) return null;
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,contentDetails,statistics');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', apiKey);
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    const message = friendlyYouTubeApiError(response.status, body);
    importLog(response.status >= 500 ? 'error' : 'warn', message, { status: response.status, videoId, body: body.slice(0, 500) });
    throw new Error(message);
  }
  const data = await response.json();
  const item = data.items?.[0];
  if (!item) throw new Error('No public video found for that URL.');
  return normalizeApiVideo(item);
}

async function fetchChannelWithApi(channelUrl) {
  const db = loadDb();
  const apiKey = settingValue(db, 'YOUTUBE_API_KEY');
  if (!apiKey) return null;
  const parsed = parseYouTubeUrl(channelUrl);
  let channelId = null;
  if (parsed.id.startsWith('/channel/')) channelId = parsed.id.split('/')[2];
  if (parsed.id.startsWith('/@')) {
    const channels = new URL('https://www.googleapis.com/youtube/v3/channels');
    channels.searchParams.set('part', 'snippet');
    channels.searchParams.set('forHandle', parsed.id.slice(2));
    channels.searchParams.set('key', apiKey);
    const channelResponse = await fetch(channels);
    if (channelResponse.ok) {
      const channelData = await channelResponse.json();
      channelId = channelData.items?.[0]?.id || null;
    } else {
      const body = await channelResponse.text();
      importLog('warn', friendlyYouTubeApiError(channelResponse.status, body), { status: channelResponse.status, channelUrl, body: body.slice(0, 500) });
      return null;
    }
  }
  if (!channelId) return null;
  const search = new URL('https://www.googleapis.com/youtube/v3/search');
  search.searchParams.set('part', 'snippet');
  search.searchParams.set('channelId', channelId);
  search.searchParams.set('maxResults', '12');
  search.searchParams.set('order', 'date');
  search.searchParams.set('type', 'video');
  search.searchParams.set('key', apiKey);
  const searchResponse = await fetch(search);
  if (!searchResponse.ok) {
    const body = await searchResponse.text();
    const message = friendlyYouTubeApiError(searchResponse.status, body);
    importLog(searchResponse.status >= 500 ? 'error' : 'warn', message, { status: searchResponse.status, channelUrl, body: body.slice(0, 500) });
    throw new Error(message);
  }
  const searchData = await searchResponse.json();
  const ids = searchData.items.map(item => item.id.videoId).filter(Boolean).join(',');
  if (!ids) return [];
  const videos = new URL('https://www.googleapis.com/youtube/v3/videos');
  videos.searchParams.set('part', 'snippet,contentDetails,statistics');
  videos.searchParams.set('id', ids);
  videos.searchParams.set('key', apiKey);
  const videoResponse = await fetch(videos);
  if (!videoResponse.ok) {
    const body = await videoResponse.text();
    const message = friendlyYouTubeApiError(videoResponse.status, body);
    importLog(videoResponse.status >= 500 ? 'error' : 'warn', message, { status: videoResponse.status, channelUrl, body: body.slice(0, 500) });
    throw new Error(message);
  }
  const videoData = await videoResponse.json();
  return classifyImportVideos(videoData.items.map(normalizeApiVideo), { sourceType: 'channel', source: 'youtube-api' }).accepted;
}

async function fetchPlaylistWithApi(playlistId) {
  const db = loadDb();
  const apiKey = settingValue(db, 'YOUTUBE_API_KEY');
  if (!apiKey) return null;
  const playlist = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
  playlist.searchParams.set('part', 'snippet');
  playlist.searchParams.set('playlistId', playlistId);
  playlist.searchParams.set('maxResults', '12');
  playlist.searchParams.set('key', apiKey);
  const playlistResponse = await fetch(playlist);
  if (!playlistResponse.ok) {
    const body = await playlistResponse.text();
    const message = friendlyYouTubeApiError(playlistResponse.status, body);
    importLog(playlistResponse.status >= 500 ? 'error' : 'warn', message, { status: playlistResponse.status, playlistId, body: body.slice(0, 500) });
    throw new Error(message);
  }
  const playlistData = await playlistResponse.json();
  const ids = playlistData.items.map(item => item.snippet?.resourceId?.videoId).filter(Boolean).join(',');
  if (!ids) return [];
  const videos = new URL('https://www.googleapis.com/youtube/v3/videos');
  videos.searchParams.set('part', 'snippet,contentDetails,statistics');
  videos.searchParams.set('id', ids);
  videos.searchParams.set('key', apiKey);
  const videoResponse = await fetch(videos);
  if (!videoResponse.ok) {
    const body = await videoResponse.text();
    const message = friendlyYouTubeApiError(videoResponse.status, body);
    importLog(videoResponse.status >= 500 ? 'error' : 'warn', message, { status: videoResponse.status, playlistId, body: body.slice(0, 500) });
    throw new Error(message);
  }
  const videoData = await videoResponse.json();
  return classifyImportVideos(videoData.items.map(normalizeApiVideo), { sourceType: 'playlist', source: 'youtube-api' }).accepted;
}

function normalizeApiVideo(item) {
  const durationSeconds = isoDurationToSeconds(item.contentDetails.duration);
  const liveStatus = item.snippet.liveBroadcastContent || 'none';
  return {
    youtubeId: item.id,
    url: `https://www.youtube.com/watch?v=${item.id}`,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    durationSeconds,
    viewCount: Number(item.statistics?.viewCount || 0),
    publishedAt: item.snippet.publishedAt,
    thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || '',
    isShort: durationSeconds > 0 && durationSeconds <= 90,
    liveStatus,
    importSource: 'youtube-api',
    status: 'imported'
  };
}

async function fetchWithYtDlp(source) {
  const ytdlpCommand = await workingYtDlpCommand();
  if (!ytdlpCommand) {
    importLog('error', 'yt-dlp missing', { tried: ytdlpCandidates().join(', ') });
    throw new Error('yt-dlp is not installed on the server. Deploy with Docker or install yt-dlp from requirements.txt so imports can fallback when the YouTube API fails.');
  }
  assertYtDlpNotCoolingDown();
  const extraArgs = ['--dump-single-json', '--skip-download', '--no-warnings', '--ignore-no-formats-error', '--playlist-end', '12', source];
  importLog('log', 'yt-dlp metadata fallback started', { source, command: ytdlpCommand });
  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await runYtDlpWithClientFallback(ytdlpCommand, extraArgs));
  } catch (error) {
    importLog('error', 'yt-dlp metadata failed', { source, raw: String(error.message || error).slice(0, 1200) });
    throw new Error(friendlyYtDlpError(error));
  }
  if (stderr) importLog('warn', 'yt-dlp metadata warnings', { stderr: stderr.slice(0, 500) });
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    importLog('error', 'yt-dlp returned invalid JSON', { source, stdout: stdout.slice(0, 500) });
    throw new Error('yt-dlp could not read metadata for that YouTube link.');
  }
  const entries = data.entries?.length ? data.entries : [data];
  const videos = entries.map(item => {
    const durationSeconds = Math.round(item.duration || 0);
    return {
      youtubeId: item.id,
      url: item.webpage_url || `https://www.youtube.com/watch?v=${item.id}`,
      title: item.title || 'Untitled video',
      channelTitle: item.channel || item.uploader || '',
      durationSeconds,
      viewCount: Number(item.view_count || 0),
      publishedAt: item.upload_date ? `${item.upload_date.slice(0, 4)}-${item.upload_date.slice(4, 6)}-${item.upload_date.slice(6, 8)}T00:00:00.000Z` : null,
      thumbnailUrl: item.thumbnail || '',
      isShort: durationSeconds > 0 && durationSeconds <= 90 || item.webpage_url?.includes('/shorts/'),
      liveStatus: item.is_live ? 'live' : 'none',
      availability: item.availability || '',
      ageLimit: Number(item.age_limit || 0),
      importSource: 'yt-dlp',
      status: 'imported'
    };
  });
  return classifyImportVideos(videos, { sourceType: 'yt-dlp', source }).accepted;
}

function classifyVideoForImport(video, context = {}) {
  const reasons = [];
  const duration = Number(video.durationSeconds || 0);
  const availability = String(video.availability || '').toLowerCase();
  if (!video.youtubeId) reasons.push('missing video id');
  if (availability.includes('private')) reasons.push('private');
  if (availability.includes('subscriber') || availability.includes('premium') || availability.includes('membership')) reasons.push('members-only');
  if (video.liveStatus === 'live' || video.liveStatus === 'upcoming') reasons.push('livestream');
  if (Number(video.ageLimit || 0) >= 18) reasons.push('age restricted');
  if (!Number.isFinite(duration) || duration < 0) reasons.push('unsupported duration');
  if (duration > 0 && duration < MIN_CLIP_SOURCE_SECONDS) importLog('warn', 'video is short but accepted', { id: video.youtubeId, durationSeconds: duration });
  const accepted = Boolean(video.youtubeId) && !reasons.length;
  const isShort = Boolean(video.isShort || duration <= 90);
  const normalized = {
    ...video,
    isShort,
    clipEligible: accepted,
    clipMode: isShort ? 'shorts-direct' : 'long-form-clipping',
    importWarning: accepted ? '' : reasons.join(', ')
  };
  importLog(accepted ? 'log' : 'warn', accepted ? 'video accepted' : 'video rejected', {
    id: video.youtubeId,
    title: video.title,
    durationSeconds: duration,
    reason: reasons.join(', ') || 'accepted',
    source: context.source
  });
  return { accepted, reasons, video: normalized };
}

function classifyImportVideos(videos, context = {}) {
  const accepted = [];
  const rejected = [];
  for (const video of videos) {
    const result = classifyVideoForImport(video, context);
    if (result.accepted) accepted.push(result.video);
    else rejected.push(result);
  }
  return { accepted, rejected };
}

function importFailureMessage(rejected = [], parsed = {}) {
  const reasons = rejected.flatMap(item => item.reasons || []);
  if (!reasons.length) return parsed.type === 'channel' ? 'No public uploads were found for that channel.' : parsed.type === 'playlist' ? 'No public videos were found in that playlist.' : 'Video unavailable.';
  if (reasons.includes('private')) return 'Private video. Try a public video link.';
  if (reasons.includes('members-only')) return 'Members-only video. Use a public video you own or have permission to reuse.';
  if (reasons.includes('livestream')) return 'Livestreams are not supported until they finish processing as regular videos.';
  if (reasons.includes('age restricted')) return 'Age-restricted videos are not supported for this MVP.';
  if (reasons.includes('unsupported duration')) return 'Unsupported duration. Try another public YouTube video.';
  return parsed.type === 'channel' ? 'No public uploads were available to import.' : parsed.type === 'playlist' ? 'No public videos were available in that playlist.' : 'Video unavailable.';
}

async function fetchSourceVideos(sourceUrl) {
  const parsed = parseYouTubeUrl(sourceUrl);
  const db = loadDb();
  const cacheKey = createHash('sha256').update(parsed.canonical).digest('hex');
  const cached = db.importCache.find(item => item.cacheKey === cacheKey && Date.now() - Date.parse(item.createdAt) < 6 * 60 * 60 * 1000);
  if (cached?.videos?.length) {
    importLog('log', 'metadata cache hit', { source: parsed.canonical, count: cached.videos.length });
    return { parsed, videos: cached.videos, source: 'cache', warnings: cached.warnings || [] };
  }
  const lastAttempt = importAttempts.get(cacheKey) || 0;
  if (Date.now() - lastAttempt < IMPORT_RATE_LIMIT_MS) {
    throw new Error('Please wait a few seconds before importing this YouTube link again.');
  }
  importAttempts.set(cacheKey, Date.now());
  let videos = [];
  const warnings = [];
  let source = 'youtube-api';
  if (parsed.type === 'video') {
    try {
      const apiVideo = await fetchYouTubeVideoWithApi(parsed.id);
      videos = apiVideo ? [apiVideo] : [];
    } catch (error) {
      warnings.push(error.message);
      videos = [];
    }
    if (!videos.length) {
      source = 'yt-dlp';
      videos = await fetchWithYtDlp(parsed.canonical);
    }
  } else if (parsed.type === 'playlist') {
    try {
      const apiVideos = await fetchPlaylistWithApi(parsed.id);
      videos = apiVideos || [];
    } catch (error) {
      warnings.push(error.message);
      videos = [];
    }
    if (!videos.length) {
      source = 'yt-dlp';
      videos = await fetchWithYtDlp(parsed.canonical);
    }
  } else {
    try {
      const apiVideos = await fetchChannelWithApi(parsed.canonical);
      videos = apiVideos || [];
    } catch (error) {
      warnings.push(error.message);
      videos = [];
    }
    if (!videos.length) {
      source = 'yt-dlp';
      videos = await fetchWithYtDlp(parsed.canonical);
    }
  }
  if (!videos.length) {
    importLog('warn', 'no importable public videos found', { source: parsed.canonical, type: parsed.type });
    throw new Error(importFailureMessage([], parsed));
  }
  db.importCache.unshift({ cacheKey, sourceUrl: parsed.canonical, sourceType: parsed.type, videos, warnings, metadataSource: source, createdAt: new Date().toISOString() });
  db.importCache = db.importCache.slice(0, 80);
  saveDb(db);
  importLog('log', 'metadata import ready', { source: parsed.canonical, count: videos.length, metadataSource: source });
  return { parsed, videos, source, warnings };
}

function addImportedVideos(db, sourceUrl, sourceType, videos, defaults = {}) {
  const importId = randomUUID();
  const projectId = randomUUID();
  const ownerId = defaults.userId || 'user_demo';
  db.imports.unshift({
    id: importId,
    userId: ownerId,
    projectId,
    sourceUrl,
    sourceType,
    status: 'imported',
    createdAt: new Date().toISOString()
  });
  db.projects.unshift({
    id: projectId,
    userId: ownerId,
    importId,
    name: sourceType === 'channel' ? 'YouTube channel clips' : 'YouTube video clips',
    sourceUrl,
    sourceType,
    status: 'imported',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const added = [];
  for (const video of videos) {
    const existing = db.videos.find(item => item.youtubeId === video.youtubeId && item.userId === ownerId);
    if (existing) continue;
    const row = {
      id: randomUUID(),
      userId: ownerId,
      importId,
      ...video,
      selected: false,
      rightsConfirmed: Boolean(defaults.rightsConfirmed),
      fairUseMode: Boolean(defaults.fairUseMode),
      transformationNote: defaults.transformationNote || '',
      watchedChannelId: defaults.watchedChannelId || null,
      projectId
    };
    db.videos.unshift(row);
    added.push(row);
  }
  return { importId, videos: added };
}

async function importSource(sourceUrl, userId) {
  const { parsed, videos, source, warnings } = await fetchSourceVideos(sourceUrl);
  const db = loadDb();
  const result = addImportedVideos(db, parsed.canonical, parsed.type, videos, { userId });
  saveDb(db);
  return { ...result, source: source || 'youtube-api', warnings: warnings || [], canonicalUrl: parsed.canonical };
}

const VIDEO_STORAGE_DIRS = [
  path.join(STORAGE_DIR, 'originals'),
  path.join(STORAGE_DIR, 'uploads'),
  path.join(STORAGE_DIR, 'clips'),
  path.join(STORAGE_DIR, 'thumbs'),
  path.join(STORAGE_DIR, 'thumbnails'),
  path.join(STORAGE_DIR, 'transcripts'),
];
const MANAGED_DELETE_ROOTS = [STORAGE_DIR, path.join(DATA_DIR, 'tmp')].map(root => path.resolve(root));
const VIDEO_DELETE_ROOTS = [...VIDEO_STORAGE_DIRS, path.join(DATA_DIR, 'tmp')].map(root => path.resolve(root));

function isPathInsideRoot(candidatePath, rootPath) {
  const resolved = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const rel = path.relative(root, resolved);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isPathAtOrInsideRoot(candidatePath, rootPath) {
  const resolved = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const rel = path.relative(root, resolved);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function resolveManagedDeletionPath(rawPath, roots = MANAGED_DELETE_ROOTS) {
  if (!rawPath) return null;
  let value = String(rawPath).trim();
  if (!value || /^https?:\/\//i.test(value) || value.startsWith('data:')) return null;
  value = value.split('?')[0].split('#')[0].replace(/\\/g, path.sep);
  let candidate;
  if (value.startsWith('/media/')) {
    candidate = path.join(STORAGE_DIR, value.slice('/media/'.length));
  } else if (value.startsWith('media/')) {
    candidate = path.join(STORAGE_DIR, value.slice('media/'.length));
  } else if (path.isAbsolute(value)) {
    candidate = value;
  } else {
    candidate = path.join(STORAGE_DIR, value);
  }
  const resolved = path.resolve(candidate);
  return roots.some(root => isPathInsideRoot(resolved, root)) ? resolved : null;
}

function cleanupResult(reason = 'manual', mode = 'video-assets') {
  return {
    id: randomUUID(),
    reason,
    mode,
    retentionDays: STORAGE_RETENTION_DAYS,
    videosDeleted: 0,
    clipsDeleted: 0,
    jobsDeleted: 0,
    transcriptionsDeleted: 0,
    seriesRowsDeleted: 0,
    metadataDeleted: 0,
    filesDeleted: 0,
    bytesFreed: 0,
    skippedUnsafe: [],
    errors: [],
    createdAt: new Date().toISOString(),
  };
}

function deleteFileIfSafe(rawPath, result = cleanupResult('single-file'), roots = MANAGED_DELETE_ROOTS) {
  const resolved = resolveManagedDeletionPath(rawPath, roots);
  if (!resolved) {
    if (rawPath) result.skippedUnsafe.push(String(rawPath));
    return false;
  }
  try {
    if (!existsSync(resolved)) return false;
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      result.skippedUnsafe.push(resolved);
      return false;
    }
    unlinkSync(resolved);
    result.filesDeleted += 1;
    result.bytesFreed += stat.size;
    return true;
  } catch (error) {
    result.errors.push({ path: resolved, error: String(error.message || error).slice(0, 300) });
    return false;
  }
}

function deleteVideoFileIfSafe(rawPath, result = cleanupResult('single-video-file')) {
  return deleteFileIfSafe(rawPath, result, VIDEO_DELETE_ROOTS);
}

function unlinkQuiet(filePath) {
  deleteFileIfSafe(filePath, cleanupResult('unlinkQuiet'));
}

function pathBasenameMaybe(value = '') {
  const raw = String(value || '').split('?')[0].split('#')[0];
  if (!raw || /^https?:\/\//i.test(raw)) return '';
  return path.basename(raw.replace(/\\/g, path.sep));
}

function pathStemMaybe(value = '') {
  const base = pathBasenameMaybe(value);
  return base ? base.replace(/\.[^.]+$/, '') : '';
}

function addPath(paths, value) {
  if (value) paths.add(String(value));
}

function safeReaddir(dirPath, roots = MANAGED_DELETE_ROOTS) {
  const resolved = path.resolve(dirPath);
  if (!roots.some(root => isPathAtOrInsideRoot(resolved, root))) return [];
  try {
    return readdirSync(resolved).map(name => path.join(resolved, name));
  } catch {
    return [];
  }
}

function deleteMatchingFiles(dirPath, predicate, result, roots = VIDEO_DELETE_ROOTS) {
  for (const filePath of safeReaddir(dirPath, roots)) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const name = path.basename(filePath);
    if (predicate(name, filePath, stat)) deleteFileIfSafe(filePath, result, roots);
  }
}

function deleteFilesByPrefixes(dirPath, prefixes, result, roots = VIDEO_DELETE_ROOTS) {
  const cleanPrefixes = Array.from(new Set([...prefixes].filter(prefix => String(prefix || '').length >= 6)));
  if (!cleanPrefixes.length) return;
  deleteMatchingFiles(dirPath, name => cleanPrefixes.some(prefix => name.startsWith(prefix)), result, roots);
}

function collectReferencedVideoAssetPaths(db) {
  const refs = new Set();
  for (const video of db.videos || []) {
    addPath(refs, video.storagePath);
    addPath(refs, video.thumbnailUrl);
    if (String(video.url || '').startsWith('/media/')) addPath(refs, video.url);
  }
  for (const clip of db.clips || []) {
    addPath(refs, clip.outputPath);
    addPath(refs, clip.thumbnailPath);
    for (const opt of clip.thumbnailOptions || []) addPath(refs, opt.path);
  }
  const resolved = new Set();
  for (const ref of refs) {
    const filePath = resolveManagedDeletionPath(ref, VIDEO_DELETE_ROOTS);
    if (filePath) resolved.add(filePath);
  }
  return resolved;
}

function cleanupClipAssets(db, clipIds, result = cleanupResult('manual', 'clips')) {
  const ids = new Set([...clipIds].filter(Boolean));
  if (!ids.size) return result;
  const clips = (db.clips || []).filter(clip => ids.has(clip.id));
  const paths = new Set();
  const thumbPrefixes = new Set();
  const optionPrefixes = new Set();
  const tmpPrefixes = new Set();
  for (const clip of clips) {
    addPath(paths, clip.outputPath);
    addPath(paths, clip.thumbnailPath);
    for (const opt of clip.thumbnailOptions || []) addPath(paths, opt.path);
    thumbPrefixes.add(`clip_${clip.id}`);
    optionPrefixes.add(`thumb_${clip.id}_`);
    tmpPrefixes.add(`cf_${clip.id}`);
  }
  for (const filePath of paths) deleteVideoFileIfSafe(filePath, result);
  deleteFilesByPrefixes(path.join(STORAGE_DIR, 'thumbs'), thumbPrefixes, result);
  deleteFilesByPrefixes(path.join(STORAGE_DIR, 'thumbnails'), optionPrefixes, result);
  deleteFilesByPrefixes(path.join(DATA_DIR, 'tmp'), tmpPrefixes, result);
  const beforePosts = (db.scheduledPosts || []).length;
  db.scheduledPosts = (db.scheduledPosts || []).filter(post => !ids.has(post.clipId));
  const beforeParts = (db.seriesParts || []).length;
  db.seriesParts = (db.seriesParts || []).filter(part => !ids.has(part.clipId));
  db.seriesJobs = (db.seriesJobs || []).filter(series => (db.seriesParts || []).some(part => part.seriesId === series.id));
  db.usageEvents = (db.usageEvents || []).filter(event => !ids.has(event.clipId));
  db.clips = (db.clips || []).filter(clip => !ids.has(clip.id));
  result.clipsDeleted += clips.length;
  result.seriesRowsDeleted += beforeParts - db.seriesParts.length;
  if (beforePosts !== (db.scheduledPosts || []).length) result.metadataDeleted += beforePosts - db.scheduledPosts.length;
  return result;
}

function cleanupVideoAssets(db, videoIds, result = cleanupResult('manual', 'videos')) {
  const ids = new Set([...videoIds].filter(Boolean));
  if (!ids.size) return result;
  const videos = (db.videos || []).filter(video => ids.has(video.id));
  const relatedClips = (db.clips || []).filter(clip => ids.has(clip.videoId));
  cleanupClipAssets(db, relatedClips.map(clip => clip.id), result);
  const paths = new Set();
  const originalPrefixes = new Set();
  const transcriptPrefixes = new Set();
  const uploadPrefixes = new Set();
  for (const video of videos) {
    addPath(paths, video.storagePath);
    addPath(paths, video.thumbnailUrl);
    if (String(video.url || '').startsWith('/media/')) addPath(paths, video.url);
    for (const prefix of [video.youtubeId, video.id, pathStemMaybe(video.storagePath), pathStemMaybe(video.url)].filter(Boolean)) {
      originalPrefixes.add(prefix);
      transcriptPrefixes.add(prefix);
      uploadPrefixes.add(prefix);
    }
  }
  for (const filePath of paths) deleteVideoFileIfSafe(filePath, result);
  deleteFilesByPrefixes(path.join(STORAGE_DIR, 'originals'), originalPrefixes, result);
  deleteFilesByPrefixes(path.join(STORAGE_DIR, 'transcripts'), transcriptPrefixes, result);
  deleteFilesByPrefixes(path.join(STORAGE_DIR, 'uploads'), uploadPrefixes, result);
  for (const video of videos) {
    for (const job of (db.jobs || []).filter(item => item.videoId === video.id)) killActiveJobProcesses(job.id);
    cancelQueuedRenderJobsForVideo(video.id, 'Job cancelled because the source video was removed by storage cleanup.');
  }
  const beforeJobs = (db.jobs || []).length;
  const beforeTranscriptions = (db.transcriptions || []).length;
  const beforeSeriesParts = (db.seriesParts || []).length;
  db.jobs = (db.jobs || []).filter(job => !ids.has(job.videoId));
  db.transcriptions = (db.transcriptions || []).filter(row => !ids.has(row.videoId));
  db.seriesParts = (db.seriesParts || []).filter(part => !ids.has(part.videoId));
  db.seriesJobs = (db.seriesJobs || []).filter(series => !ids.has(series.videoId));
  db.usageEvents = (db.usageEvents || []).filter(event => !ids.has(event.videoId));
  db.videos = (db.videos || []).filter(video => !ids.has(video.id));
  db.projects = (db.projects || []).filter(project => db.videos.some(video => video.projectId === project.id) || db.clips.some(clip => db.videos.some(video => video.id === clip.videoId && video.projectId === project.id)));
  db.imports = (db.imports || []).filter(item => db.videos.some(video => video.importId === item.id));
  result.videosDeleted += videos.length;
  result.jobsDeleted += beforeJobs - db.jobs.length;
  result.transcriptionsDeleted += beforeTranscriptions - db.transcriptions.length;
  result.seriesRowsDeleted += beforeSeriesParts - db.seriesParts.length;
  return result;
}

function timestampMs(record = {}) {
  for (const key of ['createdAt', 'completedAt', 'updatedAt', 'startedAt', 'publishedAt']) {
    const value = Date.parse(record[key] || '');
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function latestVideoAssetTime(db, video) {
  const times = [timestampMs(video)];
  for (const clip of (db.clips || []).filter(item => item.videoId === video.id)) times.push(timestampMs(clip));
  for (const job of (db.jobs || []).filter(item => item.videoId === video.id && ['queued', 'running'].includes(item.status))) times.push(Date.now());
  return Math.max(...times.filter(Boolean), 0);
}

function normalizeRetentionDays(value = STORAGE_RETENTION_DAYS) {
  const days = Number(value);
  if (!Number.isFinite(days)) return STORAGE_RETENTION_DAYS;
  return Math.max(1, Math.min(365, days));
}

function sweepOldFiles(db, cutoffMs, result, { all = false } = {}) {
  const refs = collectReferencedVideoAssetPaths(db);
  const shouldDelete = (filePath, stat) => {
    if (all) return true;
    return stat.mtimeMs < cutoffMs && !refs.has(path.resolve(filePath));
  };
  for (const dir of VIDEO_STORAGE_DIRS) {
    deleteMatchingFiles(dir, (_name, filePath, stat) => shouldDelete(filePath, stat), result);
  }
  deleteMatchingFiles(path.join(DATA_DIR, 'tmp'), (_name, _filePath, stat) => all || stat.mtimeMs < cutoffMs, result);
}

function recordStorageCleanupRun(db, result) {
  if (!Array.isArray(db.storageCleanupRuns)) db.storageCleanupRuns = [];
  db.storageCleanupRuns.unshift({
    ...result,
    bytesFreedMb: Math.round((result.bytesFreed / 1024 / 1024) * 100) / 100,
  });
  db.storageCleanupRuns = db.storageCleanupRuns.slice(0, 50);
}

function runStorageRetentionCleanup({ reason = 'retention', retentionDays = STORAGE_RETENTION_DAYS } = {}) {
  const db = loadDb();
  const result = cleanupResult(reason, 'retention');
  const days = normalizeRetentionDays(retentionDays);
  result.retentionDays = days;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const activeVideoIds = new Set((db.jobs || []).filter(job => ['queued', 'running'].includes(job.status)).map(job => job.videoId));
  const staleVideoIds = (db.videos || [])
    .filter(video => !activeVideoIds.has(video.id) && latestVideoAssetTime(db, video) > 0 && latestVideoAssetTime(db, video) < cutoff)
    .map(video => video.id);
  cleanupVideoAssets(db, staleVideoIds, result);
  const staleClipIds = (db.clips || [])
    .filter(clip => timestampMs(clip) > 0 && timestampMs(clip) < cutoff)
    .map(clip => clip.id);
  cleanupClipAssets(db, staleClipIds, result);
  sweepOldFiles(db, cutoff, result);
  recordStorageCleanupRun(db, result);
  saveDb(db);
  return result;
}

function deleteAllVideoAssetsForAdmin({ reason = 'admin-delete-all-video-assets' } = {}) {
  const db = loadDb();
  const result = cleanupResult(reason, 'admin-delete-all-video-assets');
  cleanupVideoAssets(db, (db.videos || []).map(video => video.id), result);
  cleanupClipAssets(db, (db.clips || []).map(clip => clip.id), result);
  sweepOldFiles(db, 0, result, { all: true });
  result.jobsDeleted += (db.jobs || []).length;
  db.videos = [];
  db.clips = [];
  db.jobs = [];
  db.transcriptions = [];
  db.seriesJobs = [];
  db.seriesParts = [];
  db.scheduledPosts = [];
  db.projects = [];
  db.imports = [];
  db.importCache = [];
  db.usageEvents = (db.usageEvents || []).filter(event => !event.videoId && !event.clipId);
  recordStorageCleanupRun(db, result);
  saveDb(db);
  return result;
}

function videoStorageStats(db = loadDb()) {
  const result = { files: 0, bytes: 0, bytesMb: 0, videos: (db.videos || []).length, clips: (db.clips || []).length, retentionDays: STORAGE_RETENTION_DAYS };
  for (const dir of [...VIDEO_STORAGE_DIRS, path.join(DATA_DIR, 'tmp')]) {
    for (const filePath of safeReaddir(dir, VIDEO_DELETE_ROOTS)) {
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        result.files += 1;
        result.bytes += stat.size;
      } catch {}
    }
  }
  result.bytesMb = Math.round((result.bytes / 1024 / 1024) * 100) / 100;
  result.lastCleanup = (db.storageCleanupRuns || [])[0] || null;
  return result;
}

// ─── Gemini transcription fallback (no Whisper key needed) ───────────────────
async function transcribeWithGemini(db, mediaPath, videoId, geminiKey) {
  const probe = await probeMediaDuration(mediaPath).catch(() => ({ durationSeconds: 0 }));
  const totalDuration = Math.max(0, Number(probe.durationSeconds || 0));
  const chunks = totalDuration > TRANSCRIPTION_CHUNK_SECONDS
    ? Array.from({ length: Math.ceil(totalDuration / TRANSCRIPTION_CHUNK_SECONDS) }, (_, i) => ({
        start: i * TRANSCRIPTION_CHUNK_SECONDS,
        duration: Math.min(TRANSCRIPTION_CHUNK_SECONDS, totalDuration - i * TRANSCRIPTION_CHUNK_SECONDS)
      }))
    : [{ start: 0, duration: totalDuration || 0 }];
  const allSegments = [];
  try {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const audioPath = path.join(STORAGE_DIR, 'originals', `${videoId}_audio_${chunkIndex}.mp3`);
      try {
        const trimArgs = chunk.duration > 0 ? ['-ss', String(chunk.start), '-t', String(chunk.duration)] : [];
        await run(FFMPEG, ['-y', ...trimArgs, '-i', mediaPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '96k', audioPath],
          { timeoutMs: 3 * 60 * 1000, label: 'extract audio for gemini transcription' });
        if (!existsSync(audioPath) || statSync(audioPath).size < 512) continue;

        const text = await geminiTranscribeFile(geminiKey, audioPath, 'audio/mpeg');
        if (!text || text.length < 10) continue;

        // Split into ~4-second segments (Gemini transcript text has no word timing).
        const words = text.split(/\s+/).filter(Boolean);
        const WORDS_PER_SEG = 12;
        const estimatedDuration = Math.min(chunk.duration || words.length / 2.5, Math.max(1, words.length / 2.5));
        for (let i = 0; i < words.length; i += WORDS_PER_SEG) {
          const textChunk = words.slice(i, i + WORDS_PER_SEG).join(' ');
          const relStart = i / Math.max(1, words.length) * estimatedDuration;
          const relEnd = Math.min(estimatedDuration, relStart + WORDS_PER_SEG / 2.5);
          allSegments.push({ start: chunk.start + relStart, end: chunk.start + relEnd, text: textChunk });
        }
      } finally {
        unlinkQuiet(audioPath);
      }
    }
    importLog('log', 'Gemini transcription succeeded', { videoId, chunks: chunks.length, segments: allSegments.length });
    return allSegments;
  } catch (err) {
    importLog('warn', 'Gemini transcription error', { videoId, error: String(err.message || err).slice(0, 300) });
    return [];
  }
}

// ─── Gemini video analysis — direct video understanding ──────────────────────
// Upload the source video to Gemini File API, ask it to identify viral moments
// with full visual context (expressions, energy, props, speaker changes).
async function geminiVideoViralAnalysis(geminiKey, mediaPath, video, segments, options = {}) {
  const desiredCount = Math.max(1, Math.min(10, Number(options.clipCount || 3)));
  const targetDurations = options.targetDurations || Array(desiredCount).fill(60);
  const videoDuration = Number(video.durationSeconds || 0);
  const minGap = Math.max(30, videoDuration * 0.15);

  const transcript = buildTranscriptReference(segments, 24000);

  const prompt = `You are a world-class viral short-form video editor. Analyze this video visually and aurally.
Watch for: facial expressions, emotional peaks, hand gestures, energy shifts, surprising moments, speaker changes, visual props, viewer retention patterns.

Video title: "${video.title}"
Total duration: ${videoDuration}s
Request: ${desiredCount} clips
Target durations: ${targetDurations.map((d, i) => `Clip ${i + 1}: ${d}s`).join(', ')}

MANDATORY rules:
- Clips must start at least ${Math.round(minGap)}s apart — cover DIFFERENT sections
- Each clip must have a strong hook in the FIRST 3 SECONDS
- Each clip must feel like a COMPLETE story: setup → tension → payoff
- NEVER cut mid-sentence or before the punchline
- Avoid filler, intros/outros, or meandering sections
- Prefer emotional, surprising, funny, controversial, or high-retention moments

Transcript reference (use for precise timestamp matching):
${transcript}

Return ONLY this JSON (no markdown, no extra keys):
{"moments":[{"start":number,"end":number,"overallScore":number,"hookStrength":number,"emotionalPunch":number,"voiceEnergy":number,"controversy":number,"usefulness":number,"storytelling":number,"shareability":number,"retentionScore":number,"dropoffRisk":"low|medium|high","reason":"laugh|revelation|shock|emotion|value|argument|reaction|story|inspiration|confession","rationale":"2-3 sentences why a top TikTok editor would cut this exact moment","hooks":{"curiosity":"hook under 96 chars","shock":"hook under 96 chars","value":"hook under 96 chars","story":"hook under 96 chars","controversy":"hook under 96 chars","sales":"hook under 96 chars"},"title":"viral clip title under 60 chars","tiktok_description":"TikTok caption under 300 chars","reels_description":"Instagram Reels caption under 220 chars","hashtags":["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8"],"thumbnail_idea":"1-sentence thumbnail description","brollKeywords":["keyword1","keyword2","keyword3"],"soundEffectSuggestions":["sfx1","sfx2"],"captionStyle":"hormozi|mrbeast|karaoke|tiktok|viral|neon|fire|hype|reels|podcast|minimal|luxury|finance|bold","framingNotes":"ideal framing for this moment","bestPlatform":"TikTok|Instagram Reels|YouTube Shorts|X|LinkedIn","contentWarning":"none|mild|mature"}]}`;

  const { uri, name: fileName } = await geminiUploadFile(geminiKey, mediaPath, 'video/mp4');
  const model = geminiModel(db);
  console.log(`[Gemini] video analysis — model: ${model}, provider: gemini`);
  try {
    const { text, usage, model: usedModel } = await geminiGenerateWithFile({
      apiKey: geminiKey, fileUri: uri, mimeType: 'video/mp4', prompt, model, temperature: 0.3,
    });
    recordAiLog({ provider: 'gemini', model: usedModel, purpose: 'viral video analysis (video upload)', ok: true, ...usage });
    return text;
  } catch (err) {
    const q429 = parseGemini429(err);
    if (q429) {
      console.error(`[Gemini] QUOTA: video analysis failed — ${q429.model} — retry after ${Math.ceil(q429.retryMs / 1000)}s`);
      recordAiLog({ provider: 'gemini', model, purpose: 'viral video analysis', ok: false, error: `quota_exceeded: ${q429.model}` });
    }
    throw err;
  } finally {
    geminiDeleteFile(geminiKey, fileName);
  }
}

// ─── Gemini clip metadata generation ─────────────────────────────────────────
// After viral moments are selected, generate rich per-clip content in one call.
async function geminiGenerateClipMetadata(db, video, moment) {
  try {
    const geminiKey = settingValue(db, 'GEMINI_API_KEY');
    if (!geminiKey) return {};

    const clipText = (moment.text || moment.hook || '').slice(0, 800);
    const prompt = `Video: "${video.title}"
Clip content: "${clipText}"
Clip reason: ${moment.reason || 'educational'}
Target platforms: TikTok, Instagram Reels, YouTube Shorts

Generate rich metadata. Return ONLY this JSON:
{
  "title": "engaging clip title under 60 chars",
  "youtube_title": "YouTube Shorts title with SEO, under 70 chars",
  "tiktok_description": "TikTok caption, conversational, under 2200 chars",
  "reels_description": "Instagram Reels caption under 220 chars",
  "shorts_description": "YouTube Shorts description under 500 chars",
  "x_caption": "X/Twitter caption under 250 chars",
  "linkedin_caption": "Professional LinkedIn caption under 700 chars",
  "hashtags_tiktok": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8","#tag9","#tag10"],
  "hashtags_instagram": ["#tag1","#tag2","#tag3","#tag4","#tag5"],
  "hashtags_youtube": ["#tag1","#tag2","#tag3"],
  "seo_keywords": ["keyword1","keyword2","keyword3","keyword4"],
  "thumbnail_idea": "vivid 1-sentence thumbnail description with text overlay suggestion",
  "broll_suggestions": ["specific search query 1","specific search query 2","specific search query 3"],
  "sound_effect_suggestions": ["sound effect 1","sound effect 2"],
  "cta": "short call-to-action to end the video",
  "best_posting_time": "day and time recommendation e.g. Tuesday 7pm EST"
}`;

    const model = geminiModel(db);
    console.log(`[Gemini] clip metadata — model: ${model}, provider: gemini`);
    const { text, usage, model: usedModel } = await geminiGenerateText({
      apiKey: geminiKey, prompt,
      systemPrompt: 'You are an expert social media strategist and viral content writer. Return only valid JSON.',
      model, temperature: 0.6,
    });
    recordAiLog({ provider: 'gemini', model: usedModel, purpose: 'clip metadata generation', ok: true, ...usage });
    return extractJsonObject(text) || {};
  } catch { return {}; }
}

// ─── Gemini QA review ─────────────────────────────────────────────────────────
// After export, runs a quick AI quality check on the clip metadata and render report.
async function geminiQAReview(db, clip, renderReport = {}) {
  try {
    const geminiKey = settingValue(db, 'GEMINI_API_KEY');
    if (!geminiKey) return null;

    const prompt = `You are a QA expert for short-form viral video clips. Review this exported clip and identify any issues.

Clip metadata:
- Title: ${clip.title || clip.hook || 'Untitled'}
- Duration: ${Math.round((clip.endTime || 60) - (clip.startTime || 0))}s
- Caption style: ${clip.captionStyle || 'none'}
- Platform: ${clip.bestPlatform || 'TikTok'}
- Clip reason/type: ${clip.reason || 'educational'}

Render report:
- Dimensions: ${renderReport.width || 1080}x${renderReport.height || 1920}
- Has audio: ${renderReport.hasAudio !== false}
- File size KB: ${Math.round((renderReport.fileSizeBytes || 0) / 1024)}
- Issues detected: ${(renderReport.issues || []).join(', ') || 'none'}
- Quality scores: framing=${renderReport.scores?.framing || 88}, audio=${renderReport.scores?.audioSync || 95}

Assess the clip quality. Return ONLY this JSON:
{
  "qa_pass": true|false,
  "overall_quality": "excellent|good|acceptable|poor",
  "issues": ["list of specific issues if any"],
  "caption_sync_ok": true|false,
  "framing_ok": true|false,
  "audio_ok": true|false,
  "platform_ready": true|false,
  "corrections": ["specific correction instruction per module if qa_pass is false"],
  "viral_potential": "high|medium|low",
  "estimated_watch_rate": "percentage of viewers likely to watch to the end"
}`;

    const model = geminiModel(db);
    console.log(`[Gemini] QA review — model: ${model}, provider: gemini`);
    const { text, usage, model: usedModel } = await geminiGenerateText({
      apiKey: geminiKey, prompt,
      systemPrompt: 'You are a strict QA reviewer for short-form video content. Be precise. Return only valid JSON.',
      model, temperature: 0.2,
    });
    recordAiLog({ provider: 'gemini', model: usedModel, purpose: 'clip QA review', ok: true, ...usage });
    return extractJsonObject(text) || null;
  } catch { return null; }
}

function cleanupOldSourcesForNewUpload(db) {
  const clipVideoIds = new Set(db.clips.map(clip => clip.videoId).filter(Boolean));
  const keepJobIds = new Set(db.clips.map(clip => clip.jobId).filter(Boolean));
  const activeJobVideoIds = new Set(db.jobs.filter(job => ['queued', 'running'].includes(job.status)).map(job => job.videoId));
  const removeVideoIds = new Set();
  for (const video of db.videos) {
    const generatedClipExists = clipVideoIds.has(video.id);
    const activeJobExists = activeJobVideoIds.has(video.id);
    if (!generatedClipExists && !activeJobExists) {
      removeVideoIds.add(video.id);
      if (video.storagePath) unlinkQuiet(video.storagePath);
    }
  }
  db.videos = db.videos.filter(video => !removeVideoIds.has(video.id));
  db.jobs = db.jobs.filter(job => keepJobIds.has(job.id) || (!removeVideoIds.has(job.videoId) && job.status !== 'failed'));
  db.imports = db.imports.slice(0, 12);
  db.projects = db.projects.filter(project => db.videos.some(video => video.projectId === project.id) || db.clips.some(clip => db.videos.some(video => video.id === clip.videoId && video.projectId === project.id))).slice(0, 12);
  return { removedVideos: removeVideoIds.size };
}

function streamUploadedVideo(req) {
  return new Promise((resolve, reject) => {
    assertMemoryAvailable();
    const fields = {};
    let upload = null;
    let failed = false;
    const writes = [];
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fields: 4,
        fileSize: MAX_UPLOAD_BYTES
      }
    });
    const fail = error => {
      failed = true;
      if (upload?.path) unlinkQuiet(upload.path);
      reject(error);
    };
    busboy.on('field', (name, value) => {
      fields[name] = String(value || '').slice(0, 300);
    });
    busboy.on('file', (field, file, info) => {
      const filename = info.filename || 'upload.mp4';
      const ext = path.extname(filename).toLowerCase();
      const allowed = new Set(['.mp4', '.mov', '.webm', '.m4v']);
      if (!allowed.has(ext)) {
        file.resume();
        return fail(new Error('Unsupported format. Upload mp4, mov, webm, or m4v.'));
      }
      const uploadId = randomUUID();
      const storedName = `${uploadId}${ext}`;
      const uploadPath = path.join(STORAGE_DIR, 'uploads', storedName);
      const write = createWriteStream(uploadPath);
      upload = { field, uploadId, filename, mimeType: info.mimeType || 'application/octet-stream', storedName, path: uploadPath, bytes: 0 };
      file.on('data', chunk => { upload.bytes += chunk.length; });
      file.on('limit', () => fail(new Error(`File too large. Max upload is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB on this Render service.`)));
      file.on('error', fail);
      write.on('error', fail);
      writes.push(new Promise((res, rej) => {
        write.on('finish', res);
        write.on('error', rej);
      }));
      file.pipe(write);
    });
    busboy.on('error', fail);
    busboy.on('close', async () => {
      if (failed) return;
      try {
        await Promise.all(writes);
        if (!upload) throw new Error('No video file was uploaded.');
        resolve({ fields, file: upload });
      } catch (error) {
        if (upload?.path) unlinkQuiet(upload.path);
        reject(error);
      }
    });
    req.pipe(busboy);
  });
}

async function probeMediaDuration(filePath) {
  try {
    const { stdout } = await run(FFMPEG, ['-i', filePath, '-hide_banner']);
    return stdout;
  } catch (error) {
    const text = error.message || '';
    const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return {
      durationSeconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0
    };
  }
}

async function thumbnailForUpload(filePath, uploadId) {
  const output = path.join(STORAGE_DIR, 'thumbs', `${uploadId}.jpg`);
  try {
    await run(FFMPEG, ['-y', '-ss', '1', '-i', filePath, '-frames:v', '1', '-vf', 'scale=480:-1', '-q:v', '5', output], { timeoutMs: 60 * 1000 });
    return `/media/thumbs/${uploadId}.jpg`;
  } catch (error) {
    importLog('warn', 'thumbnail generation failed', { error: error.message });
    throw new Error(`FFmpeg thumbnail failed: ${String(error.message || error).slice(0, 220)}`);
  }
}

async function importUploadedVideo(req) {
  const { fields, file } = await streamUploadedVideo(req);
  logMemory('after upload stream');
  const probe = await probeMediaDuration(file.path);
  const thumbnailUrl = await thumbnailForUpload(file.path, file.uploadId);
  const title = fields.title || file.filename.replace(/\.[^.]+$/, '') || 'Uploaded video';
  const video = classifyVideoForImport({
    youtubeId: `upload_${file.uploadId}`,
    url: `/media/uploads/${file.storedName}`,
    title,
    channelTitle: 'Uploaded file',
    durationSeconds: Math.round(probe.durationSeconds || 0),
    viewCount: 0,
    publishedAt: new Date().toISOString(),
    thumbnailUrl,
    isShort: Number(probe.durationSeconds || 0) <= 90,
    sourceKind: 'upload',
    storagePath: file.path,
    originalFilename: file.filename,
    mimeType: file.mimeType,
    status: 'imported'
  }, { source: 'upload' }).video;
  const db = loadDb();
  const uploaderUser = currentUser(req, db);
  const cleanup = cleanupOldSourcesForNewUpload(db);
  const result = addImportedVideos(db, 'upload', 'upload', [video], { userId: uploaderUser?.id });
  saveDb(db);
  return { ...result, source: 'upload', warnings: [], canonicalUrl: 'upload', cleanup };
}

function queueBackgroundProcess(videoId, options) {
  setTimeout(async () => {
    try {
      await enqueueRenderJob({ videoId, ...options });
    } catch {
      // processVideo records the failed job; the watcher keeps running.
    }
  }, 10);
}

function enqueueRenderJob(payload) {
  return new Promise((resolve, reject) => {
    renderQueue.push({ payload, resolve, reject });
    drainRenderQueue();
  });
}

function recoverQueuedSeriesJobs(reason = 'startup') {
  const db = loadDb();
  const candidates = db.jobs.filter(job =>
    ['queued', 'running'].includes(job.status) &&
    ['series', 'full_series', 'full-video-series'].includes(String(job.payload?.workflowMode || job.payload?.mode || '').toLowerCase())
  );
  let queued = 0;
  const payloads = [];
  for (const job of candidates) {
    job.status = 'queued';
    job.stage = 'queued after restart';
    job.progress = Math.max(1, Math.min(99, Number(job.progress || 1)));
    job.updatedAt = new Date().toISOString();
    payloads.push({ ...(job.payload || {}), jobId: job.id, videoId: job.videoId, rightsConfirmed: true });
    queued += 1;
  }
  if (queued) {
    saveDb(db);
    for (const payload of payloads) {
      enqueueRenderJob(payload).catch(error => console.error('[series:recovery-failed]', { jobId: payload.jobId, reason, error: String(error.message || error).slice(0, 500) }));
    }
    console.error('[series:recovered-queued]', { reason, queued });
  }
  return queued;
}

function drainRenderQueue() {
  if (activeRenderJobs >= MAX_CONCURRENT_RENDER_JOBS) return;
  const next = renderQueue.shift();
  if (!next) return;
  activeRenderJobs += 1;
  logMemory('render job start');
  if (next.payload.jobId && isJobStopped(next.payload.jobId)) {
    activeRenderJobs -= 1;
    next.reject(new Error('Job was cancelled before it started.'));
    drainRenderQueue();
    return;
  }
  processVideo(next.payload)
    .then(next.resolve, next.reject)
    .finally(() => {
      activeRenderJobs -= 1;
      logMemory('render job finish');
      drainRenderQueue();
    });
}

async function addWatchedChannel(payload) {
  const sourceUrl = String(payload.sourceUrl || '').trim();
  const parsed = parseYouTubeUrl(sourceUrl);
  if (parsed.type !== 'channel') throw new Error('Auto-watch needs a YouTube channel URL, not a single video.');
  if (!payload.rightsConfirmed) throw new Error('Confirm this is your channel, a client channel, or a channel you have permission to reuse.');
  if (payload.fairUseMode && !String(payload.transformationNote || '').trim()) {
    throw new Error('Fair-use/remix auto-watch requires a transformation note.');
  }
  const db = loadDb();
  const ownerId = payload.userId || 'user_demo';
  const existing = db.watchedChannels.find(item => item.sourceUrl === parsed.canonical && item.userId === ownerId);
  const watch = existing || {
    id: randomUUID(),
    userId: ownerId,
    sourceUrl: parsed.canonical,
    status: 'active',
    createdAt: new Date().toISOString(),
    knownVideoIds: []
  };
  watch.rightsConfirmed = true;
  watch.fairUseMode = Boolean(payload.fairUseMode);
  watch.transformationNote = payload.transformationNote || '';
  watch.autoProcess = payload.autoProcess !== false;
  watch.autoSchedule = Boolean(payload.autoSchedule);
  watch.platforms = Array.isArray(payload.platforms) ? payload.platforms.filter(platform => PLATFORMS.includes(platform)) : [];
  watch.updatedAt = new Date().toISOString();
  if (!existing) db.watchedChannels.unshift(watch);
  saveDb(db);
  return watch;
}

async function pollWatchedChannel(watchId) {
  const db = loadDb();
  const watch = db.watchedChannels.find(item => item.id === watchId);
  if (!watch) throw new Error('Watched channel not found.');
  const startedAt = new Date().toISOString();
  try {
    const { parsed, videos } = await fetchSourceVideos(watch.sourceUrl);
    const known = new Set([...(watch.knownVideoIds || []), ...db.videos.map(video => video.youtubeId)]);
    const freshVideos = videos.filter(video => !known.has(video.youtubeId));
    const result = addImportedVideos(db, watch.sourceUrl, parsed.type, freshVideos, {
      userId: watch.userId,
      rightsConfirmed: watch.rightsConfirmed,
      fairUseMode: watch.fairUseMode,
      transformationNote: watch.transformationNote,
      watchedChannelId: watch.id
    });
    watch.knownVideoIds = Array.from(new Set([...(watch.knownVideoIds || []), ...videos.map(video => video.youtubeId)]));
    watch.lastCheckedAt = startedAt;
    watch.lastResult = freshVideos.length ? `Found ${freshVideos.length} new long video${freshVideos.length === 1 ? '' : 's'}.` : 'No new long videos found.';
    watch.lastError = '';
    saveDb(db);
    if (watch.autoProcess) {
      for (const video of result.videos) {
        queueBackgroundProcess(video.id, {
          userId: watch.userId,
          rightsConfirmed: true,
          fairUseMode: watch.fairUseMode,
          transformationNote: watch.transformationNote
        });
      }
    }
    return { watch, imported: result.videos.length, queued: watch.autoProcess ? result.videos.length : 0 };
  } catch (error) {
    const failed = loadDb();
    const failedWatch = failed.watchedChannels.find(item => item.id === watchId);
    if (failedWatch) {
      failedWatch.lastCheckedAt = startedAt;
      failedWatch.lastError = error.message;
      failedWatch.lastResult = 'Watcher check failed.';
      saveDb(failed);
    }
    throw error;
  }
}

async function downloadVideo(video, jobId = '') {
  const ytdlpCommand = await workingYtDlpCommand();
  if (!ytdlpCommand) throw new Error('yt-dlp is required to download owned or permissioned source videos.');
  assertYtDlpNotCoolingDown();
  const output = path.join(STORAGE_DIR, 'originals', `${video.youtubeId}.%(ext)s`);
  try {
    await runYtDlpWithClientFallback(
      ytdlpCommand,
      [
        ...ffmpegLocationArgs(),
        '-f', 'bv*[height<=1080]+ba/b[height<=1080]',
        '--merge-output-format', 'mp4',
        '-o', output,
        video.url
      ],
      { jobId, label: 'yt-dlp download', timeoutMs: PROCESS_TIMEOUT_MS }
    );
  } catch (error) {
    importLog('error', 'yt-dlp download failed', { videoId: video.youtubeId, title: video.title, raw: String(error.message || error).slice(0, 1600) });
    throw new Error(friendlyYtDlpError(error));
  }
  const files = await readdir(path.join(STORAGE_DIR, 'originals'));
  const mediaFiles = files
    .filter(file => file.startsWith(video.youtubeId) && /\.(mp4|m4v|mov|webm|mkv|m4a|mp3|opus)$/i.test(file))
    .map(file => path.join(STORAGE_DIR, 'originals', file));
  if (!mediaFiles.length) throw new Error('yt-dlp completed but no media output was found.');

  const inspected = [];
  for (const filePath of mediaFiles) {
    try {
      const info = await probeMedia(filePath, { countPackets: true });
      inspected.push({ ...info, size: statSync(filePath).size });
    } catch (error) {
      importLog('warn', 'downloaded media probe failed', { file: path.basename(filePath), error: String(error.message || error).slice(0, 300) });
    }
  }
  importLog('log', 'yt-dlp downloaded formats', {
    videoId: video.youtubeId,
    formats: inspected.map(summarizeFormat)
  });
  const choice = chooseBestDownloadedMedia(inspected);
  let selected = choice.muxed?.path || '';
  if (!selected && choice.videoOnly && choice.audioOnly) {
    const merged = path.join(STORAGE_DIR, 'originals', `${video.youtubeId}.merged.mp4`);
    await run(FFMPEG, [
      '-y',
      '-i', choice.videoOnly.path,
      '-i', choice.audioOnly.path,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-shortest',
      '-movflags', '+faststart',
      merged
    ], { jobId, label: 'yt-dlp manual merge', timeoutMs: PROCESS_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 });
    const mergedInfo = await probeMedia(merged, { countPackets: true });
    if (!mergedInfo.hasVideo || !mergedInfo.hasAudio) {
      throw new Error('SOURCE_AUDIO_EXTRACTION_FAILED: yt-dlp produced separate streams, but the manual merge did not contain both video and audio.');
    }
    selected = merged;
  }
  if (!selected) {
    throw new Error('SOURCE_AUDIO_EXTRACTION_FAILED: yt-dlp did not provide a usable video+audio file or separate audio stream.');
  }

  const sourceAudio = await inspectSourceAudio(selected);
  if (sourceAudio.status !== SOURCE_AUDIO_PRESENT) {
    throw new Error(`${SOURCE_AUDIO_EXTRACTION_FAILED}: downloaded YouTube source is not audibly valid (${sourceAudio.reason || sourceAudio.status}).`);
  }

  for (const filePath of mediaFiles) {
    if (filePath !== selected && path.basename(filePath) !== `${video.youtubeId}.en.json3`) unlinkQuiet(filePath);
  }
  return selected;
}

async function transcribeAudioWithWhisper(db, mediaPath, videoId) {
  const apiKey = settingValue(db, 'LLM_API_KEY');
  const provider = settingValue(db, 'LLM_PROVIDER') || 'openai';
  const geminiKey = settingValue(db, 'GEMINI_API_KEY');

  // If no Whisper-compatible key but Gemini is available, use Gemini audio transcription.
  // Gemini gives segment-level timing; word-level timing will be estimated from segments.
  if (!apiKey && geminiKey) {
    return transcribeWithGemini(db, mediaPath, videoId, geminiKey);
  }
  if (!apiKey) return [];

  async function transcribeChunk(audioPath, offsetSeconds) {
    const audioBytes = readFileSync(audioPath);
    const boundary = `--------whisper${randomUUID().replace(/-/g, '')}`;
    const fileName = 'audio.mp3';
    const modelName = provider === 'openai' ? 'whisper-1' : 'whisper-1';
    const part1 = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/mpeg\r\n\r\n`);
    const whisperPrompt = 'Transcribe accurately. Include fillers like "um", "uh" only if clearly spoken. Preserve slang and casual speech. Add natural punctuation.';
    const part2 = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${modelName}` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${whisperPrompt}` +
      `\r\n--${boundary}--\r\n`
    );
    const body = Buffer.concat([part1, audioBytes, part2]);
    const whisperEndpoint = 'https://api.openai.com/v1/audio/transcriptions';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let response;
    try {
      response = await fetch(whisperEndpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const errText = await response.text();
      importLog('warn', 'Whisper transcription failed', { status: response.status, body: errText.slice(0, 400), offsetSeconds });
      return { segments: [], words: [] };
    }
    const data = await response.json();
    return {
      segments: (data.segments || []).map(seg => ({
        start: offsetSeconds + Number(seg.start || 0),
        end:   offsetSeconds + Number(seg.end   || seg.start + 2),
        text:  String(seg.text  || '').trim()
      })).filter(seg => seg.text),
      words: (data.words || []).map((w, wordIndex) => {
        const word = String(w.word || '').trim();
        const sourceStart = offsetSeconds + Number(w.start || 0);
        const sourceEnd = offsetSeconds + Number(w.end || w.start + 0.15);
        return {
          id: `whisper_${Math.round(offsetSeconds * 1000)}_${wordIndex}`,
          word,
          text: word,
          start: sourceStart,
          end: sourceEnd,
          sourceStart,
          sourceEnd,
          confidence: Number.isFinite(Number(w.confidence)) ? Number(w.confidence) : null,
          segmentId: null,
          speakerId: null,
          timingSource: 'whisper-word',
        };
      }).filter(w => w.word && Number.isFinite(w.sourceStart))
    };
  }

  try {
    const probe = await probeMediaDuration(mediaPath).catch(() => ({ durationSeconds: 0 }));
    const totalDuration = Math.max(0, Number(probe.durationSeconds || 0));
    const chunks = totalDuration > TRANSCRIPTION_CHUNK_SECONDS
      ? Array.from({ length: Math.ceil(totalDuration / TRANSCRIPTION_CHUNK_SECONDS) }, (_, i) => ({
          start: i * TRANSCRIPTION_CHUNK_SECONDS,
          duration: Math.min(TRANSCRIPTION_CHUNK_SECONDS, totalDuration - i * TRANSCRIPTION_CHUNK_SECONDS)
        }))
      : [{ start: 0, duration: totalDuration || 0 }];

    const segs = [];
    const wordData = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const audioPath = path.join(STORAGE_DIR, 'originals', `${videoId}_audio_${i}.mp3`);
      try {
        const trimArgs = chunk.duration > 0 ? ['-ss', String(chunk.start), '-t', String(chunk.duration)] : [];
        await run(FFMPEG, ['-y', ...trimArgs, '-i', mediaPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '96k', audioPath], { timeoutMs: 3 * 60 * 1000, label: 'extract audio for whisper' });
        if (!existsSync(audioPath) || statSync(audioPath).size < 512) continue;
        const result = await transcribeChunk(audioPath, chunk.start);
        segs.push(...result.segments);
        wordData.push(...result.words);
      } finally {
        unlinkQuiet(audioPath);
      }
    }

    if (wordData.length) {
      writeWordCacheForVideo({ id: videoId }, wordData);
    }
    importLog('log', 'Whisper transcription succeeded', { videoId, chunks: chunks.length, segments: segs.length, words: wordData.length });
    return segs;
  } catch (error) {
    importLog('warn', 'Whisper transcription error', { videoId, error: String(error.message || error).slice(0, 400) });
    return [];
  }
}

// YouTube's auto-caption (json3) format is a ROLLING display timeline, not per-word
// speech alignment: each event's tStartMs is roughly when that phrase begins, but
// dDurationMs is inflated so the next line can visually roll in before the current
// one fades out. Taken at face value, adjacent segments overlap in time (confirmed:
// e.g. "how much time..." reports start=2.48s while the prior segment "The older I
// get..." reports end=4.88s — both cannot be true of one speaker's continuous speech).
// That overlap corrupts downstream word-time estimation (misplaced/garbled words)
// and caption/audio sync. Clip each segment's end to the next segment's start so the
// timeline is monotonic and non-overlapping, matching how the speech actually runs.
function deoverlapCaptionSegments(segments) {
  const sorted = [...(segments || [])]
    .filter(seg => seg && Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.text)
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    const next = sorted[i + 1];
    if (sorted[i].end > next.start) {
      sorted[i] = { ...sorted[i], end: Math.max(sorted[i].start + 0.05, next.start) };
    }
  }
  return sorted;
}

function cleanCaptionWord(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function estimateSpokenWordDuration(word = '') {
  const clean = cleanCaptionWord(word).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const letters = Math.max(1, clean.length);
  const base = 0.12 + letters * 0.035;
  const punctuationTail = /[.!?]$/.test(String(word).trim()) ? 0.08 : 0;
  return Math.max(0.14, Math.min(0.72, base + punctuationTail));
}

function normalizeWordTiming(word, index = 0) {
  const text = cleanCaptionWord(word.word || word.text || '');
  const sourceStart = Number.isFinite(Number(word.sourceStart)) ? Number(word.sourceStart) : Number(word.start);
  const sourceEnd = Number.isFinite(Number(word.sourceEnd)) ? Number(word.sourceEnd) : Number(word.end);
  if (!text || !Number.isFinite(sourceStart)) return null;
  const end = Number.isFinite(sourceEnd) && sourceEnd > sourceStart
    ? sourceEnd
    : sourceStart + estimateSpokenWordDuration(text);
  return {
    id: word.id || `word_${index}`,
    word: text,
    text,
    start: sourceStart,
    end,
    sourceStart,
    sourceEnd: end,
    confidence: Number.isFinite(Number(word.confidence)) ? Number(word.confidence) : null,
    segmentId: word.segmentId ?? null,
    speakerId: word.speakerId ?? null,
    timingSource: word.timingSource || word.source || 'unknown',
  };
}

function finalizeWordEndTimes(words = []) {
  const sorted = words
    .map((word, index) => normalizeWordTiming(word, index))
    .filter(Boolean)
    .sort((a, b) => a.sourceStart - b.sourceStart);
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const previous = out[out.length - 1];
    if (previous && Math.abs(previous.sourceStart - current.sourceStart) < 0.015 && previous.word.toLowerCase() === current.word.toLowerCase()) {
      continue;
    }
    const next = sorted[i + 1];
    const naturalEnd = current.sourceStart + estimateSpokenWordDuration(current.word);
    let sourceEnd = current.sourceEnd;
    if (next && Number.isFinite(next.sourceStart) && next.sourceStart > current.sourceStart) {
      const gapToNext = next.sourceStart - current.sourceStart;
      sourceEnd = gapToNext <= 1.15
        ? next.sourceStart
        : Math.min(next.sourceStart - 0.03, naturalEnd);
    } else if (!sourceEnd || sourceEnd <= current.sourceStart) {
      sourceEnd = naturalEnd;
    }
    sourceEnd = Math.max(current.sourceStart + 0.04, sourceEnd);
    out.push({
      ...current,
      end: sourceEnd,
      sourceEnd,
    });
  }
  return out;
}

function parseYouTubeJson3(raw) {
  const events = Array.isArray(raw?.events) ? raw.events : [];
  const rawSegments = [];
  const rawWords = [];
  events.forEach((event, eventIndex) => {
    if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) return;
    const text = event.segs.map(seg => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const start = Number(event.tStartMs) / 1000;
    const end = (Number(event.tStartMs) + Number(event.dDurationMs || 2000)) / 1000;
    rawSegments.push({ id: `ytseg_${eventIndex}`, start, end, sourceStart: start, sourceEnd: end, text });
    event.segs.forEach((seg, segIndex) => {
      const word = cleanCaptionWord(seg.utf8 || '');
      if (!word) return;
      const sourceStart = (Number(event.tStartMs) + Number(seg.tOffsetMs || 0)) / 1000;
      rawWords.push({
        id: `ytw_${eventIndex}_${segIndex}`,
        word,
        text: word,
        start: sourceStart,
        sourceStart,
        segmentId: `ytseg_${eventIndex}`,
        speakerId: null,
        confidence: null,
        timingSource: Number.isFinite(seg.tOffsetMs) ? 'youtube-json3-word-offset' : 'youtube-json3-event-start',
      });
    });
  });
  return {
    segments: deoverlapCaptionSegments(rawSegments),
    words: finalizeWordEndTimes(rawWords),
  };
}

function wordCachePathsForVideo(video = {}) {
  return [
    video.id ? path.join(STORAGE_DIR, 'originals', `${video.id}_words.json`) : '',
    video.youtubeId ? path.join(STORAGE_DIR, 'originals', `${video.youtubeId}_words.json`) : '',
  ].filter(Boolean);
}

function writeWordCacheForVideo(video, words = []) {
  const normalized = finalizeWordEndTimes(words);
  if (!normalized.length) return normalized;
  for (const wordCachePath of wordCachePathsForVideo(video)) {
    try {
      writeFileSync(wordCachePath, JSON.stringify({
        schema: 'clipforge-word-timeline-v1',
        timingModel: 'source-global',
        words: normalized,
      }, null, 2));
    } catch {}
  }
  return normalized;
}

async function getTranscript(video, mediaPath) {
  const transcriptPath = path.join(STORAGE_DIR, 'originals', `${video.youtubeId}.transcript.json`);
  if (existsSync(transcriptPath)) {
    const cached = JSON.parse(readFileSync(transcriptPath, 'utf8'));
    if (Array.isArray(cached.segments) && cached.segments.length) {
      const json3Path = path.join(STORAGE_DIR, 'originals', `${video.youtubeId}.en.json3`);
      if (existsSync(json3Path) && !wordCachePathsForVideo(video).some(wordPath => existsSync(wordPath))) {
        try {
          const parsed = parseYouTubeJson3(JSON.parse(readFileSync(json3Path, 'utf8')));
          writeWordCacheForVideo(video, parsed.words);
        } catch {}
      }
      // Re-run deoverlap even on cached data: caches written before this fix still
      // carry YouTube's raw overlapping rolling-caption windows.
      return deoverlapCaptionSegments(cached.segments);
    }
  }
  try {
    const ytdlpCommand = await workingYtDlpCommand();
    if (ytdlpCommand) {
      // Was a raw run() call with none of the reliability layers below -- so the main
      // video download could succeed (via client fallback / cookies / proxy tunnel)
      // while this, a completely separate request, got bot-blocked on its own and
      // failed silently, leaving a real video with zero captions and no visible error.
      // Route it through the same fallback chain as every other yt-dlp call.
      await runYtDlpWithClientFallback(ytdlpCommand, ['--skip-download', '--write-auto-subs', '--sub-lang', 'en', '--sub-format', 'json3', '-o', path.join(STORAGE_DIR, 'originals', `${video.youtubeId}.%(ext)s`), video.url]);
    }
  } catch (error) {
    // Auto-captions are best-effort (LLM calls analyze transcripts too, and audio
    // transcription is configured separately) -- but log why, instead of silently
    // producing a video with no captions and no trace of the reason.
    importLog('warn', 'auto-caption fetch failed, proceeding without a transcript', {
      videoId: video.youtubeId,
      raw: String(error?.message || error).slice(0, 400)
    });
  }
  const possible = (await readdir(path.join(STORAGE_DIR, 'originals'))).find(file => file.startsWith(video.youtubeId) && file.endsWith('.json3'));
  if (possible) {
    const raw = JSON.parse(readFileSync(path.join(STORAGE_DIR, 'originals', possible), 'utf8'));
    const { segments, words } = parseYouTubeJson3(raw);
    writeWordCacheForVideo(video, words);
    writeFileSync(transcriptPath, JSON.stringify({ segments }, null, 2));
    return segments;
  }
  throw new Error('No transcript was available. Enable YouTube captions for the source video or add a transcription service before processing.');
}

function buildTranscriptReference(segments = [], maxChars = 30000) {
  const cleanSegments = (segments || [])
    .filter(seg => seg && Number.isFinite(Number(seg.start)) && Number.isFinite(Number(seg.end)) && String(seg.text || '').trim())
    .sort((a, b) => Number(a.start) - Number(b.start));
  const lines = cleanSegments.map(seg => `[${Math.round(Number(seg.start))}-${Math.round(Number(seg.end))}s] ${String(seg.text).replace(/\s+/g, ' ').trim()}`);
  const full = lines.join('\n');
  if (full.length <= maxChars) return full;

  const bucketCount = Math.min(16, Math.max(4, Math.ceil(cleanSegments.length / 40)));
  const perBucket = Math.max(800, Math.floor((maxChars - 220) / bucketCount));
  const buckets = Array.from({ length: bucketCount }, () => []);
  const firstStart = Number(cleanSegments[0]?.start || 0);
  const lastEnd = Number(cleanSegments.at(-1)?.end || firstStart + 1);
  const span = Math.max(1, lastEnd - firstStart);
  for (const seg of cleanSegments) {
    const idx = Math.min(bucketCount - 1, Math.floor(((Number(seg.start) - firstStart) / span) * bucketCount));
    buckets[idx].push(seg);
  }

  const condensed = [];
  for (const bucket of buckets) {
    if (!bucket.length) continue;
    let used = 0;
    for (const seg of bucket) {
      const line = `[${Math.round(Number(seg.start))}-${Math.round(Number(seg.end))}s] ${String(seg.text).replace(/\s+/g, ' ').trim()}`;
      if (used + line.length > perBucket && used > 0) break;
      condensed.push(line);
      used += line.length + 1;
    }
  }
  const prefix = '[Condensed transcript sampled across the full source timeline; every section of the video is represented.]';
  const finalLine = lines.at(-1);
  if (finalLine && !condensed.includes(finalLine)) {
    while (condensed.length && `${prefix}\n${[...condensed, finalLine].join('\n')}`.length > maxChars) {
      condensed.pop();
    }
    condensed.push(finalLine);
  }
  const output = `${prefix}\n${condensed.join('\n')}`;
  return output.length <= maxChars ? output : output.slice(0, maxChars);
}

const VIRAL_HOOKS  = ['secret','mistake','truth','never told','nobody knows','they don\'t want you','most people','you won\'t believe','the real reason','i was wrong','changed my life','don\'t do this','everyone is wrong'];
const EMOTION_WORDS = ['love','hate','angry','scared','shocked','amazing','incredible','insane','crazy','brutal','devastating','life-changing','unbelievable','wild','terrifying','hilarious','heart-breaking','explosive'];
const VALUE_WORDS   = ['how to','step by step','tip','trick','hack','strategy','system','formula','method','framework','blueprint','proven','guaranteed','instantly','immediately','fast'];
const QUESTION_STARTERS = /^(why|what|how|when|who|should|can you|do you|did you|is it|are you|have you)/i;

function scoreMoments(segments, durationSeconds) {
  if (!segments?.length) return [];
  const windows = [];

  for (let i = 0; i < segments.length; i++) {
    // Window sizes must respect the 60s minimum clip length
    for (const targetDur of [60, 90, 120, 180]) {
      const start = segments[i].start;
      const endLimit = start + targetDur;
      const group = [];
      for (let j = i; j < segments.length && segments[j].start < endLimit; j++) group.push(segments[j]);
      if (!group.length) continue;
      const end = Math.min(group.at(-1).end, endLimit);
      const dur = end - start;
      if (dur < 55 || dur > 185) continue;

      const text = group.map(s => s.text).join(' ').toLowerCase();
      const firstLine = group[0].text.trim();
      const lastLine  = group[group.length - 1].text.trim();
      const wordCount = text.split(/\s+/).length;

      // Scoring dimensions
      const hookScore = VIRAL_HOOKS.reduce((s, w) => s + (text.includes(w) ? 18 : 0), 0);
      const emotionScore = EMOTION_WORDS.reduce((s, w) => s + (text.includes(w) ? 10 : 0), 0);
      const valueScore = VALUE_WORDS.reduce((s, w) => s + (text.includes(w) ? 8 : 0), 0);
      const questionScore = QUESTION_STARTERS.test(firstLine) ? 20 : 0;
      const punctScore = (text.match(/[?!]/g) || []).length * 5;
      const densityScore = Math.min(25, Math.round(wordCount / Math.max(1, dur) * 10));
      const openingHookScore = QUESTION_STARTERS.test(firstLine) || firstLine.length < 60 ? 10 : 0;
      // Prefer 60-90s clips (user's minimum is 60s)
      const durationBonus = targetDur >= 60 && targetDur <= 90 ? 12 : 0;
      // Bonus: clip starts at a clean sentence start (capitalized / after punctuation)
      const cleanStartBonus = /^[A-Z"'"'([]/.test(firstLine) ? 8 : 0;
      // Bonus: clip ends on punctuation (complete thought)
      const cleanEndBonus = /[.!?]$/.test(lastLine.replace(/['"'"')\]]+$/, '')) ? 8 : 0;

      const score = Math.min(99, 30 + hookScore + emotionScore + valueScore + questionScore + punctScore + densityScore + openingHookScore + durationBonus + cleanStartBonus + cleanEndBonus);

      windows.push({ start, end, score, text: group.map(s => s.text).join(' '), targetDur });
    }
  }

  // Deduplicate: keep highest-scoring window starting near each position
  return windows
    .sort((a, b) => b.score - a.score)
    .filter((c, _, all) => all.findIndex(o => Math.abs(o.start - c.start) < 40) === all.indexOf(c))
    .slice(0, 6);
}

function buildCaptionText(text) {
  return String(text).split(/\s+/).slice(0, 22).join(' ').replace(/'/g, "\\'");
}

// Windows paths (e.g. C:\ClipForge\...) break ffmpeg's filtergraph parser, which splits
// filter options on ':' — the drive-letter colon needs escaping, and using forward
// slashes avoids also having to double-escape backslashes as the filter escape char.
function ffmpegFilterPath(value = '') {
  return String(value).replace(/\\/g, '/').replace(/:/g, '\\:');
}

function ffmpegText(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/[,;]/g,  ' ')
    .replace(/[\[\]]/g, ' ')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

// ═══════════════════════════════════════════════════════════════════
// RENDERING PIPELINE V3 — Professional AI Clipping Engine
// Stages: black-frame trim → stereo analysis → silence/filler EDL →
//         word-level ASS karaoke → smart portrait + cinematic zoom →
//         audio loudnorm → quality validation
// ═══════════════════════════════════════════════════════════════════

const FILLER_WORDS = new Set([
  'um','uh','uhh','umm','er','ah','hmm','hm',
  'like','literally','basically','right','okay','ok',
  'mhm','well','yeah','yep','yup','so','just','you know',
  'kind of','sort of','i mean','actually','obviously'
]);

const RENDER_PRESETS = {
  tiktok:    { width:1080, height:1920, crf:22, maxrate:'6000k',  bufsize:'12000k', fps:60 },
  reels:     { width:1080, height:1920, crf:22, maxrate:'8000k',  bufsize:'16000k', fps:60 },
  shorts:    { width:1080, height:1920, crf:20, maxrate:'10000k', bufsize:'20000k', fps:60 },
  twitter:   { width:1080, height:1920, crf:24, maxrate:'5000k',  bufsize:'10000k', fps:60 },
  facebook:  { width:1080, height:1920, crf:22, maxrate:'6000k',  bufsize:'12000k', fps:60 },
  linkedin:  { width:1080, height:1920, crf:23, maxrate:'5000k',  bufsize:'10000k', fps:60 },
  universal: { width:1080, height:1920, crf:22, maxrate:'7000k',  bufsize:'14000k', fps:60 },
};

// ASS colors: &HAABBGGRR& (alpha=00 is opaque, FF is transparent)
// Shadow=4 creates deep drop shadow for readability on any background
const ASS_PRESETS = {
  hormozi: {
    name:'Hormozi', font:'Arial Black', size:92, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000FFFF&', outline:'&H00000000&', back:'&H99000000&',
    outlineW:4, shadow:4, borderStyle:1, alignment:2, marginV:260, marginLR:70,
    highlight:'&H0000FFFF&', context:'&H90FFFFFF&',
    phraseSize:3, uppercase:true, spacing:1, fad:'60,40',
  },
  mrbeast: {
    name:'MrBeast', font:'Impact', size:100, bold:0, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H000060FF&', outline:'&H00000000&', back:'&H88000000&',
    outlineW:5, shadow:5, borderStyle:1, alignment:2, marginV:250, marginLR:55,
    highlight:'&H000060FF&', context:'&H80FFFFFF&',
    phraseSize:3, uppercase:true, spacing:2, fad:'50,30',
  },
  podcast: {
    name:'Podcast', font:'Arial', size:68, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000FFFF&', outline:'&H00000000&', back:'&HCC000000&',
    outlineW:2, shadow:3, borderStyle:4, alignment:2, marginV:230, marginLR:90,
    highlight:'&H0000FFFF&', context:'&H99FFFFFF&',
    phraseSize:4, uppercase:false, spacing:0, fad:'40,30',
  },
  minimal: {
    name:'Minimal', font:'Arial', size:58, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H00FFFFFF&', outline:'&H00000000&', back:'&H00000000&',
    outlineW:3, shadow:3, borderStyle:1, alignment:2, marginV:210, marginLR:110,
    highlight:'&H00FFFFFF&', context:'&H88FFFFFF&',
    phraseSize:4, uppercase:false, spacing:0, fad:'35,25',
  },
  luxury: {
    name:'Luxury', font:'Georgia', size:62, bold:0, italic:0,
    primary:'&H00E8E8E8&', secondary:'&H0000D7FF&', outline:'&H00000000&', back:'&H00000000&',
    outlineW:2, shadow:3, borderStyle:1, alignment:2, marginV:240, marginLR:95,
    highlight:'&H0000D7FF&', context:'&H80E8E8E8&',
    phraseSize:4, uppercase:false, spacing:2, fad:'70,50',
  },
  finance: {
    name:'Finance', font:'Arial', size:64, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H00FF7800&', outline:'&H00050505&', back:'&H99000000&',
    outlineW:3, shadow:3, borderStyle:1, alignment:2, marginV:230, marginLR:90,
    highlight:'&H00FF7800&', context:'&H88FFFFFF&',
    phraseSize:4, uppercase:false, spacing:0, fad:'45,30',
  },
  tiktok: {
    name:'TikTok', font:'Arial Black', size:86, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000FFFF&', outline:'&H00000000&', back:'&H00000000&',
    outlineW:4, shadow:4, borderStyle:1, alignment:2, marginV:260, marginLR:65,
    highlight:'&H0000FFFF&', context:'&H80FFFFFF&',
    phraseSize:3, uppercase:true, spacing:1, fad:'45,30',
  },
  instagram: {
    name:'Instagram', font:'Arial', size:70, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H00FF7800&', outline:'&H00000000&', back:'&HCC000000&',
    outlineW:2, shadow:3, borderStyle:4, alignment:2, marginV:245, marginLR:75,
    highlight:'&H00FF7800&', context:'&H88FFFFFF&',
    phraseSize:4, uppercase:false, spacing:0, fad:'50,35',
  },
  bold: {
    name:'Bold', font:'Arial Black', size:84, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000FFFF&', outline:'&H00000000&', back:'&H99000000&',
    outlineW:4, shadow:4, borderStyle:1, alignment:2, marginV:250, marginLR:75,
    highlight:'&H0000FFFF&', context:'&H80FFFFFF&',
    phraseSize:3, uppercase:true, spacing:0, fad:'55,35',
  },
  karaoke: {
    name:'Karaoke', font:'Arial Black', size:78, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000FFFF&', outline:'&H00000000&', back:'&HDD000000&',
    outlineW:2, shadow:2, borderStyle:4, alignment:2, marginV:250, marginLR:80,
    highlight:'&H0000FFFF&', context:'&HBBFFFFFF&',
    phraseSize:4, uppercase:false, spacing:0, fad:'40,25',
  },
  // ── 2026 Elite Viral Styles ──────────────────────────────────────────
  viral: {
    name:'Viral', font:'Arial Black', size:96, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0014F0FF&', outline:'&H00000000&', back:'&H00000000&',
    outlineW:5, shadow:6, borderStyle:1, alignment:2, marginV:270, marginLR:60,
    highlight:'&H0014F0FF&', context:'&H70FFFFFF&',
    phraseSize:3, uppercase:true, spacing:2, fad:'55,35',
  },
  neon: {
    name:'Neon', font:'Arial Black', size:82, bold:-1, italic:0,
    primary:'&H00CCFFEE&', secondary:'&H0000FF99&', outline:'&H00003320&', back:'&H00000000&',
    outlineW:4, shadow:5, borderStyle:1, alignment:2, marginV:255, marginLR:70,
    highlight:'&H0000FF99&', context:'&H88CCFFEE&',
    phraseSize:4, uppercase:true, spacing:1, fad:'50,30',
  },
  fire: {
    name:'Fire', font:'Arial Black', size:88, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H000078FF&', outline:'&H00000000&', back:'&H00000000&',
    outlineW:4, shadow:5, borderStyle:1, alignment:2, marginV:260, marginLR:65,
    highlight:'&H000078FF&', context:'&H80FFFFFF&',
    phraseSize:4, uppercase:true, spacing:1, fad:'50,30',
  },
  cinema: {
    name:'Cinema', font:'Georgia', size:56, bold:0, italic:1,
    primary:'&H00F5F0E0&', secondary:'&H00D4AF37&', outline:'&H00000000&', back:'&HCC000000&',
    outlineW:2, shadow:2, borderStyle:4, alignment:8, marginV:200, marginLR:100,
    highlight:'&H00D4AF37&', context:'&H99F5F0E0&',
    phraseSize:4, uppercase:false, spacing:0, fad:'80,60',
  },
  hype: {
    name:'Hype', font:'Impact', size:112, bold:0, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000EEFF&', outline:'&H00000000&', back:'&H00000000&',
    outlineW:6, shadow:7, borderStyle:1, alignment:2, marginV:280, marginLR:50,
    highlight:'&H0000EEFF&', context:'&H60FFFFFF&',
    phraseSize:2, uppercase:true, spacing:3, fad:'45,25',
  },
  reels: {
    name:'Reels', font:'Arial', size:72, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H00FF6EB4&', outline:'&H00000000&', back:'&HAA000000&',
    outlineW:3, shadow:3, borderStyle:4, alignment:2, marginV:248, marginLR:80,
    highlight:'&H00FF6EB4&', context:'&H90FFFFFF&',
    phraseSize:4, uppercase:false, spacing:0, fad:'60,40',
  },
  faceless: {
    name:'Faceless', font:'Arial', size:64, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0099AAFF&', outline:'&H00000000&', back:'&HBB000000&',
    outlineW:2, shadow:3, borderStyle:4, alignment:2, marginV:235, marginLR:95,
    highlight:'&H0099AAFF&', context:'&H88FFFFFF&',
    phraseSize:4, uppercase:false, spacing:0, fad:'50,40',
  },
  kids: {
    name:'Kids', font:'Arial Rounded MT Bold', size:90, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000EECC&', outline:'&H00220011&', back:'&H00000000&',
    outlineW:5, shadow:4, borderStyle:1, alignment:2, marginV:265, marginLR:60,
    highlight:'&H0000EECC&', context:'&H80FFEECC&',
    phraseSize:4, uppercase:false, spacing:1, fad:'70,50',
  },
};

function assTime(s) {
  const t = Math.max(0, Number(s) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sc = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function assEscape(t) { return String(t).replace(/[{}]/g,'').replace(/\n/g,'\\N'); }

function buildASSFile(words, clipStart, clipEnd, presetName, W=1080, H=1920, faceCyAvg=null) {
  const p   = ASS_PRESETS[presetName] || ASS_PRESETS.bold;
  // Hard cap: 4 words max per phrase for professional creator look
  const SZ  = Math.max(2, Math.min(p.phraseSize || 3, 4));
  const dur = clipEnd - clipStart;

  // Graduated face-aware margin: push captions up proportionally to face Y position
  let dynamicMarginV = p.marginV;
  if (faceCyAvg !== null) {
    if      (faceCyAvg > 0.65) dynamicMarginV = Math.round(p.marginV * 1.85);
    else if (faceCyAvg > 0.50) dynamicMarginV = Math.round(p.marginV * 1.35);
  }

  const cw = words
    .filter(w => w.end > clipStart && w.start < clipEnd)
    .map(w => ({
      word:    assEscape(p.uppercase ? w.word.toUpperCase() : w.word),
      rawWord: (w.word || '').trim(),
      rs:      Math.max(0, w.start - clipStart),
      re:      Math.min(dur, w.end - clipStart),
    }))
    .filter(w => w.re > w.rs + 0.01 && w.word.trim());

  // Enforce strictly non-overlapping timing to prevent caption duplication
  for (let i = 0; i < cw.length - 1; i++) {
    if (cw[i].re > cw[i + 1].rs) {
      cw[i].re = Math.max(cw[i].rs + 0.01, cw[i + 1].rs - 0.001);
    }
  }
  // Caption sync QA: clamp any word that starts earlier than it should
  for (let i = 1; i < cw.length; i++) {
    if (cw[i].rs < cw[i-1].re) cw[i].rs = cw[i-1].re + 0.005;
    if (cw[i].re <= cw[i].rs)  cw[i].re = cw[i].rs + 0.04;
  }

  const header = `[Script Info]
ScriptType: v4.00+
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${p.name},${p.font},${p.size},${p.primary},${p.secondary},${p.outline},${p.back},${p.bold},${p.italic},0,0,100,100,${p.spacing},0,${p.borderStyle},${p.outlineW},${p.shadow},${p.alignment},${p.marginLR},${p.marginLR},${dynamicMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  if (!cw.length) return header;

  // Build caption events -- karaoke-style word-by-word highlighting.
  //
  // Caption sync rules:
  //   - Grouping is visual only; it never invents a display duration.
  //   - Each phrase starts when its first aligned word starts.
  //   - Each phrase remains visible until its last aligned word ends.
  //   - A tiny readability tail is clipped at the next phrase boundary.
  //   - Highlight hand-off follows the next aligned word timestamp.

  // Timing constants -- phrase lifetime is tied to the aligned words, not a timer.
  const READABILITY_TAIL = 0.08; // <= 80ms, clipped before next spoken phrase
  const PAUSE_BREAK      = 0.22; // 220ms silence forces a phrase boundary
  const SENT_END     = /[.!?,;:]$/;

  // ── Emotional / high-impact word detection ────────────────────
  const EMPH_WORDS = new Set([
    'never','always','every','nobody','nothing','everything','everyone','anyone',
    'insane','crazy','unbelievable','impossible','shocking','amazing','incredible',
    'terrible','horrible','awful','perfect','brilliant','genius','stupid','idiot',
    'destroyed','failed','won','lost','fired','arrested','died','killed','exposed',
    'secret','truth','lie','revealed','actually','honestly','literally','seriously',
    'most','best','worst','biggest','smallest','fastest','richest','poorest','only',
    'stop','listen','watch','look','wait','remember','imagine','think','know',
    'million','billion','trillion','thousand','hundred','free','zero','first','last',
    'never','hate','love','fear','money','rich','broke','poor','win','lose',
  ]);
  const NUMBER_RE = /^[\$£€]?[\d,]+([kKmMbBtT%])?$|^\d+[\d,]*[%]$/;

  function emphType(rawWord) {
    const w = rawWord.replace(/[^a-zA-Z0-9$£€%]/g, '').toLowerCase();
    if (EMPH_WORDS.has(w)) return 'emotion';
    if (NUMBER_RE.test(rawWord.trim())) return 'number';
    return null;
  }

  // ── Smart phrase grouping ─────────────────────────────────────
  const phrases = [];
  let i = 0;
  while (i < cw.length) {
    const win  = cw.slice(i, Math.min(i + SZ + 2, cw.length));
    const wDur = Math.max(0.1, win[win.length - 1].re - win[0].rs);
    const wps  = win.length / wDur;

    // Adaptive target: faster speech → shorter phrases (more dynamic)
    let target = SZ;
    if      (wps > 4.5) target = 2;
    else if (wps > 3.5) target = Math.max(2, SZ - 1);
    else if (wps < 1.0) target = Math.min(SZ + 1, 4);

    const phrase = [];
    for (let j = i; j < Math.min(i + target, cw.length); j++) {
      if (j > i && (cw[j].rs - cw[j - 1].re) > PAUSE_BREAK) break;
      phrase.push(cw[j]);
      if (j > i && SENT_END.test(cw[j].rawWord)) break;
    }
    if (!phrase.length) { i++; continue; }
    phrases.push(phrase);
    i += phrase.length;
  }

  // ── Build ASS dialogue events ─────────────────────────────────
  // Each event = one word's highlight window showing the full phrase.
  // Phrase lifetime: first word start → last word end (+ tiny tail only if it does
  // not overlap the next phrase). Visual grouping never changes the timing truth.
  // Instant cut (fad out = 0) = tight sync, no caption overhang.
  const emphSzBig  = Math.round(p.size * 1.14);  // emphasis current word: 14% bigger
  const emphSzCtx  = Math.round(p.size * 0.88);  // emphasis non-current: 12% smaller

  const events = [];
  for (let pi = 0; pi < phrases.length; pi++) {
    const phrase  = phrases[pi];
    const phraseS = phrase[0].rs;
    const lastW   = phrase[phrase.length - 1];
    const phraseE = Math.min(
      lastW.re + READABILITY_TAIL,
      pi < phrases.length - 1 ? phrases[pi + 1][0].rs : lastW.re + READABILITY_TAIL,
      dur
    );
    if (phraseE <= phraseS + 0.01) continue;

    for (let wi = 0; wi < phrase.length; wi++) {
      const w    = phrase[wi];
      const nxtW = phrase[wi + 1];
      if (w.rs < 0 || w.re <= w.rs) continue;

      const evtS = Math.max(phraseS, w.rs);
      let   evtE = nxtW
        ? Math.min(phraseE, Math.max(w.re, nxtW.rs))
        : phraseE;
      if (evtE <= evtS + 0.01) continue;

      const parts = phrase.map((pw, j) => {
        const et = emphType(pw.rawWord);
        if (j === wi) {
          // Current highlighted word — pop with emphasis if high-impact
          return et
            ? `{\\c${p.highlight}\\b1\\fs${emphSzBig}}${pw.word}{\\r}`
            : `{\\c${p.highlight}\\b1}${pw.word}{\\r}`;
        }
        // Non-current words in the same phrase
        return et
          ? `{\\c${p.highlight}\\b1\\fs${emphSzCtx}}${pw.word}{\\r}`  // emph: stay colored
          : `{\\c${p.context}\\b0}${pw.word}`;                          // normal: dim
      });

      // fad(80,0): clean 80ms fade-in, ZERO fade-out = instant hard cut = no caption overhang
      events.push(
        `Dialogue: 0,${assTime(evtS)},${assTime(evtE)},${p.name},,0,0,0,,` +
        `{\\an${p.alignment}\\fad(80,0)}${parts.join(' ')}`
      );
    }
  }
  return header + events.join('\n') + '\n';
}

function clipCaptionWordsToRenderWindow(words = [], outputDuration = 0) {
  const dur = Math.max(0, Number(outputDuration || 0));
  if (!dur) return [];
  return (words || [])
    .map(word => {
      const start = Number(word.start);
      const end = Number(word.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      if (end <= 0 || start >= dur) return null;
      const clippedStart = Math.max(0, start);
      const clippedEnd = Math.min(dur, end);
      if (clippedEnd <= clippedStart + 0.01) return null;
      return {
        ...word,
        start: clippedStart,
        end: clippedEnd,
        renderStart: clippedStart,
        renderEnd: clippedEnd,
        originalRenderStart: start,
        originalRenderEnd: end,
        clippedToRenderWindow: clippedStart !== start || clippedEnd !== end,
      };
    })
    .filter(Boolean);
}

function assessCaptionSync(words = [], options = {}) {
  const enabled = options.enabled !== false;
  if (!enabled) {
    return {
      enabled: false,
      valid: true,
      fatal: false,
      status: CAPTION_SYNC_VALID,
      confidence: 'disabled',
      wordCount: 0,
      estimatedWordCount: 0,
      timingSources: [],
      issues: [],
      reason: 'Generated captions are disabled for this render.',
    };
  }

  const outputDuration = Math.max(0, Number(options.outputDuration || 0));
  const sorted = (words || [])
    .map((word, index) => ({
      index,
      word: cleanCaptionWord(word.word || word.text || ''),
      start: Number(word.start),
      end: Number(word.end),
      timingSource: word.timingSource || word.source || 'unknown',
    }))
    .filter(word => word.word && Number.isFinite(word.start) && Number.isFinite(word.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (!sorted.length) {
    return {
      enabled: true,
      valid: true,
      fatal: false,
      status: WORD_TIMESTAMPS_MISSING,
      confidence: 'missing',
      wordCount: 0,
      estimatedWordCount: 0,
      timingSources: [],
      issues: [WORD_TIMESTAMPS_MISSING],
      reason: 'No usable word timestamps were available; generated captions may be omitted.',
    };
  }

  const issues = [];
  let status = CAPTION_SYNC_VALID;
  let fatal = false;
  let previous = null;
  for (const word of sorted) {
    if (word.start < -0.01) {
      issues.push(`${CAPTION_SYNC_OFFSET_DETECTED}: negative word start ${word.start.toFixed(3)}s for "${word.word}"`);
      status = CAPTION_SYNC_OFFSET_DETECTED;
      fatal = true;
    }
    if (outputDuration && word.end > outputDuration + 0.10) {
      issues.push(`${CAPTION_SYNC_OFFSET_DETECTED}: word "${word.word}" ends after output duration (${word.end.toFixed(3)}s > ${outputDuration.toFixed(3)}s)`);
      status = CAPTION_SYNC_OFFSET_DETECTED;
      fatal = true;
    }
    if (word.end <= word.start) {
      issues.push(`${CAPTION_SYNC_OFFSET_DETECTED}: non-positive word duration for "${word.word}"`);
      status = CAPTION_SYNC_OFFSET_DETECTED;
      fatal = true;
    }
    if (previous && word.start + 0.02 < previous.start) {
      issues.push(`${CAPTION_SYNC_DRIFT_DETECTED}: word timeline moved backwards near "${word.word}"`);
      status = CAPTION_SYNC_DRIFT_DETECTED;
      fatal = true;
    }
    previous = word;
  }

  const timingSources = [...new Set(sorted.map(word => word.timingSource))].sort();
  const estimatedWordCount = sorted.filter(word => /^estimated-|unknown$/.test(String(word.timingSource || 'unknown'))).length;
  if (!fatal && estimatedWordCount > 0) {
    status = CAPTION_ALIGNMENT_LOW_CONFIDENCE;
    issues.push(`${CAPTION_ALIGNMENT_LOW_CONFIDENCE}: ${estimatedWordCount} of ${sorted.length} words use estimated timing.`);
  }

  return {
    enabled: true,
    valid: !fatal,
    fatal,
    status,
    confidence: status === CAPTION_SYNC_VALID ? 'word' : 'low',
    wordCount: sorted.length,
    estimatedWordCount,
    timingSources,
    issues,
    reason: issues[0] || 'Caption timing uses aligned word timestamps.',
  };
}

// ─── Transcript post-processing ──────────────────────────────────
function cleanTranscriptText(text) {
  if (!text) return text;
  // Remove consecutive duplicate words (case-insensitive), e.g. "the the" → "the"
  let cleaned = text.replace(/\b(\w+)(\s+\1)+\b/gi, '$1');
  // Collapse repeated filler words (uh, um, ah) to a single instance
  cleaned = cleaned.replace(/\b(uh|um|ah|er|hmm)(\s+\1)+\b/gi, '$1');
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return cleaned;
}

// ─── Word timing helpers ──────────────────────────────────────────
function estimateWordTimings(segments, clipStart, clipEnd) {
  // Average spoken English: ~2.5 words/sec, but ranges 1.8–3.5 depending on speaker.
  // Use a per-segment estimate rather than a constant rate for better sync.
  const WORDS_PER_SEC = 2.5;
  const MIN_WORD_DUR  = 0.08;  // shortest plausible word (a, I, …)
  const MAX_WORD_DUR  = 0.8;   // longest plausible word before it feels slow

  const words = [];
  for (const seg of (segments || [])) {
    if (!seg.text || seg.end <= clipStart || seg.start >= clipEnd) continue;
    const ws = cleanTranscriptText(seg.text).trim().split(/\s+/).filter(Boolean);
    if (!ws.length) continue;

    const s = Math.max(seg.start, clipStart);
    const e = Math.min(seg.end, clipEnd);
    const segDur = e - s;

    // Estimate duration per word, clamped to plausible range.
    const naturalDur = segDur / ws.length;
    const wordDur = Math.max(MIN_WORD_DUR, Math.min(MAX_WORD_DUR, naturalDur));

    // If natural duration is much faster/slower than average speech,
    // we know the segment timing is probably inaccurate (common with background music).
    // In that case, bias towards speech-rate estimate but anchored at seg.start.
    const rateRatio = segDur / (ws.length / WORDS_PER_SEC);
    const useNatural = rateRatio > 0.4 && rateRatio < 2.5; // segment timing looks plausible

    let t = s;
    ws.forEach((w, i) => {
      const d = useNatural ? naturalDur : (1 / WORDS_PER_SEC);
      const sourceEnd = Math.min(e, t + d);
      words.push({
        word: w,
        text: w,
        start: t,
        end: sourceEnd,
        sourceStart: t,
        sourceEnd,
        confidence: null,
        segmentId: seg.id || null,
        speakerId: seg.speakerId || null,
        timingSource: 'estimated-segment',
      });
      t += d;
    });
  }
  return words;
}

function remapWordTimings(words, edlSegs) {
  let out = 0;
  const mapped = [];
  for (const seg of edlSegs) {
    const segDur = seg.end - seg.start;
    words.filter(w => w.start >= seg.start && w.end <= seg.end + 0.05).forEach(w => {
      mapped.push({
        word: w.word,
        text: w.text || w.word,
        start: out + (w.start - seg.start),
        end: out + (w.end - seg.start),
        sourceStart: w.sourceStart ?? w.start,
        sourceEnd: w.sourceEnd ?? w.end,
        confidence: w.confidence ?? null,
        segmentId: w.segmentId ?? null,
        speakerId: w.speakerId ?? null,
        timingSource: w.timingSource || w.source || 'unknown',
      });
    });
    out += segDur;
  }
  return mapped;
}

// ─── Pipeline Stage 1: Black frame detection ──────────────────────
async function detectContentStart(mediaPath, clipStart) {
  try {
    const { stderr } = await run(FFMPEG, [
      '-ss', String(clipStart), '-t', '3.5', '-i', mediaPath,
      '-vf', 'blackdetect=d=0.05:pix_th=0.10', '-an', '-f', 'null', '-'
    ], { label:'blackdetect', timeoutMs:30_000 });
    const ends = [...stderr.matchAll(/black_end:([\d.]+)/g)].map(m => parseFloat(m[1]));
    return ends.length ? Math.min(Math.max(...ends), 2.5) : 0;
  } catch { return 0; }
}

// ─── Pipeline Stage 2: Silence detection ─────────────────────────
async function detectSilences(mediaPath, clipStart, clipEnd) {
  try {
    const { stderr } = await run(FFMPEG, [
      '-ss', String(clipStart), '-to', String(clipEnd), '-i', mediaPath,
      '-af', 'silencedetect=n=-35dB:d=0.35', '-vn', '-f', 'null', '-'
    ], { label:'silencedetect', timeoutMs:60_000 });
    const silences = [];
    const ss = [...stderr.matchAll(/silence_start:([\d.]+)/g)].map(m => parseFloat(m[1]));
    const se = [...stderr.matchAll(/silence_end:([\d.]+)/g)].map(m   => parseFloat(m[1]));
    for (let i = 0; i < ss.length; i++) {
      const start = ss[i];
      const end   = se[i] ?? (clipEnd - clipStart);
      const dur   = end - start;
      if (dur > 0.35) silences.push({ start, end });
    }
    return silences;
  } catch { return []; }
}

// ─── Pipeline Stage 2b: Stereo speaker analysis ──────────────────
// Analyze which stereo channel (L/R) has more energy to find the
// dominant speaker zone. Returns 'left', 'right', or 'center'.
async function detectSpeakerSide(mediaPath, clipStart, clipEnd) {
  try {
    const dur = Math.min(clipEnd - clipStart, 10);
    const { stderr } = await run(FFMPEG, [
      '-ss', String(clipStart), '-t', String(dur), '-i', mediaPath,
      '-filter_complex', 'channelsplit=channel_layout=stereo[L][R];[L]volumedetect[Lv];[R]volumedetect[Rv]',
      '-map', '[Lv]', '-map', '[Rv]', '-f', 'null', '-'
    ], { label:'stereo-analysis', timeoutMs:20_000 });
    const meanL = parseFloat((stderr.match(/\[Parsed_volumedetect_0[^\n]*mean_volume:([\-\d.]+)/)?.[1]) || '0');
    const meanR = parseFloat((stderr.match(/\[Parsed_volumedetect_1[^\n]*mean_volume:([\-\d.]+)/)?.[1]) || '0');
    const diff  = meanL - meanR;
    if (Math.abs(diff) < 2) return 'center';
    return diff > 0 ? 'left' : 'right';
  } catch { return 'center'; }
}

// ─── Pipeline Stage 3: Edit Decision List ────────────────────────
function buildEDL(words, silences, clipStart, clipEnd, blackOffset) {
  const absStart = clipStart + blackOffset;
  const relDur   = clipEnd - absStart;

  const fillerRanges = words
    .filter(w => FILLER_WORDS.has(w.word.toLowerCase().replace(/[^a-z]/g, '')))
    .map(w => ({ start: w.start - clipStart, end: w.end - clipStart }));

  const allCuts = [...silences, ...fillerRanges]
    .filter(c => c.end - c.start > 0.35 && c.start > 0.2 && c.end < relDur - 0.3)
    .sort((a, b) => a.start - b.start);

  const segs = [];
  let cursor = absStart;
  for (const cut of allCuts) {
    const ca = { start: clipStart + cut.start, end: clipStart + cut.end };
    if (ca.start > cursor + 0.5) segs.push({ start: cursor, end: ca.start });
    cursor = ca.end;
  }
  segs.push({ start: cursor, end: clipEnd });
  const valid = segs.filter(s => s.end - s.start > 0.6);
  return valid.length ? valid : [{ start: absStart, end: clipEnd }];
}

// ─── Pipeline Stage 4: Camera Director ───────────────────────────
async function probeVideoDims(mediaPath) {
  // ffprobe reads container/stream metadata only — near-instant regardless of video
  // length. The previous implementation ran `ffmpeg -f null -`, which fully decodes the
  // entire file just to read its dimensions from the stderr banner; on longer sources
  // (exactly what Full Series targets) that routinely exceeded the 15s timeout, silently
  // fell back to a hardcoded 1920x1080 guess, and corrupted every crop filter downstream
  // whenever the real source wasn't actually that resolution.
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0', mediaPath
    ], { label: 'probe-dims', timeoutMs: 15_000 });
    const [w, h] = stdout.trim().split('x').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
  } catch {}
  return { w: 1920, h: 1080 };
}

// ─── HDR detection + tone-map-to-SDR ─────────────────────────────
// Only ever applied when the source is actually flagged HDR (HLG/PQ transfer
// characteristics) — never touches normal SDR input.
async function detectHDR(mediaPath) {
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=color_transfer,color_primaries,color_space',
      '-of', 'json', mediaPath
    ], { label: 'probe-hdr', timeoutMs: 15_000 });
    const stream = (JSON.parse(stdout || '{}').streams || [])[0] || {};
    const transfer = String(stream.color_transfer || '').toLowerCase();
    const isHDR = transfer.includes('smpte2084') || transfer.includes('arib-std-b67');
    return { isHDR, transfer, primaries: stream.color_primaries || '', colorSpace: stream.color_space || '' };
  } catch {
    return { isHDR: false, transfer: '', primaries: '', colorSpace: '' };
  }
}

let _tonemapFilterAvailable = null;
async function tonemapFilterAvailable() {
  if (_tonemapFilterAvailable !== null) return _tonemapFilterAvailable;
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-filters'], { label: 'probe-filters', timeoutMs: 10_000 });
    _tonemapFilterAvailable = /\bzscale\b/.test(stdout) && /\btonemap\b/.test(stdout);
  } catch {
    _tonemapFilterAvailable = false;
  }
  return _tonemapFilterAvailable;
}

async function mediaHasAudio(mediaPath) {
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', mediaPath
    ], { label:'probe-audio', timeoutMs:15_000 });
    return stdout.trim().includes('audio');
  } catch {
    return false;
  }
}

const FACE_TRACK_SCRIPT = path.join(__dirname, 'face_track.py');
let _faceTrackAvailable = null;

const PYTHON3 = '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9';

async function faceTrackAvailable() {
  if (_faceTrackAvailable !== null) return _faceTrackAvailable;
  try {
    const py = existsSync(PYTHON3) ? PYTHON3 : 'python3';
    const { stdout } = await new Promise((resolve, reject) => {
      const p = spawn(py, ['-c', 'import cv2; print("ok")'], { stdio:['pipe','pipe','pipe'] });
      let out='', err='';
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => err += d);
      p.on('close', code => code === 0 ? resolve({ stdout:out }) : reject(new Error(err)));
    });
    _faceTrackAvailable = stdout.trim() === 'ok' && existsSync(FACE_TRACK_SCRIPT);
  } catch { _faceTrackAvailable = false; }
  return _faceTrackAvailable;
}

async function trackFaces(mediaPath, start, end) {
  try {
    if (!await faceTrackAvailable()) return null;
    const py = existsSync(PYTHON3) ? PYTHON3 : 'python3';
    const { stdout } = await new Promise((resolve, reject) => {
      const p = spawn(py, [FACE_TRACK_SCRIPT, mediaPath, String(start), String(end), '5'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let out = '', err = '';
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => err += d);
      p.on('close', code => {
        if (code === 0) resolve({ stdout: out });
        else reject(new Error(`face_track exit ${code}: ${err.slice(0,200)}`));
      });
      setTimeout(() => p.kill(), 60000);
    });
    return JSON.parse(stdout.trim());
  } catch (e) {
    console.warn('[face-track:skip]', e.message?.slice(0,100));
    return null;
  }
}

// ─── Auto-Reframe Engine v5 ───────────────────────────────────────
//
// ARCHITECTURE: "Cinematic Virtual Camera with Smooth Temporal Tracking"
//
// Key improvements over v4:
//   • Per-frame keyframe tracking: camera follows subjects smoothly
//   • Scene-type-aware framing: interview/podcast/group get different rules
//   • Dynamic crop X expression: smooth FFmpeg per-frame evaluation (non-EDL)
//   • Per-segment crop positions for EDL (accurate even after silence removal)
//   • Blurred background fill: NO black bars, always fills 9:16 completely
//   • Motion prediction already applied by face_track.py (velocity-based leading)
//
// buildPortraitFilter() returns an INFO OBJECT consumed by renderClip.
// renderClip chooses between:
//   EDL path:     per-segment static crop X (keyframe average per segment)
//   non-EDL path: dynamic FFmpeg crop=...eval=frame expression (smooth tracking)

// ── Helper: piecewise-linear FFmpeg expressions for smooth crop X + W ─
// Returns { xExpr, wExpr } — both evaluated per-frame by FFmpeg.
// wExpr enables gentle dynamic zoom when v7 keyframes carry per-frame cropFrac.
function buildCropExprs(keyframes, globalCropW, srcW, timeOffset = 0) {
  const defaultX = Math.max(0, Math.min(srcW - globalCropW, Math.round(0.5 * srcW - globalCropW / 2)));

  if (!keyframes || keyframes.length === 0) {
    return { xExpr: String(defaultX), wExpr: String(globalCropW) };
  }

  const hasQuality = keyframes.some(kf => kf.quality != null);
  const goodKfs    = hasQuality ? keyframes.filter(kf => (kf.quality ?? 50) >= 35) : keyframes;
  const useKfs     = goodKfs.length >= 2 ? goodKfs : keyframes;

  const pts = useKfs
    .map(kf => {
      const w = Math.max(2, Math.round(Math.min(srcW, (kf.cropFrac ?? (globalCropW / srcW)) * srcW) / 2) * 2);
      return {
        t: Math.max(0, kf.t - timeOffset),
        w: w,
        x: Math.max(0, Math.min(srcW - w, Math.round(kf.cx * srcW - w / 2))),
      };
    })
    .filter(p => p.t >= -0.1)
    .sort((a, b) => a.t - b.t);

  if (pts.length === 0) return { xExpr: String(defaultX), wExpr: String(globalCropW) };
  if (pts.length === 1) return { xExpr: String(pts[0].x), wExpr: String(pts[0].w) };

  function buildPwl(vals, key) {
    let expr = String(vals[vals.length - 1][key]);
    for (let i = vals.length - 2; i >= 0; i--) {
      const v0 = vals[i][key], v1 = vals[i+1][key];
      const t0 = vals[i].t,  t1 = vals[i+1].t;
      const dt = Math.max(0.001, t1 - t0);
      if (Math.abs(v1 - v0) < 4) {
        expr = `if(lt(t,${t1.toFixed(3)}),${v0},${expr})`;
      } else {
        const dv   = v1 - v0;
        const lerp = `round(${v0}+${dv}*clamp((t-${t0.toFixed(3)})/${dt.toFixed(3)},0,1))`;
        expr = `if(lt(t,${t1.toFixed(3)}),${lerp},${expr})`;
      }
    }
    return expr;
  }

  // Only emit a dynamic W expression when there is meaningful zoom variation (>8px)
  const wMin = Math.min(...pts.map(p => p.w));
  const wMax = Math.max(...pts.map(p => p.w));
  const wExpr = (wMax - wMin) > 8 ? buildPwl(pts, 'w') : String(pts[Math.floor(pts.length/2)].w);
  const xExpr = buildPwl(pts, 'x');

  return { xExpr, wExpr };
}

// Keep the old single-value helper for callers that only need X
function buildCropXExpr(keyframes, cropW, srcW, timeOffset = 0) {
  return buildCropExprs(keyframes, cropW, srcW, timeOffset).xExpr;
}

// ── Helper: best static crop X for a time range (for EDL segments) ─
function getSegmentCropX(keyframes, segStart, segEnd, momentStart, cropW, srcW) {
  const defaultX = Math.max(0, Math.min(srcW - cropW, Math.round(0.5 * srcW - cropW / 2)));
  if (!keyframes || keyframes.length === 0) return defaultX;

  // Convert absolute segment times to clip-relative
  const relStart = segStart - momentStart - 0.4;
  const relEnd   = segEnd   - momentStart + 0.4;

  const pool = keyframes.filter(kf => kf.t >= relStart && kf.t <= relEnd);
  const src  = pool.length > 0 ? pool : keyframes;

  // Weight by both confidence and v6 quality score (ignores floor/shoe shots)
  const totalConf = src.reduce((s, kf) => {
    const q = (kf.quality ?? 50) / 100;
    return s + (kf.confidence || 0.7) * Math.max(0.1, q);
  }, 0) || 1;
  const avgCx = src.reduce((s, kf) => {
    const q = (kf.quality ?? 50) / 100;
    return s + kf.cx * (kf.confidence || 0.7) * Math.max(0.1, q);
  }, 0) / totalConf;

  return Math.max(0, Math.min(srcW - cropW, Math.round(avgCx * srcW - cropW / 2)));
}

// ── Main reframe analysis ────────────────────────────────────────────
//
// Returns info object consumed by renderClip. Does NOT return filter strings —
// those are built in renderClip to allow EDL vs. non-EDL differentiation.
//
// Return type:
// {
//   type:         'fill' | 'blurred',  — blurred when cropFrac > tightFrac
//   cropW:        number,              — crop width in source pixels
//   cropH:        number,              — = srcH (always full source height)
//   scaledH:      number,              — fg height after scale to outW
//   bgFilter:     string,              — static blur-fill filter chain
//   globalCropX:  number,              — best single crop X (global average)
//   keyframes:    array,               — from face_track.py for dynamic tracking
//   momentStart:  number,              — set by caller for EDL segment mapping
//   srcW, srcH, outW, outH
// }
function buildPortraitFilter(srcW=1920, srcH=1080, outW=1080, outH=1920,
                              speakerSide='center', clipDuration=30,
                              faceData=null, framingMode='dynamic') {

  // ── Portrait / square source: scale-to-fill + center-crop ─────────
  if (srcH >= srcW) {
    const sf = Math.max(outW / srcW, outH / srcH);
    const sW = Math.ceil(srcW * sf / 2) * 2;
    const sH = Math.ceil(srcH * sf / 2) * 2;
    const gx = Math.floor((sW - outW) / 2);
    const gy = Math.floor((sH - outH) / 2);
    return {
      type: 'fill', cropW: outW, cropH: outH, scaledH: outH,
      bgFilter: '', globalCropX: 0, keyframes: [],
      momentStart: 0, srcW, srcH, outW, outH,
      portraitFill: `scale=${sW}:${sH}:flags=lanczos,crop=${outW}:${outH}:${gx}:${gy},setsar=1`,
    };
  }

  // ── Landscape → portrait ───────────────────────────────────────────

  const portAspect = outW / outH;               // 9/16 = 0.5625
  const tightFrac  = portAspect * (srcH / srcW); // exact fill, ~0.3164 for 1920×1080

  // ── Face data from face_track.py v5 ───────────────────────────────
  const keyframes   = faceData?.keyframes   ?? [];
  const sceneType   = faceData?.sceneType   ?? 'single_speaker';
  const faceCount   = faceData?.faceCount   ?? 1;
  const hasFaces    = (faceData?.totalDets  ?? 0) > 0;
  const rangeCX     = faceData?.rangeCX     ?? 0;
  const meanFaceX   = faceData?.meanFaceX   ?? (speakerSide === 'left' ? 0.35 : speakerSide === 'right' ? 0.65 : 0.5);
  const avgConfidence = keyframes.length
    ? keyframes.reduce((sum, kf) => sum + Number(kf.confidence || 0), 0) / keyframes.length
    : 0;
  const lowTrackingConfidence = !hasFaces || keyframes.length < 4 || avgConfidence < 0.45;
  const minDynamicCropFrac = lowTrackingConfidence
    ? 0.46
    : faceCount >= 2 || sceneType === 'group'
      ? 0.42
      : sceneType === 'close_up'
        ? 0.36
        : 0.38;

  // Use globalCropFrac from face_track.py if available (scene-aware)
  const suggestedFrac  = faceData?.globalCropFrac ?? 0;
  const framingModeAI  = faceData?.framingMode    ?? '';

  // ── Crop fraction ──────────────────────────────────────────────────
  // framingMode values:
  //   'tight'   — fills 9:16 completely with NO blur bars, guaranteed
  //   'close'   — slight crop, nearly fills without bars
  //   'medium'  — moderate zoom
  //   'wide'    — generous breathing room (may have blur fill)
  //   'original'— shows ~85% of source width
  //   'dynamic' — trust face_track v7 suggestion (default)
  let cropFrac;
  if (framingMode === 'tight') {
    cropFrac = tightFrac;                  // exact fill: scaledH === outH, no bars ever
  } else if (framingMode === 'close') {
    cropFrac = tightFrac * 1.25;           // slight breathing room, usually no bars
  } else if (framingMode === 'medium') {
    cropFrac = sceneType === 'group' ? 0.44 : sceneType === 'interview' ? 0.40 : 0.36;
  } else if (framingMode === 'wide') {
    cropFrac = sceneType === 'group' ? 0.52 : sceneType === 'interview' ? 0.44 : 0.42;
  } else if (framingMode === 'original') {
    cropFrac = 0.50;
  } else {
    // 'dynamic': trust face tracking, but never let low-confidence crops zoom in
    // so far that faces, captions, hands, or on-screen objects are clipped.
    if (suggestedFrac > 0.01 && !lowTrackingConfidence) {
      cropFrac = Math.max(suggestedFrac, minDynamicCropFrac);
    } else if (!hasFaces) {
      // Tried tightening this to 0.42 to reduce blur padding on single-character
      // cartoon shots (common when face_track.py's human-face detector doesn't fire
      // on stylized characters). Reverted after a live production re-render showed
      // it cropping real content in scenes this function can't distinguish from that
      // case without actual content-bounds detection: wide on-screen text/title
      // cards clipped at both edges, and multi-character scenes with one character
      // cut off at the frame boundary. Losing real content is worse than extra blur,
      // so this stays at the safe (wider) default until real saliency/content-bounds
      // detection exists to tell the two situations apart. See PR discussion for the
      // before/after contact-sheet evidence.
      cropFrac = 0.50;
    } else {
      switch (sceneType) {
        case 'group':          cropFrac = 0.50; break;
        case 'interview':      cropFrac = faceCount >= 2 ? 0.44 : 0.40; break;
        case 'podcast':        cropFrac = faceCount >= 2 ? 0.42 : 0.38; break;
        case 'reaction':       cropFrac = 0.38; break;
        case 'wide_shot':      cropFrac = 0.50; break;
        case 'close_up':       cropFrac = 0.36; break;
        default:               cropFrac = rangeCX > 0.20 ? 0.42 : 0.38;
      }
      if (lowTrackingConfidence) cropFrac = Math.max(cropFrac, minDynamicCropFrac);
    }
  }
  cropFrac = Math.max(tightFrac, Math.min(0.92, cropFrac));

  // ── Compute crop dimensions ────────────────────────────────────────
  const cropW = Math.max(2, Math.round(Math.min(srcW, cropFrac * srcW) / 2) * 2);
  const cropH = srcH;

  // ── Global crop X: quality + confidence weighted average ─────────
  // Skip frames with quality < 35 (floor shots, shoe shots, empty frames).
  let globalCx;
  if (keyframes.length > 0) {
    const goodKfs = keyframes.filter(kf => (kf.quality ?? 50) >= 35);
    const srcKfs  = goodKfs.length >= 2 ? goodKfs : keyframes;
    const totalW  = srcKfs.reduce((s, kf) => {
      const q = (kf.quality ?? 50) / 100;
      return s + (kf.confidence || 0.7) * Math.max(0.1, q);
    }, 0) || 1;
    globalCx = srcKfs.reduce((s, kf) => {
      const q = (kf.quality ?? 50) / 100;
      return s + kf.cx * (kf.confidence || 0.7) * Math.max(0.1, q);
    }, 0) / totalW;
  } else {
    globalCx = Math.max(0.08, Math.min(0.92, meanFaceX));
  }
  const halfW       = cropW / 2;
  const globalCropX = Math.max(0, Math.min(srcW - cropW, Math.round(globalCx * srcW - halfW)));

  // ── Scaled foreground height ───────────────────────────────────────
  const scaledH = Math.round(srcH * outW / cropW / 2) * 2;

  // Fill scenario: if fg almost fills output height (within 8%), scale up to fill fully.
  // This happens when cropFrac is close to tightFrac — just a tiny extra zoom, no bars.
  const nearFill  = scaledH >= outH * 0.92;
  const needsBlur = !nearFill && scaledH < outH - 4;

  // ── Background filter factory ──────────────────────────────────────
  // CRITICAL CHANGE from v5: background is now built from the SAME CROP as
  // the foreground (not the whole source frame).
  // This means the blurred background shows the same content as the fg (just
  // blurred/desaturated) — no distracting faces/objects outside the framing,
  // and the bg feels intentional rather than "AI cropped."
  //
  // bgFilterFor(cropX, cropW_): returns FFmpeg filter chain for a STATIC crop.
  // Used in EDL segments where each segment has a fixed cropX.
  const bgFilterFor = (cropX, cropW_) =>
    `crop=${cropW_ ?? cropW}:${cropH}:${cropX}:0,` +
    `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${outW}:${outH},` +
    `gblur=sigma=55,` +
    `eq=saturation=0.55:brightness=-0.06`;

  // bgFilterDynamic(xExpr, wExpr): FFmpeg filter for per-frame evaluated crop.
  // Used in non-EDL path where crop position changes every frame.
  const bgFilterDynamic = (xExpr, wExpr) =>
    `crop=w='${wExpr}':h=${cropH}:x='${xExpr}':y=0,` +
    `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${outW}:${outH},` +
    `gblur=sigma=55,` +
    `eq=saturation=0.55:brightness=-0.06`;

  return {
    type:          needsBlur ? 'blurred' : 'fill',
    cropW,
    cropH,
    scaledH:       nearFill ? outH : (needsBlur ? scaledH : outH),
    bgFilterFor,
    bgFilterDynamic,
    bgFilter:      bgFilterFor(globalCropX),  // kept for fallback path compat
    globalCropX,
    keyframes,
    momentStart: 0,
    srcW, srcH, outW, outH,
  };
}

// ─── Pipeline Stage 5: Quality validator ─────────────────────────
function parseFrameRate(value = '0/1') {
  const [num, den] = String(value).split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

async function validateClipRender(outputPath, options = {}) {
  const scores = { captions:90, framing:88, audioSync:95, stability:90, overall:0 };
  const issues = [];
  const fatalIssues = [];
  const sourceAudioInfo = options.sourceAudioInfo || {};
  const sourceHasAudibleAudio = sourceAudioInfo.status === SOURCE_AUDIO_PRESENT;
  let audio = {
    sourceStatus: sourceAudioInfo.status || '',
    finalStatus: FINAL_AUDIO_MISSING,
    hasAudio: false,
    duration: 0,
    packets: 0,
    bitRate: 0,
    meanVolumeDb: null,
    maxVolumeDb: null,
    failureReason: '',
  };
  try {
    // Check dimensions, framerate, duration, codec via ffprobe
    const { stdout: probeOut } = await run(FFPROBE, [
      '-v', 'quiet', '-count_packets', '-print_format', 'json', '-show_streams', '-show_format', outputPath
    ], { label:'validate-probe', timeoutMs:20_000 }).catch(() => ({ stdout:'{}' }));

    const probe = JSON.parse(probeOut || '{}');
    const vStream = (probe.streams || []).find(s => s.codec_type === 'video');
    const aStream = (probe.streams || []).find(s => s.codec_type === 'audio');
    const videoDuration = numberOrNull(vStream?.duration) ?? numberOrNull(probe.format?.duration) ?? 0;

    if (vStream) {
      const w = vStream.width || 0;
      const h = vStream.height || 0;
      if (w !== 1080 || h !== 1920) {
        issues.push(`Dimensions ${w}x${h} (expected 1080x1920)`); scores.framing -= 10;
      }
      if (vStream.sample_aspect_ratio && vStream.sample_aspect_ratio !== '1:1') {
        issues.push(`Non-square pixels: SAR ${vStream.sample_aspect_ratio}`); scores.framing -= 6;
      }
      const fps = parseFrameRate(vStream.r_frame_rate || '30/1');
      if (fps < 29) { issues.push(`Low framerate: ${fps.toFixed(1)}fps`); scores.stability -= 8; }
      const bitrate = Number(probe.format?.bit_rate || 0);
      if (bitrate > 0 && bitrate < 2_000_000) { issues.push('Low bitrate'); scores.framing -= 5; }
    }

    if (!aStream) {
      audio.finalStatus = FINAL_AUDIO_MISSING;
      audio.failureReason = 'No audio stream found in rendered output.';
      issues.push('FINAL_AUDIO_MISSING');
      fatalIssues.push('FINAL_AUDIO_MISSING');
      scores.audioSync -= 40;
    } else {
      audio = {
        ...audio,
        hasAudio: true,
        finalStatus: FINAL_AUDIO_VALID,
        duration: numberOrNull(aStream.duration) ?? numberOrNull(probe.format?.duration) ?? 0,
        packets: numberOrNull(aStream.nb_read_packets) ?? numberOrNull(aStream.nb_frames) ?? 0,
        bitRate: numberOrNull(aStream.bit_rate) ?? 0,
      };
      if (audio.packets <= 0) {
        audio.failureReason = 'Audio stream has no readable packets.';
        issues.push('FINAL_AUDIO_MISSING: no audio packets');
        fatalIssues.push('FINAL_AUDIO_MISSING');
        scores.audioSync -= 35;
      }
      if (videoDuration && audio.duration && Math.abs(videoDuration - audio.duration) > 1.5) {
        issues.push(`Audio/video duration mismatch: audio ${audio.duration.toFixed(2)}s vs video ${videoDuration.toFixed(2)}s`);
        fatalIssues.push('FINAL_AUDIO_DURATION_MISMATCH');
        scores.audioSync -= 25;
      }
      const volume = await measureAudioVolume(outputPath);
      audio.meanVolumeDb = volume.meanVolumeDb;
      audio.maxVolumeDb = volume.maxVolumeDb;
      const silent = isEffectivelySilent(volume.maxVolumeDb);
      if (silent) {
        audio.finalStatus = FINAL_AUDIO_SILENT;
        audio.failureReason = `Maximum volume ${volume.maxVolumeDb ?? 'unknown'} dB is effectively digital silence.`;
        issues.push('FINAL_AUDIO_SILENT');
        if (sourceHasAudibleAudio) {
          fatalIssues.push('FINAL_AUDIO_SILENT');
          scores.audioSync -= 45;
        }
      }
      if (sourceHasAudibleAudio && audio.bitRate > 0 && audio.bitRate < MIN_AUDIBLE_AUDIO_BITRATE) {
        issues.push(`Implausibly tiny audio bitrate: ${audio.bitRate} bps`);
        fatalIssues.push('FINAL_AUDIO_TINY_BITRATE');
        scores.audioSync -= 20;
      }
    }

    const decode = await run(FFMPEG, [
      '-v', 'error', '-i', outputPath, '-f', 'null', '-'
    ], { label:'validate-decode', timeoutMs:90_000, maxOutputBytes:512 * 1024 }).catch(e => ({ error: e.message || String(e) }));
    if (decode.error) {
      issues.push('Output decode failed');
      fatalIssues.push('FINAL_DECODE_FAILED');
      scores.stability -= 35;
    }

    // Quick black frame check at start
    const r = await run(FFMPEG, [
      '-t', '2', '-i', outputPath, '-vf', 'blackdetect=d=0.03:pix_th=0.08', '-f', 'null', '-'
    ], { label:'validate-black', timeoutMs:20_000 }).catch(e => ({ stderr:e.message||'' }));
    if (r.stderr.includes('black_start:0.0')) {
      issues.push('Black frames at opening'); scores.framing -= 12;
    }

    // Same check at the very end — catches render glitches that land a Full Series
    // part (or any clip) on a black final frame, which reads as a broken cut to viewers.
    if (videoDuration > 2.1) {
      const rEnd = await run(FFMPEG, [
        '-ss', String(Math.max(0, videoDuration - 2)), '-i', outputPath,
        '-vf', 'blackdetect=d=0.03:pix_th=0.08', '-f', 'null', '-'
      ], { label:'validate-black-end', timeoutMs:20_000 }).catch(e => ({ stderr:e.message||'' }));
      if (/black_start/.test(rEnd.stderr) && !/black_end/.test(rEnd.stderr)) {
        issues.push('Black frames at closing (clip ends on black)'); scores.framing -= 12;
      }
    }

    // Frozen-frame check across the whole output — a stuck/frozen frame reads as a
    // broken render, especially mid-timeline in a Full Series part.
    const freeze = await run(FFMPEG, [
      '-i', outputPath, '-vf', 'freezedetect=n=-30dB:d=1.0', '-an', '-f', 'null', '-'
    ], { label:'validate-freeze', timeoutMs:30_000 }).catch(e => ({ stderr:e.message||'' }));
    const freezeStarts = [...(freeze.stderr || '').matchAll(/freeze_start:([\d.]+)/g)].map(m => parseFloat(m[1]));
    if (freezeStarts.length) {
      issues.push(`Frozen frame(s) detected at ${freezeStarts.map(t => t.toFixed(1)).join(', ')}s`);
      scores.stability -= 15;
    }

    // Duration-range check: catches exactly the class of bug where the declared/planned
    // window is normal but the actual rendered output collapses to a few seconds (e.g. a
    // silence/EDL pipeline over-cutting a part). Only enforced when the caller supplies
    // an expected duration (series parts; optionally viral clips).
    if (options.expectedDuration) {
      const expected = Number(options.expectedDuration);
      const minAllowed = Number(options.minDurationSeconds ?? Math.max(3, expected * 0.5));
      const tolerance = Math.max(3, expected * 0.15);
      if (videoDuration > 0 && videoDuration < minAllowed) {
        issues.push(`PART_DURATION_INVALID: rendered ${videoDuration.toFixed(1)}s vs expected ~${expected.toFixed(1)}s (below minimum ${minAllowed.toFixed(1)}s)`);
        fatalIssues.push('PART_DURATION_INVALID');
        scores.stability -= 40;
      } else if (videoDuration > 0 && Math.abs(videoDuration - expected) > tolerance) {
        issues.push(`Duration drift: rendered ${videoDuration.toFixed(1)}s vs expected ${expected.toFixed(1)}s`);
        scores.stability -= 10;
      }
    }

    // Check file size is reasonable
    try {
      const stat = statSync(outputPath);
      if (stat.size < 50_000) { issues.push('File too small (<50KB)'); scores.framing -= 20; }
    } catch {}

  } catch {}
  scores.overall = Math.round((scores.captions + scores.framing + scores.audioSync + scores.stability) / 4);
  return { valid: fatalIssues.length === 0, scores, issues, fatalIssues, audio };
}

// ─── Logo upload helper ───────────────────────────────────────────────────────
function streamUploadedLogo(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { files: 1, fields: 10, fileSize: 8 * 1024 * 1024 } });
    const fields = {};
    let upload = null;
    let done = false;
    const fail = err => { if (!done) { done = true; reject(err); } };
    busboy.on('field', (name, val) => { fields[name] = String(val || '').slice(0, 500); });
    busboy.on('file', (field, file, info) => {
      const ext = path.extname(info.filename || 'logo.png').toLowerCase();
      if (!['.png','.jpg','.jpeg','.webp'].includes(ext)) {
        file.resume();
        return fail(new Error('Logo must be PNG, JPG, or WebP.'));
      }
      const logoId = randomUUID();
      const storedName = `${logoId}${ext}`;
      const logoPath = path.join(STORAGE_DIR, 'logos', storedName);
      const write = createWriteStream(logoPath);
      upload = { logoId, storedName, logoPath, url: `/media/logos/${storedName}` };
      file.pipe(write);
      write.on('finish', () => { if (!done) { done = true; resolve({ fields, upload }); } });
      write.on('error', fail);
    });
    busboy.on('error', fail);
    busboy.on('close', () => { if (!done && !upload) { done = true; reject(new Error('No logo file received.')); } });
    req.pipe(busboy);
  });
}

// ─── Smart logo overlay builder ──────────────────────────────────────────────
// Returns null if no valid logo, or an object with:
//   { logoPath, inputArgs[], filterStr, outputLabel }
// The caller appends inputArgs to FFmpeg, appends filterStr to filter_complex,
// and replaces vMap with outputLabel.
function smartWatermarkPos(faceData) {
  if (!faceData) return 'top-right';
  const meanFaceY = faceData.meanFaceY ?? 0.4;
  const meanFaceX = faceData.meanFaceX ?? 0.5;
  // If face is centered or toward top: top corners are fine (face doesn't occupy corners)
  // If face is very low (>60%): face might be near the bottom, top is safest
  // For portrait social video, top-right is almost always safe.
  // If face leans strongly left (x < 0.4): top-left might be blocked, use top-right
  // If face leans strongly right (x > 0.6): top-right might be near face, use top-left
  if (meanFaceY < 0.5 && meanFaceX > 0.6) return 'top-left';
  if (meanFaceY < 0.5 && meanFaceX < 0.4) return 'top-right';
  return 'top-right'; // default: top-right is safest for portrait social content
}

function buildLogoOverlay(brandKit, outW, outH, faceData = null) {
  if (!brandKit || brandKit.watermarkEnabled === false) return null;

  const logoFile = brandKit.logoStoredName
    ? path.join(STORAGE_DIR, 'logos', brandKit.logoStoredName)
    : null;
  const hasLogo = !!(logoFile && existsSync(logoFile));
  const textRaw = (brandKit.textWatermark || '').trim();
  const hasText = !hasLogo && !!textRaw;

  if (!hasLogo && !hasText) return null;

  // Safe-zone margins (TikTok / Reels / Shorts)
  // MB is large enough to clear caption zone (captions sit ~200-280px from bottom)
  const MT = 90, MB = 380, MS = 65;
  const userPos = brandKit.logoPosition || 'auto';
  // Smart auto: pick corner based on face position to avoid faces
  const pos = (userPos === 'auto' || userPos === 'smart-auto')
    ? smartWatermarkPos(faceData)
    : userPos;
  const opacity = Math.min(1, Math.max(0.1, Number(brandKit.logoOpacity ?? 0.9)));

  if (hasLogo) {
    // ── Image logo overlay ──────────────────────────────────────
    const sizePct = { small: 8, medium: 12, large: 18 }[brandKit.logoSize || 'medium']
                    ?? Number(brandKit.logoSizePercent || 12);
    const logoW = Math.max(40, Math.round(outW * sizePct / 100 / 2) * 2);

    let ox, oy;
    switch (pos) {
      case 'top-center':    ox = '(main_w-overlay_w)/2';  oy = MT;                       break;
      case 'top-right':     ox = `main_w-overlay_w-${MS}`; oy = MT;                      break;
      case 'bottom-left':   ox = MS;                       oy = `main_h-overlay_h-${MB}`; break;
      case 'bottom-center': ox = '(main_w-overlay_w)/2';  oy = `main_h-overlay_h-${MB}`; break;
      case 'bottom-right':  ox = `main_w-overlay_w-${MS}`; oy = `main_h-overlay_h-${MB}`; break;
      default:              ox = MS;                       oy = MT;                       break;
    }

    let logoChain = `scale=${logoW}:-2:flags=lanczos,format=rgba`;
    if (opacity < 0.99) logoChain += `,colorchannelmixer=aa=${opacity.toFixed(2)}`;
    if (brandKit.logoBg) logoChain += `,pad=iw+24:ih+14:12:7:color=0x00000099`;

    return {
      type: 'overlay',
      logoPath: logoFile,
      filterStr: (logoInputIdx) =>
        `[${logoInputIdx}:v]${logoChain}[_logo];[_vout_pre][_logo]overlay=x=${ox}:y=${oy}:format=auto[_vwm]`,
    };
  }

  // ── Smart text watermark via drawtext ─────────────────────────
  // Auto-detect text type and apply the right style + position + size.
  // Users just type their name — the system handles the rest.
  const rawClean = textRaw.slice(0, 60);
  const isHandle  = rawClean.startsWith('@');
  const isDomain  = /\.(com|net|org|io|co|tv|me|app|ai|gg|xyz)(\b|\/|$)/i.test(rawClean);
  const isAllCaps = rawClean === rawClean.toUpperCase() && /[A-Z]/.test(rawClean);
  const charCount = rawClean.replace(/\s/g, '').length;

  // Auto-style selection (overridden by user's explicit textStyle if set)
  const explicitStyle = brandKit.textStyle || 'auto';
  let autoStyle, autoPos;

  if (isHandle) {
    autoStyle = 'clean';      // @handles: clean white, thin outline
    autoPos   = 'top-right';  // keep clear of the caption safe zone at the bottom
  } else if (isDomain) {
    autoStyle = 'minimal';    // domains: subtle, small, unobtrusive
    autoPos   = 'bottom-center';
  } else if (isAllCaps && charCount <= 10) {
    autoStyle = 'bold';       // ALL CAPS SHORT BRAND: heavy, prominent
    autoPos   = 'top-right';
  } else if (charCount <= 8) {
    autoStyle = 'clean';      // short brand name: clean + prominent
    autoPos   = 'top-right';
  } else {
    autoStyle = 'pill';       // longer name: text in dark pill for readability
    autoPos   = 'top-right';
  }

  const textStyle = explicitStyle === 'auto' ? autoStyle : explicitStyle;
  // Position: user-override wins, else smart-auto, else text-type auto
  const finalPos  = (userPos && userPos !== 'auto' && userPos !== 'smart-auto') ? userPos
    : faceData ? pos   // face-aware position when face data available
    : autoPos;

  // Smart font size: shorter text = bigger font (more presence)
  const sizeKey   = brandKit.logoSize || 'auto';
  let fontSize;
  if (sizeKey === 'auto') {
    fontSize = charCount <= 6 ? 58 : charCount <= 12 ? 46 : charCount <= 20 ? 38 : 32;
  } else {
    fontSize = { small: 30, medium: 44, large: 62 }[sizeKey] ?? 44;
  }

  const alpha    = opacity.toFixed(2);
  const minAlpha = Math.min(opacity * 0.75, 0.65).toFixed(2);

  // Style-specific FFmpeg fragment
  const styleFrags = {
    clean:    `fontcolor=white@${alpha}:font='Arial Black':borderw=2.5:bordercolor=black@0.90:shadowcolor=black@0.50:shadowx=2:shadowy=2`,
    bold:     `fontcolor=white@${alpha}:font=Impact:borderw=4:bordercolor=black@0.95:shadowcolor=black@0.65:shadowx=3:shadowy=3`,
    minimal:  `fontcolor=white@${minAlpha}:font=Arial:borderw=1.5:bordercolor=black@0.60:shadowcolor=black@0.25:shadowx=1:shadowy=1`,
    pill:     `fontcolor=white@${alpha}:font='Arial Black':box=1:boxcolor=black@0.55:boxborderw=28:shadowcolor=black@0.30:shadowx=0:shadowy=3`,
    outlined: `fontcolor=white@${alpha}:font='Arial Black':borderw=3.5:bordercolor=black@0.95:shadowcolor=black@0.55:shadowx=2:shadowy=2`,
  };
  const styleFrag = styleFrags[textStyle] || styleFrags.clean;

  // Smart text: @handles stay as-is; short brand names auto-uppercase for impact
  const displayText = isHandle || isDomain ? rawClean
    : (charCount <= 10 && !rawClean.includes(' ') ? rawClean.toUpperCase() : rawClean);
  const text = ffmpegText(displayText);

  let tx, ty;
  switch (finalPos) {
    case 'top-center':    tx = '(W-tw)/2';   ty = MT;           break;
    case 'top-right':     tx = `W-tw-${MS}`; ty = MT;           break;
    case 'bottom-left':   tx = MS;            ty = `H-th-${MB}`; break;
    case 'bottom-center': tx = '(W-tw)/2';   ty = `H-th-${MB}`; break;
    case 'bottom-right':  tx = `W-tw-${MS}`; ty = `H-th-${MB}`; break;
    default:              tx = MS;            ty = MT;           break;
  }

  // Scale font size to output resolution (base = 1080px wide)
  const scaledFontSize = Math.round(fontSize * (outW / 1080));

  return {
    type: 'drawtext',
    filterFrag: `drawtext=text='${text}':fontsize=${scaledFontSize}:${styleFrag}:x=${tx}:y=${ty}:expansion=none`,
    detectedStyle: textStyle,
    detectedPos: finalPos,
  };
}

async function renderClip(db, video, mediaPath, moment, index, jobId = '') {
  if (!(await hasCommand(FFMPEG))) throw new Error('FFmpeg is required to render clips.');
  if (jobId && isJobStopped(jobId)) throw new Error('Job cancelled before rendering.');

  const clipId    = randomUUID();
  const output    = path.join(STORAGE_DIR, 'clips', `${clipId}.mp4`);
  const assPath   = path.join(DATA_DIR, 'tmp', `cf_${clipId}.ass`);
  const startedAt = Date.now();
  const title     = String(video.title).slice(0, 42).replace(/:/g, ' ');
  const hook      = (moment.hook || buildCaptionText(moment.text)).slice(0, 120);
  const captionPreset = moment.captionStyle || 'bold';
  const captionMode = ['auto','source','replace','add','none'].includes(String(moment.captionMode || '').toLowerCase())
    ? String(moment.captionMode || '').toLowerCase()
    : 'auto';
  const platform  = (moment.bestPlatform || 'universal').toLowerCase().replace(/\s/g, '');
  const renderCfg = RENDER_PRESETS[platform] || RENDER_PRESETS.universal;
  const { width: RW, height: RH } = renderCfg;

  console.log('[render:start]', { jobId, clipId, index, start: moment.start, end: moment.end, preset: captionPreset, memory: memorySnapshot() });

  // ── Stage 1: Word timings ─────────────────────────────────────
  // Try both possible cache key formats (video.id, video.youtubeId)
  let wordTimings = [];
  const wordCacheCandidates = wordCachePathsForVideo(video).filter((p, i, a) => p && a.indexOf(p) === i);

  for (const wordCache of wordCacheCandidates) {
    if (existsSync(wordCache)) {
      try {
        const cached = JSON.parse(readFileSync(wordCache, 'utf8'));
        const cands  = finalizeWordEndTimes(cached.words || [])
          .filter(w => w.sourceEnd > moment.start && w.sourceStart < moment.end);
        if (cands.length) { wordTimings = cands; break; }
      } catch {}
    }
  }
  if (!wordTimings.length) {
    const clipSegs = (db.transcriptions?.find(t => t.videoId === video.id)?.segments || [])
      .filter(s => s.end > moment.start && s.start < moment.end);
    wordTimings = estimateWordTimings(clipSegs, moment.start, moment.end);
  }
  // Fallback: estimate from moment text if still empty
  if (!wordTimings.length && moment.text) {
    const words = cleanTranscriptText(moment.text).split(/\s+/).filter(Boolean);
    const dur   = moment.end - moment.start;
    const wd    = dur / Math.max(1, words.length);
    wordTimings = words.map((w, i) => {
      const sourceStart = moment.start + i * wd;
      const sourceEnd = moment.start + (i + 1) * wd;
      return {
        word: w,
        text: w,
        start: sourceStart,
        end: sourceEnd,
        sourceStart,
        sourceEnd,
        confidence: null,
        segmentId: null,
        speakerId: null,
        timingSource: 'estimated-moment-text',
      };
    });
  }

  // ── Stage 2: Source dimensions + face tracking + stereo analysis
  const clipDuration = moment.end - moment.start;
  const [{ w: srcW, h: srcH }, stereoSide, faceData, sourceAudioInfo, hdrInfo] = await Promise.all([
    probeVideoDims(mediaPath),
    detectSpeakerSide(mediaPath, moment.start, moment.end),
    trackFaces(mediaPath, moment.start, moment.end),
    video._sourceAudioInfo ? Promise.resolve(video._sourceAudioInfo) : inspectSourceAudio(mediaPath),
    video._hdrInfo ? Promise.resolve(video._hdrInfo) : detectHDR(mediaPath),
  ]);
  video._hdrInfo = hdrInfo;
  const hasSourceAudio = sourceAudioInfo.status === SOURCE_AUDIO_PRESENT;
  if (sourceAudioInfo.status === SOURCE_AUDIO_EXTRACTION_FAILED) {
    throw new Error(`${SOURCE_AUDIO_EXTRACTION_FAILED}: ${sourceAudioInfo.reason || 'Could not verify source audio.'}`);
  }
  let hdrTonemapFrag = '';
  if (hdrInfo.isHDR) {
    if (await tonemapFilterAvailable()) {
      // Tone-map HLG/PQ -> linear -> BT.709 SDR before the sharpen/contrast pass, which
      // assumes roughly SDR-range pixel values.
      hdrTonemapFrag = ',zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
      console.log('[render:hdr]', { clipId, transfer: hdrInfo.transfer, action: 'tone-mapped to SDR Rec.709' });
    } else {
      console.warn('[render:hdr]', { clipId, transfer: hdrInfo.transfer, action: 'HDR input detected but zscale/tonemap filters are unavailable on this FFmpeg build — rendering without tone-mapping' });
    }
  }
  // Face tracking takes priority over stereo for speaker side
  const speakerSide = faceData?.speakerSide || stereoSide;
  console.log('[render:analysis]', {
    clipId, srcW, srcH, speakerSide,
    faceCount:  faceData?.faceCount ?? 0,
    meanFaceX:  faceData?.meanFaceX ?? 0.5,
    meanFaceW:  faceData?.meanFaceW ?? 0,
    combinedBox: faceData?.combinedBox,
    faceTracked: !!faceData,
    sourceAudioStatus: sourceAudioInfo.status,
    sourceAudioMaxVolumeDb: sourceAudioInfo.maxVolumeDb,
    sourceAudioBitrate: sourceAudioInfo.audioBitrate,
  });

  // ── Stage 3: Black frame trim ─────────────────────────────────
  const blackOffset    = await detectContentStart(mediaPath, moment.start);
  const effectiveStart = moment.start + blackOffset;

  // ── Stage 4: Silence + filler removal (EDL) ──────────────────
  // Full Series parts must preserve the complete, continuous story — silence/filler
  // cutting is a Viral Clips punch-up technique only. Cutting "silence" out of a series
  // part can strip legitimate non-speech content (b-roll, pauses, action beats) and, in
  // the worst case where most of the window reads as silence, collapse the rendered
  // output to a couple of surviving seconds even though the part's nominal window is
  // 60-120s. Series parts always render as one uninterrupted segment.
  const isSeriesPart = String(moment.workflowMode || '').toLowerCase() === 'series';
  const silences = isSeriesPart ? [] : await detectSilences(mediaPath, effectiveStart, moment.end);
  const edlSegs  = isSeriesPart
    ? [{ start: effectiveStart, end: moment.end }]
    : buildEDL(wordTimings, silences, moment.start, moment.end, blackOffset);

  // ── Stage 5b: Brand kit / logo ────────────────────────────────
  const brandKit = moment.brandKitId
    ? (db.brandKits || []).find(bk => bk.id === moment.brandKitId)
    : null;
  const logoOverlay = buildLogoOverlay(brandKit, RW, RH, faceData);

  // ── Stage 6: Filter complex ───────────────────────────────────
  const framingMode = moment.framingMode || 'dynamic';
  const pfObj = buildPortraitFilter(srcW, srcH, RW, RH, speakerSide, clipDuration, faceData, framingMode);
  pfObj.momentStart = moment.start;

  // Disable EDL for blurred clips with many segments — each segment requires a
  // split→bg→fg→overlay chain (O(5n)), which times out at 600s on long clips.
  // Non-EDL uses a single dynamic eval=frame crop expression, far faster.
  const useEDL = edlSegs.length > 1 && !(pfObj.type === 'blurred' && edlSegs.length > 5);

  // ── Stage 5: ASS word-level captions ─────────────────────────
  const rawAssWords = useEDL
    ? remapWordTimings(wordTimings, edlSegs)
    : wordTimings.map(w => ({
        word: w.word,
        text: w.text || w.word,
        start: w.start - effectiveStart,
        end: w.end - effectiveStart,
        sourceStart: w.sourceStart ?? w.start,
        sourceEnd: w.sourceEnd ?? w.end,
        confidence: w.confidence ?? null,
        segmentId: w.segmentId ?? null,
        speakerId: w.speakerId ?? null,
        timingSource: w.timingSource || w.source || 'unknown',
      }));
  const totalOutDur = useEDL
    ? edlSegs.reduce((s, seg) => s + seg.end - seg.start, 0)
    : moment.end - effectiveStart;
  const assWords = clipCaptionWordsToRenderWindow(rawAssWords, totalOutDur);
  // Compute average face Y to position captions above faces in bottom-framed shots
  const kfCyVals = (faceData?.keyframes || []).filter(kf => kf.faceCount > 0).map(kf => kf.cy);
  const faceCyAvg = kfCyVals.length ? kfCyVals.reduce((s, v) => s + v, 0) / kfCyVals.length : null;

  const shouldRenderGeneratedCaptions = !['none', 'source'].includes(captionMode);
  const captionSync = assessCaptionSync(assWords, { enabled: shouldRenderGeneratedCaptions, outputDuration: totalOutDur });
  if (captionSync.fatal) {
    throw new Error(`Caption sync failed validation: ${captionSync.issues.join('; ')}`);
  }
  if (captionSync.status !== CAPTION_SYNC_VALID) {
    console.warn('[render:caption-sync]', { clipId, status: captionSync.status, reason: captionSync.reason, sources: captionSync.timingSources });
  }
  const assContent = shouldRenderGeneratedCaptions ? buildASSFile(assWords, 0, totalOutDur, captionPreset, RW, RH, faceCyAvg) : '';
  let hasASS = false;
  try {
    if (shouldRenderGeneratedCaptions) {
      writeFileSync(assPath, assContent, 'utf8');
      hasASS = true;
    }
  } catch (error) {
    console.error('[render:ass-write-failed]', { clipId, assPath, error: error.message });
  }

  // loudnorm: broadcast-standard loudness (-14 LUFS), prevents clipping
  // Anti-pop fade: 30ms in/out at the absolute output boundaries (the real cut points
  // against the source). Never long enough to fade over speech.
  const antiPopFadeSec = 0.03;
  const antiPopFade = totalOutDur > antiPopFadeSec * 4
    ? `,afade=t=in:st=0:d=${antiPopFadeSec},afade=t=out:st=${Math.max(0, totalOutDur - antiPopFadeSec).toFixed(3)}:d=${antiPopFadeSec}`
    : '';
  const audioF = `acompressor=threshold=0.089:ratio=4:attack=5:release=50,loudnorm=I=-14:TP=-1.5:LRA=11${antiPopFade}`;
  const encodeArgs = [
    '-c:v', 'libx264', '-preset', 'fast',
    '-crf', String(renderCfg.crf), '-maxrate', renderCfg.maxrate, '-bufsize', renderCfg.bufsize,
    '-r', String(renderCfg.fps), '-pix_fmt', 'yuv420p', '-g', String(renderCfg.fps * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
  ];

  // Quality enhancement: sharpen + subtle contrast/saturation lift for premium look
  const qualityF = `${hdrTonemapFrag},unsharp=5:5:0.7:3:3:0.3,eq=contrast=1.04:saturation=1.10:brightness=0.01`;

  // Build a crop+scale filter for a specific static X (used in EDL segments)
  function segFillFilter(cropX) {
    return `crop=${pfObj.cropW}:${pfObj.cropH}:${cropX}:0,scale=${RW}:${RH}:flags=lanczos,setsar=1${qualityF}`;
  }
  function segBlurFilter(cropX) {
    return {
      fg: `crop=${pfObj.cropW}:${pfObj.cropH}:${cropX}:0,scale=${RW}:${pfObj.scaledH}:flags=lanczos,setsar=1${qualityF}`,
      bg: pfObj.bgFilterFor(cropX, pfObj.cropW),
    };
  }

  function segAudioFilter(s, i) {
    const duration = Math.max(0.05, s.end - s.start).toFixed(3);
    return hasSourceAudio
      ? `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
      : `anullsrc=channel_layout=stereo:sample_rate=48000:d=${duration},atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`;
  }

  let filterComplex, vMap, aMap;

  if (useEDL) {
    // ── EDL path: each segment gets its own crop position ────────────
    const segParts = edlSegs.map((s, i) => {
      const segX = pfObj.portraitFill
        ? 0
        : getSegmentCropX(pfObj.keyframes, s.start, s.end, moment.start, pfObj.cropW, srcW);

      if (pfObj.portraitFill) {
        return [
          `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,${pfObj.portraitFill}[v${i}]`,
          segAudioFilter(s, i),
        ].join(';');
      } else if (pfObj.type === 'fill') {
        return [
          `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,${segFillFilter(segX)}[v${i}]`,
          segAudioFilter(s, i),
        ].join(';');
      } else {
        const { fg, bg } = segBlurFilter(segX);
        return [
          `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,split[_s${i}a][_s${i}b]`,
          `[_s${i}a]${bg}[_s${i}bg]`,
          `[_s${i}b]${fg}[_s${i}fg]`,
          `[_s${i}bg][_s${i}fg]overlay=x=0:y=(H-h)/2,setsar=1[v${i}]`,
          segAudioFilter(s, i),
        ].join(';');
      }
    });

    const cIn = edlSegs.map((_, i) => `[v${i}][a${i}]`).join('');
    // After concat: apply captions → route to pre-logo label
    const preCapLabel = logoOverlay ? '[_vcap]' : '[vout]';
    const assChain = hasASS
      ? `[vcat]setsar=1,ass='${ffmpegFilterPath(assPath)}'${preCapLabel}`
      : `[vcat]setsar=1${preCapLabel}`;
    filterComplex =
      `${segParts.join(';')};${cIn}concat=n=${edlSegs.length}:v=1:a=1[vcat][acat]` +
      `;${assChain}` +
      `;[acat]${audioF}[aout]`;
    vMap = preCapLabel;
    aMap = '[aout]';

  } else {
    // ── Non-EDL path: dynamic per-frame crop expression ──────────────
    const { xExpr, wExpr } = pfObj.portraitFill
      ? { xExpr: '0', wExpr: String(pfObj.cropW) }
      : buildCropExprs(pfObj.keyframes, pfObj.cropW, srcW, blackOffset);

    const tS = effectiveStart.toFixed(3);
    const tE = moment.end.toFixed(3);
    // Captions are burned in before logo overlay
    const preCapLabel = logoOverlay ? '[_vcap]' : '[vout]';
    const capF = hasASS ? `,ass='${ffmpegFilterPath(assPath)}'` : '';

    if (pfObj.portraitFill) {
      filterComplex =
        `[0:v]trim=start=${tS}:end=${tE},setpts=PTS-STARTPTS,${pfObj.portraitFill}${qualityF},setsar=1${capF}${preCapLabel};` +
        (hasSourceAudio ? `[0:a]atrim=start=${tS}:end=${tE},asetpts=PTS-STARTPTS,${audioF}[aout]` : `anullsrc=channel_layout=stereo:sample_rate=48000:d=${totalOutDur.toFixed(3)},${audioF}[aout]`);
    } else if (pfObj.type === 'fill') {
      filterComplex =
        `[0:v]trim=start=${tS}:end=${tE},setpts=PTS-STARTPTS,` +
        `crop=w='${wExpr}':h=${pfObj.cropH}:x='${xExpr}':y=0,` +
        `scale=${RW}:${RH}:flags=lanczos,setsar=1${qualityF},setsar=1${capF}${preCapLabel};` +
        (hasSourceAudio ? `[0:a]atrim=start=${tS}:end=${tE},asetpts=PTS-STARTPTS,${audioF}[aout]` : `anullsrc=channel_layout=stereo:sample_rate=48000:d=${totalOutDur.toFixed(3)},${audioF}[aout]`);
    } else {
      const dynBgF = pfObj.bgFilterDynamic(xExpr, wExpr);
      filterComplex =
        `[0:v]trim=start=${tS}:end=${tE},setpts=PTS-STARTPTS,split[_dvbg][_dvfg];` +
        `[_dvbg]${dynBgF}[_dbbg];` +
        `[_dvfg]crop=w='${wExpr}':h=${pfObj.cropH}:x='${xExpr}':y=0,` +
        `scale=${RW}:${pfObj.scaledH}:flags=lanczos,setsar=1${qualityF}[_dbfg];` +
        `[_dbbg][_dbfg]overlay=x=0:y=(H-h)/2,setsar=1${capF}${preCapLabel};` +
        (hasSourceAudio ? `[0:a]atrim=start=${tS}:end=${tE},asetpts=PTS-STARTPTS,${audioF}[aout]` : `anullsrc=channel_layout=stereo:sample_rate=48000:d=${totalOutDur.toFixed(3)},${audioF}[aout]`);
    }
    vMap = preCapLabel; aMap = '[aout]';
  }

  // ── Watermark injection ───────────────────────────────────────
  let extraInputArgs = [];
  if (logoOverlay) {
    if (logoOverlay.type === 'drawtext') {
      // Text watermark: just chain a drawtext filter — no extra input needed
      filterComplex += `;${vMap}${logoOverlay.filterFrag}[_vwm]`;
      vMap = '[_vwm]';
    } else {
      // Image logo overlay: needs extra -i input
      extraInputArgs = ['-i', logoOverlay.logoPath];
      const logoInputIdx = 1;
      const logoF = logoOverlay.filterStr(logoInputIdx);
      const logoFAdapted = logoF
        .replace('[_vout_pre]', vMap)
        .replace(/^\[(\d+):v\]/, `[${logoInputIdx}:v]`);
      filterComplex += `;${logoFAdapted}`;
      vMap = '[_vwm]';
    }
  }

  // ── Stage 7: Render ───────────────────────────────────────────
  try {
    await run(FFMPEG, [
      '-y', '-i', mediaPath, ...extraInputArgs,
      '-filter_complex', filterComplex,
      '-map', vMap, '-map', aMap,
      ...encodeArgs, output,
    ], { jobId, label: 'render-v5', timeoutMs: PROCESS_TIMEOUT_MS });
  } catch (renderErr) {
    const errStr = String(renderErr.message||renderErr);
    // Log the LAST 400 chars — FFmpeg errors appear at end of stderr, after the version banner
    console.warn('[render:v5-fallback]', { clipId, err: errStr.length > 400 ? '...' + errStr.slice(-400) : errStr });
    try { if (existsSync(output)) unlinkSync(output); } catch {}
    // Fallback: single-pass, static global crop, no EDL, no logo (most robust)
    // Always use segFillFilter for blurred type — it guarantees RW×RH (1080×1920).
    // Using only segBlurFilter.fg in the fallback would produce wrong height (scaledH).
    const staticX = pfObj.portraitFill ? 0 : pfObj.globalCropX;
    const fallbackVF = pfObj.portraitFill
      ? pfObj.portraitFill
      : segFillFilter(staticX);
    const fallbackAssF = hasASS ? `,ass='${ffmpegFilterPath(assPath)}'` : '';
    const fallbackDuration = Math.max(0.05, moment.end - effectiveStart).toFixed(3);
    const fallbackArgs = hasSourceAudio
      ? [
          '-y', '-ss', String(effectiveStart), '-to', String(moment.end), '-i', mediaPath,
          '-vf', `${fallbackVF}${fallbackAssF}`,
          '-af', audioF,
          ...encodeArgs, output,
        ]
      : [
          '-y', '-ss', String(effectiveStart), '-to', String(moment.end), '-i', mediaPath,
          '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${fallbackDuration}`,
          '-map', '0:v', '-map', '1:a',
          '-vf', `${fallbackVF}${fallbackAssF}`,
          '-af', audioF,
          '-shortest',
          ...encodeArgs, output,
        ];
    await run(FFMPEG, fallbackArgs, { jobId, label: 'render-fallback', timeoutMs: PROCESS_TIMEOUT_MS });
  } finally {
    try { if (existsSync(assPath)) unlinkSync(assPath); } catch {}
  }

  if (!existsSync(output) || statSync(output).size < 1024) {
    throw new Error('FFmpeg finished but output file is missing or empty.');
  }
  console.log('[render:complete]', { jobId, clipId, durationMs: Date.now()-startedAt, sizeBytes: statSync(output).size, memory: memorySnapshot() });

  // ── Stage 8: Thumbnail ────────────────────────────────────────
  let thumbnailPath = '';
  try {
    const thumbFile = path.join(STORAGE_DIR, 'thumbs', `clip_${clipId}.jpg`);
    await run(FFMPEG, ['-y', '-ss', '0.8', '-i', output, '-frames:v', '1', '-vf', 'scale=360:-1', '-q:v', '3', thumbFile], { timeoutMs:30_000, label:'clip-thumb' });
    if (existsSync(thumbFile)) thumbnailPath = `/media/thumbs/clip_${clipId}.jpg`;
  } catch {}

  // ── Stage 9: Quality validation ───────────────────────────────
  const quality = await validateClipRender(output, {
    sourceAudioInfo,
    expectedDuration: isSeriesPart ? (moment.duration || (moment.end - moment.start)) : undefined,
    minDurationSeconds: isSeriesPart ? 20 : undefined,
  });
  if (quality.issues.length) console.warn('[render:quality-issues]', { clipId, issues: quality.issues, audio: quality.audio });
  if (!quality.valid) {
    unlinkQuiet(output);
    if (thumbnailPath) unlinkQuiet(path.join(STORAGE_DIR, 'thumbs', path.basename(thumbnailPath)));
    throw new Error(`Rendered clip failed validation: ${quality.fatalIssues.join(', ')}${quality.audio?.failureReason ? ` — ${quality.audio.failureReason}` : ''}`);
  }

  // ── Stage 10: Enrichment ──────────────────────────────────────
  const canDT           = await drawtextSupported();
  const thumbnailOptions = await generateThumbnailOptions(clipId, output, hook, title, canDT);
  const postingData      = await generatePostingAssistant(db, video, { ...moment, hook }, 'TikTok');
  const intelligence     = buildViralIntelligence(video, moment, hook, index);
  const renderIssues     = [...quality.issues, ...(captionSync.issues || [])];

  return {
    id: clipId,
    title: `${title} #${index + 1}`,
    hook,
    hooks:          moment.hooks || { curiosity:hook, shock:hook, value:hook, story:hook, controversy:hook, sales:hook },
    captionStyle:   captionPreset,
    captionMode,
    startSeconds:   moment.start,
    endSeconds:     moment.end,
    score:          moment.score,
    hookStrength:   moment.hookStrength   || 7,
    emotionalPunch: moment.emotionalPunch || 7,
    controversy:    moment.controversy    || 5,
    usefulness:     moment.usefulness     || 7,
    shareability:   moment.shareability   || 7,
    rationale:      moment.rationale      || 'High-density transcript window with hook language.',
    reason:         moment.reason         || 'educational',
    brollKeywords:  moment.brollKeywords  || [],
    bestPlatform:   moment.bestPlatform   || 'TikTok',
    transcriptExcerpt: (moment.text || '').slice(0, 420),
    outputPath:     `/media/clips/${clipId}.mp4`,
    thumbnailPath,
    thumbnailOptions,
    platform,
    renderQuality:  quality.scores,
    renderIssues,
    audioStatus:    quality.audio,
    captionStatus:  captionSync.status,
    captionSyncStatus: captionSync.status,
    captionSync,
    wordCount:      wordTimings.length,
    blackTrimmed:   blackOffset > 0.05,
    silencesRemoved: silences.length,
    edlSegments:    edlSegs.length,
    postCaption:    `${hook}\n\nDesigned for TikTok, Reels, Shorts, and Facebook Reels.`,
    hashtags:       ['#shorts', '#reels', '#tiktok', '#creator'],
    postingAssistant: postingData,
    platformContent:  postingData.platformContent || null,
    transformation:   defaultTransformation(title),
    intelligence,
    seriesId:       moment.seriesId || null,
    partNumber:     moment.partNumber || null,
    totalParts:     moment.totalParts || null,
    sourceStart:    moment.sourceStart ?? moment.start,
    sourceEnd:      moment.sourceEnd ?? moment.end,
    previousPartId: moment.previousPartId || null,
    nextPartId:     moment.nextPartId || null,
    workflowMode:   moment.workflowMode || 'viral',
    createdAt: new Date().toISOString(),
  };
}

function buildTargetDurations(videoDurationSeconds, clipCount = 3, requestedLength = 60) {
  const d = Math.max(0, Number(videoDurationSeconds || 0));
  const count = Math.max(1, Math.min(10, Number(clipCount || 3)));
  const requested = Math.max(15, Math.min(600, Number(requestedLength || 60)));
  const cycle = requested === 60 && count >= 3 ? [60, 90, 120] : [requested];
  const durations = [];
  for (let i = 0; i < count; i += 1) {
    if (d > 0 && d < 60) {
      durations.push(Math.max(5, Math.floor(d * 0.85)));
      continue;
    }
    const raw = cycle[i % cycle.length];
    const sourceCap = d > 0 ? Math.max(60, Math.floor(d * 0.9)) : raw;
    durations.push(Math.max(60, Math.min(raw, sourceCap)));
  }
  return durations;
}

function getTargetDurations(videoDurationSeconds) {
  return buildTargetDurations(videoDurationSeconds, 3, 60);
}

function fallbackMomentsForVideo(video, options = {}) {
  const duration = Math.max(5, Number(video.durationSeconds || 30));
  const targetDurations = options.targetDurations || getTargetDurations(duration);
  const count = targetDurations.length;
  const minUsefulSeconds = Math.min(15, Math.max(1, Math.floor(duration / Math.max(1, count))));
  const requestedTotal = targetDurations.reduce((sum, seconds) => sum + Number(seconds || 0), 0);
  const canFitRequested = requestedTotal <= duration;
  const fallbackLen = Math.max(minUsefulSeconds, Math.floor(duration / Math.max(1, count)));
  let cursor = 0;
  return targetDurations.map((segLen, index) => {
    const effectiveLen = canFitRequested ? Math.min(segLen, duration) : Math.min(segLen, fallbackLen);
    const remainingClips = count - index - 1;
    const remainingRequested = canFitRequested
      ? targetDurations.slice(index + 1).reduce((sum, seconds) => sum + Number(seconds || 0), 0)
      : remainingClips * effectiveLen;
    const maxStart = Math.max(0, duration - remainingRequested - effectiveLen);
    const start = Math.min(cursor, maxStart);
    const end = Math.min(duration, Math.max(start + minUsefulSeconds, start + effectiveLen));
    cursor = end + (canFitRequested && count > 1 ? Math.max(0, (duration - requestedTotal) / (count - 1)) : 0);
    return {
      start,
      end,
      score: Math.max(72, 88 - index * 5),
      reason: video.isShort ? 'shorts-direct' : 'visual',
      hook: video.isShort ? 'Ready for Shorts' : 'Strong visual moment',
      rationale: video.isShort ? 'Imported as a short vertical source for direct remix/export.' : 'Fallback edit window created because transcript/captions were unavailable.',
      text: video.title || 'Uploaded video clip'
    };
  });
}

function cleanBoundaryTime(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function candidateBoundariesFromTranscript(segments = []) {
  return segments
    .flatMap(seg => [seg.start, seg.end])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

// Minimum viable part length: a hard floor of 30s, but for target durations that leave
// room within the boundary-adjustment window we prefer 45-60s so a natural boundary
// search has real options. Never below 30s regardless of how short the target/adjustment is.
function minPartDuration(targetDuration, adjustment) {
  return Math.max(30, Math.min(60, targetDuration - adjustment));
}

function chooseNaturalBoundary(cursor, targetEnd, sourceEnd, boundaries = [], adjustment = 15, minDuration = 30) {
  const floor = cursor + minDuration;
  const min = Math.max(floor, targetEnd - adjustment);
  const max = Math.min(sourceEnd, targetEnd + adjustment);
  if (sourceEnd <= max) return { time: sourceEnd, reason: 'reached source end' };
  const candidates = boundaries
    .filter(t => t >= floor && t >= min && t <= max)
    .sort((a, b) => Math.abs(a - targetEnd) - Math.abs(b - targetEnd));
  if (candidates.length) return { time: cleanBoundaryTime(candidates[0], floor, sourceEnd), reason: 'sentence/transcript boundary near target' };
  return { time: cleanBoundaryTime(targetEnd, floor, sourceEnd), reason: 'exact target duration (no natural boundary found)' };
}

function buildFullSeriesMoments(video, transcript = [], options = {}) {
  const sourceStart = Math.max(0, Number(options.sourceStart || 0));
  const rawSourceEnd = Number(options.sourceEnd ?? video.durationSeconds ?? 0);
  const sourceEnd = Number.isFinite(rawSourceEnd) ? rawSourceEnd : 0;
  if (sourceEnd <= sourceStart + 0.05) return [];
  const targetDuration = Math.max(30, Math.min(600, Number(options.partDuration || options.clipLength || 90)));
  const adjustment = Math.max(0, Math.min(30, Number(options.boundaryAdjustmentSeconds ?? 15)));
  const contextOverlap = Math.max(0, Math.min(3, Number(options.contextOverlapSeconds || 0)));
  const minDuration = minPartDuration(targetDuration, adjustment);
  const boundaries = candidateBoundariesFromTranscript(transcript);
  const seriesId = options.seriesId || randomUUID();
  const parts = [];
  let cursor = sourceStart;
  let guard = 0;
  while (cursor < sourceEnd - 0.5 && guard < 1000) {
    guard += 1;
    const targetEnd = Math.min(sourceEnd, cursor + targetDuration);
    let { time: end, reason: boundaryReason } = chooseNaturalBoundary(cursor, targetEnd, sourceEnd, boundaries, adjustment, minDuration);
    let mergedFinal = false;
    // If what would remain after this boundary is too small to stand as its own valid
    // part, absorb it into the current part instead of emitting a tiny trailing part.
    if (sourceEnd - end > 0 && sourceEnd - end < minDuration) {
      end = sourceEnd;
      boundaryReason = 'reached source end (tiny remainder merged in)';
      mergedFinal = true;
    }
    const renderStart = Math.max(sourceStart, cursor - (parts.length ? contextOverlap : 0));
    const partSegs = transcript.filter(seg => seg.end > renderStart && seg.start < end);
    const text = partSegs.map(seg => seg.text).join(' ').replace(/\s+/g, ' ').trim();
    const words = text.split(/\s+/).filter(Boolean);
    parts.push({
      start: renderStart,
      end,
      sourceStart: cursor,
      sourceEnd: end,
      duration: Math.max(0, end - renderStart),
      targetDuration,
      contextOverlapSeconds: parts.length ? contextOverlap : 0,
      overlapSeconds: parts.length ? contextOverlap : 0,
      score: 85,
      reason: 'full-series',
      boundaryReason,
      mergedFinal,
      firstWord: words[0] || null,
      lastWord: words.length ? words[words.length - 1] : null,
      hook: `Part ${parts.length + 1}`,
      title: `Part ${parts.length + 1}`,
      rationale: 'Chronological full-video series part with natural-boundary adjustment.',
      text: text || video.title || `Part ${parts.length + 1}`,
      workflowMode: 'series',
      seriesId,
    });
    if (end <= cursor) break;
    cursor = end;
  }
  const totalParts = parts.length;
  return parts.map((part, index) => ({
    ...part,
    partNumber: index + 1,
    totalParts,
    title: `Part ${index + 1} of ${totalParts}`,
    hook: `Part ${index + 1} of ${totalParts}`,
  }));
}

// Rebuilds renderClip-ready "moment" objects from an already-committed series plan
// (db.seriesParts rows) instead of recomputing boundaries. Used on retry and on
// restart-resume so previously-rendered sibling parts' timestamps can never drift.
function momentsFromPersistedSeriesPlan(seriesRows, video, transcript = []) {
  const totalParts = seriesRows.length ? Math.max(...seriesRows.map(r => r.totalParts || seriesRows.length)) : 0;
  return seriesRows.map(row => {
    const renderStart = Math.max(0, Number(row.sourceStart) - Number(row.overlapSeconds || 0));
    const text = transcript
      .filter(seg => seg.end > renderStart && seg.start < row.sourceEnd)
      .map(seg => seg.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      start: renderStart,
      end: row.sourceEnd,
      sourceStart: row.sourceStart,
      sourceEnd: row.sourceEnd,
      duration: row.duration,
      targetDuration: row.targetDuration,
      contextOverlapSeconds: row.overlapSeconds || 0,
      overlapSeconds: row.overlapSeconds || 0,
      score: 85,
      reason: 'full-series',
      boundaryReason: row.boundaryReason || 'persisted plan',
      mergedFinal: Boolean(row.mergedFinal),
      firstWord: row.firstWord || null,
      lastWord: row.lastWord || null,
      hook: `Part ${row.partNumber} of ${totalParts}`,
      title: `Part ${row.partNumber} of ${totalParts}`,
      rationale: 'Chronological full-video series part with natural-boundary adjustment.',
      text: text || video.title || `Part ${row.partNumber}`,
      workflowMode: 'series',
      seriesId: row.seriesId,
      partNumber: row.partNumber,
      totalParts,
    };
  });
}

// Validates a full series plan BEFORE any rendering starts: chronological continuity,
// no gaps/overlaps, no duplicate/out-of-order part numbers, no invalid durations, first
// part starts at source start, final part reaches source end. Never silently repairs —
// callers must log `issues` and reject the plan if `valid` is false.
function validateSeriesPlan(parts, sourceStart, sourceEnd, minDuration) {
  const issues = [];
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  if (!(Number(sourceEnd) > Number(sourceStart))) {
    issues.push(`SOURCE_DURATION_UNAVAILABLE: source duration must be known before planning a full series (start ${Number(sourceStart || 0).toFixed(2)}s, end ${Number(sourceEnd || 0).toFixed(2)}s)`);
  }
  if (!sorted.length) issues.push('SERIES_PLAN_EMPTY: plan has no parts');
  const seen = new Set();
  let gapDetected = false;
  let overlapDetected = false;
  sorted.forEach((p, i) => {
    if (seen.has(p.partNumber)) issues.push(`Duplicate partNumber ${p.partNumber}`);
    seen.add(p.partNumber);
    if (p.partNumber !== i + 1) issues.push(`Part numbering gap at index ${i}: expected ${i + 1}, got ${p.partNumber}`);
    const dur = p.sourceEnd - p.sourceStart;
    if (!(dur > 0)) issues.push(`Part ${p.partNumber}: non-positive duration (${dur.toFixed(2)}s)`);
    if (p.sourceStart > p.sourceEnd) issues.push(`Part ${p.partNumber}: start > end`);
    if (p.sourceEnd > sourceEnd + 0.5) issues.push(`Part ${p.partNumber}: end (${p.sourceEnd.toFixed(2)}) beyond source duration (${sourceEnd.toFixed(2)})`);
    if (dur > 0 && dur < minDuration && i !== sorted.length - 1) issues.push(`PART_TOO_SHORT: part ${p.partNumber} is ${dur.toFixed(2)}s, below minimum ${minDuration}s`);
  });
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const delta = cur.sourceStart - prev.sourceEnd;
    if (delta > 0.5) { gapDetected = true; issues.push(`SERIES_GAP_DETECTED: ${delta.toFixed(2)}s gap between part ${prev.partNumber} and part ${cur.partNumber}`); }
    if (delta < -0.5) { overlapDetected = true; issues.push(`SERIES_OVERLAP_DETECTED: ${(-delta).toFixed(2)}s unintended overlap between part ${prev.partNumber} and part ${cur.partNumber}`); }
  }
  if (sorted.length && Math.abs(sorted[0].sourceStart - sourceStart) > 0.5) issues.push(`First part starts at ${sorted[0].sourceStart.toFixed(2)}s, not source start ${sourceStart.toFixed(2)}s`);
  if (sorted.length && Math.abs(sorted[sorted.length - 1].sourceEnd - sourceEnd) > 1.0) issues.push(`Final part ends at ${sorted[sorted.length - 1].sourceEnd.toFixed(2)}s, not source end ${sourceEnd.toFixed(2)}s`);
  let status = 'SERIES_PLAN_VALID';
  if (issues.some(i => i.startsWith('SOURCE_DURATION_UNAVAILABLE'))) status = 'SOURCE_DURATION_UNAVAILABLE';
  else if (issues.some(i => i.startsWith('SERIES_GAP_DETECTED'))) status = 'SERIES_GAP_DETECTED';
  else if (issues.some(i => i.startsWith('SERIES_OVERLAP_DETECTED'))) status = 'SERIES_OVERLAP_DETECTED';
  else if (issues.some(i => i.startsWith('PART_TOO_SHORT'))) status = 'PART_TOO_SHORT';
  else if (issues.length) status = 'PART_DURATION_INVALID';
  return { valid: issues.length === 0, status, issues, gapDetected, overlapDetected };
}

function upsertSeriesPlan(db, { seriesId, jobId, videoId, userId, parts, targetPartDuration }) {
  if (!Array.isArray(db.seriesJobs)) db.seriesJobs = [];
  if (!Array.isArray(db.seriesParts)) db.seriesParts = [];
  let series = db.seriesJobs.find(item => item.id === seriesId);
  if (!series) {
    series = {
      id: seriesId,
      jobId,
      videoId,
      userId,
      status: 'running',
      targetPartDuration,
      totalParts: parts.length,
      completedParts: 0,
      failedParts: 0,
      planStatus: 'SERIES_PLAN_PENDING',
      createdAt: new Date().toISOString(),
    };
    db.seriesJobs.unshift(series);
  }
  Object.assign(series, {
    jobId,
    videoId,
    userId,
    status: series.status === 'complete' ? 'complete' : 'running',
    targetPartDuration,
    totalParts: parts.length,
    updatedAt: new Date().toISOString(),
  });
  for (const part of parts) {
    let row = db.seriesParts.find(item => item.seriesId === seriesId && item.partNumber === part.partNumber);
    if (!row) {
      row = {
        id: randomUUID(),
        seriesId,
        jobId,
        videoId,
        userId,
        partNumber: part.partNumber,
        totalParts: part.totalParts,
        sourceStart: part.sourceStart,
        sourceEnd: part.sourceEnd,
        duration: part.duration,
        targetDuration: part.targetDuration ?? targetPartDuration,
        overlapSeconds: part.overlapSeconds || 0,
        boundaryReason: part.boundaryReason || '',
        mergedFinal: Boolean(part.mergedFinal),
        firstWord: part.firstWord || null,
        lastWord: part.lastWord || null,
        previousSeriesPartId: null,
        nextSeriesPartId: null,
        status: 'queued',
        validationStatus: 'PENDING',
        clipId: '',
        outputPath: '',
        error: '',
        createdAt: new Date().toISOString(),
      };
      db.seriesParts.push(row);
    } else {
      // Once a part row exists, its boundary-defining fields are committed — a later
      // upsert call (retry, resume, or a second call in the same run) must never shift
      // them, or already-rendered sibling parts would no longer line up.
      Object.assign(row, {
        jobId,
        totalParts: row.totalParts,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  // Chronological previous/next links between series-part rows (not clip ids — those
  // are attached once each part actually finishes rendering), so the UI/plan validator
  // can walk the timeline before every part has rendered.
  const ordered = db.seriesParts.filter(item => item.seriesId === seriesId).sort((a, b) => a.partNumber - b.partNumber);
  ordered.forEach((row, i) => {
    row.previousSeriesPartId = ordered[i - 1]?.id || null;
    row.nextSeriesPartId = ordered[i + 1]?.id || null;
  });
  return series;
}

function updateSeriesPart(partId, patch) {
  const db = loadDb();
  const part = db.seriesParts?.find(item => item.id === partId);
  if (part) {
    Object.assign(part, patch, { updatedAt: new Date().toISOString() });
    if (patch.status === 'complete') part.validationStatus = 'PART_VALID';
    else if (patch.status === 'failed') part.validationStatus = 'PART_RENDER_FAILED';
  }
  const series = part ? db.seriesJobs?.find(item => item.id === part.seriesId) : null;
  if (series) {
    const rows = db.seriesParts.filter(item => item.seriesId === series.id);
    series.completedParts = rows.filter(item => item.status === 'complete').length;
    series.failedParts = rows.filter(item => item.status === 'failed').length;
    series.status = series.completedParts === series.totalParts ? 'complete' : series.failedParts ? 'partial_failed' : 'running';
    // Re-validate the whole timeline once every part has rendered: confirms Part 1 starts
    // at source start, every next part starts where the previous ended, and the final
    // part reaches the source end — never mark SERIES_COMPLETE on ffmpeg exit codes alone.
    if (series.status === 'complete') {
      const video = db.videos?.find(item => item.id === series.videoId);
      const finalCheck = validateSeriesPlan(rows, 0, Number(video?.durationSeconds || 0), minPartDuration(series.targetPartDuration || 90, 15));
      series.planStatus = finalCheck.valid ? 'SERIES_COMPLETE' : finalCheck.status;
      if (!finalCheck.valid) console.error('[series:final-validation-failed]', { seriesId: series.id, issues: finalCheck.issues });
    }
    series.updatedAt = new Date().toISOString();
  }
  saveDb(db);
}

// Persists a single rendered clip into db.clips immediately, rather than waiting for the
// whole batch/series to finish. Without this, a job that fails partway (e.g. Full Series
// part 5 of 7 errors) would silently lose the already-rendered parts 1-4 — they'd exist as
// files on disk with a completed db.seriesParts row, but never appear in the clip library,
// because completeJobWithClips (which used to be the only place clips were persisted) is
// never reached on a thrown error. Idempotent so re-running never duplicates a clip.
function appendClipRecord(jobId, videoId, clip) {
  const fresh = loadDb();
  const freshVideo = fresh.videos.find(item => item.id === videoId);
  if (!freshVideo) return;
  if (fresh.clips.some(item => item.id === clip.id)) return;
  const freshJob = fresh.jobs.find(item => item.id === jobId);
  const clipUserId = freshVideo.userId || freshVideo.createdBy || freshJob?.userId || '';
  const row = { ...clip, jobId, videoId, userId: clipUserId, status: 'ready' };
  // Cross-link neighboring series parts by whatever's already landed in db.clips —
  // parts don't always render in order (retry / regenerate-from-here / restart-resume),
  // so link in both directions whenever a neighbor is already present.
  if (row.seriesId && row.partNumber) {
    const prevClip = fresh.clips.find(item => item.seriesId === row.seriesId && item.partNumber === row.partNumber - 1);
    const nextClip = fresh.clips.find(item => item.seriesId === row.seriesId && item.partNumber === row.partNumber + 1);
    if (prevClip) { row.previousPartId = prevClip.id; prevClip.nextPartId = row.id; }
    if (nextClip) { row.nextPartId = nextClip.id; nextClip.previousPartId = row.id; }
  }
  fresh.clips.unshift(row);
  saveDb(fresh);
}

function completeJobWithClips(jobId, videoId, clipRows) {
  const fresh = loadDb();
  const freshJob = fresh.jobs.find(item => item.id === jobId);
  const freshVideo = fresh.videos.find(item => item.id === videoId);
  if (!freshJob || !freshVideo) return;
  freshJob.status = 'complete';
  freshJob.progress = 100;
  freshJob.stage = 'completed';
  freshJob.updatedAt = new Date().toISOString();
  freshJob.steps = processingSteps(freshJob.stage, freshJob.progress);
  freshVideo.status = 'complete';
  const clipUserId = freshVideo.userId || freshVideo.createdBy || freshJob.userId || '';
  const existingIds = new Set(fresh.clips.map(item => item.id));
  fresh.clips.unshift(...clipRows.filter(clip => !existingIds.has(clip.id)).map(clip => ({ ...clip, jobId, videoId, userId: clipUserId, status: 'ready' })));
  const watch = fresh.watchedChannels.find(item => item.id === freshVideo.watchedChannelId);
  if (watch?.autoSchedule && watch.platforms?.length) {
    let minuteOffset = 30;
    for (const clip of clipRows) {
      for (const platform of watch.platforms) {
        const account = fresh.socialAccounts.find(item => item.platform === platform);
        if (!account) continue;
        fresh.scheduledPosts.unshift({
          id: randomUUID(),
          clipId: clip.id,
          platform,
          accountId: account.id,
          scheduledFor: new Date(Date.now() + minuteOffset * 60 * 1000).toISOString().slice(0, 16),
          status: 'scheduled',
          caption: clip.postCaption,
          createdAt: new Date().toISOString()
        });
        minuteOffset += 30;
      }
    }
  }
  saveDb(fresh);
}

function markSourceCleaned(videoId) {
  const fresh = loadDb();
  const video = fresh.videos.find(item => item.id === videoId);
  if (video) {
    video.storagePath = '';
    video.sourceCleanedAt = new Date().toISOString();
    video.status = 'complete';
    saveDb(fresh);
  }
}

function saveTranscriptToDb(videoId, segments) {
  const db = loadDb();
  if (!Array.isArray(db.transcriptions)) db.transcriptions = [];
  const existing = db.transcriptions.findIndex(t => t.videoId === videoId);
  const record = {
    id: existing >= 0 ? db.transcriptions[existing].id : randomUUID(),
    videoId,
    segments,
    fullText: segments.map(s => s.text).join(' '),
    wordCount: segments.map(s => s.text.split(/\s+/).length).reduce((a, b) => a + b, 0),
    createdAt: existing >= 0 ? db.transcriptions[existing].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (existing >= 0) db.transcriptions[existing] = record;
  else db.transcriptions.unshift(record);
  saveDb(db);
  return record;
}

function processingSteps(stage, progress) {
  const steps = ['Queued', 'Transcribing', 'AI Analysis', 'Rendering', 'Thumbnails', 'Completed'];
  const stageText = String(stage || '').toLowerCase();
  let active = 0;
  if (stageText.includes('download')) active = 0;
  else if (stageText.includes('transcrib')) active = 1;
  else if (stageText.includes('viral') || stageText.includes('clip') || stageText.includes('hook') || stageText.includes('platform') || stageText.includes('analysis')) active = 2;
  else if (stageText.includes('render') || stageText.includes('vertical')) active = 3;
  else if (stageText.includes('thumb') || stageText.includes('caption')) active = 4;
  else if (stageText.includes('complete') || stageText.includes('ready') || progress >= 100) active = 5;
  return steps.map((label, index) => ({
    label,
    status: progress >= 100 || index < active ? 'complete' : index === active ? 'active' : 'waiting'
  }));
}

function createQueuedProcessingJob(payload) {
  const { videoId, rightsConfirmed, fairUseMode, transformationNote } = payload;
  if (!rightsConfirmed) throw new Error('Confirm that you own this video or have permission to reuse it before processing.');
  const db = loadDb();
  // Use the userId from payload (set by the route handler), falling back to the video owner or first admin
  const requestingUserId = payload.userId;
  const db2video = db.videos.find(item => item.id === videoId);
  const requestingUser = requestingUserId ? db.users.find(u => u.id === requestingUserId) : null;
  const user = requestingUser
    || (db2video && db.users.find(u => u.id === (db2video.userId || db2video.createdBy)))
    || db.users.find(u => u.role === 'admin')
    || db.users[0];
  const video = db2video;
  if (!video) throw new Error('Video not found.');
  if (requestingUser && !userCanAccessVideo(requestingUser, video)) {
    throw Object.assign(new Error('You do not have access to this video.'), { status: 403 });
  }
  const existingJob = db.jobs.find(item => item.videoId === videoId && ['queued', 'running'].includes(item.status));
  if (existingJob) return { ...existingJob, duplicate: true };
  video.rightsConfirmed = true;
  video.fairUseMode = Boolean(fairUseMode);
  video.transformationNote = transformationNote || '';
  video.status = 'queued';
  const job = {
    id: randomUUID(),
    userId: user.id,
    videoId,
    payload: {
      videoId,
      userId: user.id,
      rightsConfirmed: true,
      clipCount: payload.clipCount || 3,
      clipLength: payload.clipLength || 60,
      partDuration: payload.partDuration || payload.clipLength || 90,
      workflowMode: payload.workflowMode || payload.mode || 'viral',
      captionStyle: payload.captionStyle || '',
      captionMode: payload.captionMode || 'auto',
      framingMode: payload.framingMode || 'dynamic',
      brandKitId: payload.brandKitId || null,
      seriesId: payload.seriesId || null,
    },
    status: 'queued',
    progress: 1,
    stage: 'queued',
    steps: processingSteps('queued', 1),
    error: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.jobs.unshift(job);
  saveDb(db);
  return job;
}

async function processVideo(payload) {
  assertMemoryAvailable();
  const { videoId, rightsConfirmed, fairUseMode, transformationNote } = payload;
  const requestedCaptionStyle = String(payload.captionStyle || '').toLowerCase();
  const requestedMode = String(payload.workflowMode || payload.mode || 'viral').toLowerCase();
  const requestedCaptionMode = String(payload.captionMode || 'auto').toLowerCase();
  const clipOptions = {
    clipCount:   Math.max(1, Math.min(10, Number(payload.clipCount || 3))),
    clipLength:  Math.max(60, Math.min(600, Number(payload.clipLength || 60))),
    workflowMode: ['viral', 'series', 'full_series', 'full-video-series'].includes(requestedMode) ? requestedMode : 'viral',
    partDuration: Math.max(30, Math.min(600, Number(payload.partDuration || payload.clipLength || 90))),
    captionMode: ['auto','source','replace','add','none'].includes(requestedCaptionMode) ? requestedCaptionMode : 'auto',
    framingMode: ['tight','original','wide','medium','close','dynamic'].includes(payload.framingMode)
                   ? payload.framingMode : 'dynamic',
    captionStyle: ASS_PRESETS[requestedCaptionStyle] ? requestedCaptionStyle : null,
    brandKitId:  payload.brandKitId || null,
  };
  const isSeriesMode = clipOptions.workflowMode !== 'viral';
  // Fixed as early as possible (before the job.payload is first persisted) so that a
  // restart-resume or retry reads back the SAME seriesId from job.payload rather than
  // minting a fresh one — which would otherwise orphan the already-persisted plan and
  // completed parts, and rebuild a brand new series from scratch.
  const seriesId = isSeriesMode ? (payload.seriesId || randomUUID()) : null;
  if (!rightsConfirmed) throw new Error('Confirm that you own this video or have permission to reuse it before processing.');
  if (fairUseMode && !String(transformationNote || '').trim()) {
    throw new Error('Fair-use/remix mode requires a commentary, reaction, education, or transformation note.');
  }
  const db = loadDb();
  const video = db.videos.find(item => item.id === videoId);
  if (!video) throw new Error('Video not found.');
  const requestingUser = payload.userId ? db.users.find(u => u.id === payload.userId) : null;
  if (requestingUser && !userCanAccessVideo(requestingUser, video)) {
    throw Object.assign(new Error('You do not have access to this video.'), { status: 403 });
  }
  if (requestingUser && clipOptions.brandKitId) {
    requireBrandKitAccess(db, requestingUser, clipOptions.brandKitId);
  }
  const existingJob = db.jobs.find(item => item.videoId === videoId && ['queued', 'running'].includes(item.status) && item.id !== payload.jobId);
  if (existingJob) return { jobId: existingJob.id, duplicate: true };
  const jobOwner = db.users.find(u => u.id === (video.userId || video.createdBy)) || db.users.find(u => u.role === 'admin');
  if (!jobOwner) throw new Error('Video owner not found.');
  if (CREDITS_ENABLED && jobOwner.role !== 'admin' && jobOwner.credits < CLIP_JOB_CREDIT_COST) {
    throw new Error(`Not enough credits. Clip generation costs ${CLIP_JOB_CREDIT_COST} credits. Go to Credits & Billing to get more.`);
  }
  video.rightsConfirmed = true;
  video.fairUseMode = Boolean(fairUseMode);
  video.transformationNote = transformationNote || '';
  video.status = 'queued';
  if (CREDITS_ENABLED && jobOwner.role !== 'admin') {
    jobOwner.credits -= CLIP_JOB_CREDIT_COST;
    db.creditTransactions.unshift({ id: randomUUID(), userId: jobOwner.id, amount: -CLIP_JOB_CREDIT_COST, reason: `Clip job — ${video.title || 'video'}`, createdAt: new Date().toISOString() });
  }
  let job = payload.jobId ? db.jobs.find(item => item.id === payload.jobId) : null;
  if (!job) {
    job = {
      id: randomUUID(),
      userId: jobOwner.id,
      videoId,
      createdAt: new Date().toISOString()
    };
    db.jobs.unshift(job);
  }
  Object.assign(job, {
    status: 'running',
    progress: 5,
    stage: 'downloading',
    steps: processingSteps('downloading', 5),
    payload: {
      ...payload,
      userId: jobOwner.id,
      rightsConfirmed: true,
      workflowMode: clipOptions.workflowMode,
      captionMode: clipOptions.captionMode,
      partDuration: clipOptions.partDuration,
      seriesId,
    },
    error: '',
    startedAt: job.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  saveDb(db);
  let downloadedPath = '';
  try {
    const ytdlpReady = Boolean(await workingYtDlpCommand());
    const ffmpegReady = await hasCommand(FFMPEG);
    if (!ytdlpReady && video.sourceKind !== 'upload') throw new Error('Download blocked: yt-dlp is not available on this server. Use file upload or redeploy with Docker media tools.');
    if (!ffmpegReady) throw new Error('FFmpeg failed: FFmpeg is not available on this server, so clips cannot be rendered.');
    const mediaPath = video.sourceKind === 'upload' ? video.storagePath : await downloadVideo(video, job.id);
    if (!mediaPath || !existsSync(mediaPath)) throw new Error('Source video file is missing. Upload the video again and retry.');
    if (video.sourceKind !== 'upload') downloadedPath = mediaPath;
    updateJob(job.id, { progress: 24, stage: 'verifying source audio', steps: processingSteps('transcribing', 24) });
    const sourceAudioInfo = await inspectSourceAudio(mediaPath);
    video.sourceAudioStatus = sourceAudioInfo.status;
    video._sourceAudioInfo = sourceAudioInfo;
    const resolvedDuration = resolveMediaDurationSeconds(video, sourceAudioInfo);
    if (resolvedDuration > 0) {
      video.durationSeconds = resolvedDuration;
      video.isShort = resolvedDuration <= 90;
    }
    const audioDb = loadDb();
    const audioVideo = audioDb.videos.find(item => item.id === video.id);
    if (audioVideo) {
      audioVideo.sourceAudioStatus = sourceAudioInfo.status;
      audioVideo.sourceAudioReason = sourceAudioInfo.reason || '';
      audioVideo.sourceAudioMaxVolumeDb = sourceAudioInfo.maxVolumeDb ?? null;
      audioVideo.sourceAudioBitrate = sourceAudioInfo.audioBitrate ?? null;
      if (resolvedDuration > 0) {
        audioVideo.durationSeconds = resolvedDuration;
        audioVideo.isShort = resolvedDuration <= 90;
      }
      saveDb(audioDb);
    }
    if (video.sourceKind !== 'upload' && sourceAudioInfo.status !== SOURCE_AUDIO_PRESENT) {
      throw new Error(`${SOURCE_AUDIO_EXTRACTION_FAILED}: YouTube source audio was not audibly valid after download (${sourceAudioInfo.reason || sourceAudioInfo.status}).`);
    }
    if (isSeriesMode && !(Number(video.durationSeconds || 0) > 0)) {
      throw new Error('SOURCE_DURATION_UNAVAILABLE: Full Video Series needs a known source duration. Re-import the YouTube source or upload the video file so FFmpeg can probe the media duration.');
    }
    updateJob(job.id, { progress: 30, stage: 'transcribing', steps: processingSteps('transcribing', 30) });
    let transcript = [];
    // Transcribe the full source exactly once per video and reuse the cached segments on
    // every subsequent run (retry, resume, or a second series job against the same source)
    // instead of re-calling Whisper/Gemini each time — this both avoids cost/latency and
    // avoids introducing timing drift into an already-committed series plan.
    const cachedTranscript = (db.transcriptions || []).find(t => t.videoId === video.id);
    if (cachedTranscript?.segments?.length) {
      transcript = cachedTranscript.segments;
      updateJob(job.id, { progress: 44, stage: 'reusing cached transcript', steps: processingSteps('transcribing', 44) });
    } else {
      try {
        if (video.sourceKind === 'upload') {
          updateJob(job.id, { progress: 35, stage: 'transcribing audio with Whisper', steps: processingSteps('transcribing', 35) });
          transcript = await transcribeAudioWithWhisper(db, mediaPath, video.id);
          if (!transcript.length) updateJob(job.id, { progress: 44, stage: 'no transcript: using visual edit fallback', steps: processingSteps('transcribing', 44) });
        } else {
          transcript = await getTranscript(video, mediaPath);
        }
      } catch (error) {
        updateJob(job.id, { progress: 44, stage: 'no transcript: using visual edit fallback', steps: processingSteps('transcribing', 44) });
      }
      if (transcript.length) saveTranscriptToDb(video.id, transcript);
    }
    if (transcript.length) {
      updateJob(job.id, { progress: 50, stage: 'extracting B-roll suggestions', steps: processingSteps('analysis', 50) });
      suggestBrollKeywords(db, transcript, video.title).catch(() => {});
    }
    updateJob(job.id, { progress: 58, stage: isSeriesMode ? 'planning full video series' : 'AI analysis — scoring viral moments', steps: processingSteps('analysis', 58) });
    const targetDurations = buildTargetDurations(video.durationSeconds, clipOptions.clipCount, clipOptions.clipLength);
    let rawMoments;
    if (isSeriesMode) {
      const existingRows = (db.seriesParts || [])
        .filter(p => p.seriesId === seriesId)
        .sort((a, b) => a.partNumber - b.partNumber);
      if (existingRows.length) {
        // A plan for this seriesId is already committed (retry-series-part or a
        // restart-resume). The persisted boundaries are authoritative — recomputing
        // them here could drift from whatever already-rendered sibling parts assumed,
        // breaking the nextPart.sourceStart === previousPart.sourceEnd invariant.
        rawMoments = momentsFromPersistedSeriesPlan(existingRows, video, transcript);
        updateJob(job.id, { stage: 'resuming committed series plan' });
      } else {
        rawMoments = buildFullSeriesMoments(video, transcript, {
          seriesId,
          partDuration: clipOptions.partDuration,
          boundaryAdjustmentSeconds: 15,
          contextOverlapSeconds: Number(payload.contextOverlapSeconds || 0),
        });
      }
    } else {
      rawMoments = transcript.length
        ? await detectViralMoments(db, video, transcript, {
            ...clipOptions,
            clipCount: clipOptions.clipCount,
            clipLength: targetDurations[0],
            targetDurations,
            mediaPath,  // gives Gemini direct video access for superior analysis
          })
        : fallbackMomentsForVideo(video, { ...clipOptions, targetDurations });
    }
    const moments = rawMoments.map(m => ({
      ...m,
      workflowMode: isSeriesMode ? 'series' : 'viral',
      captionMode: clipOptions.captionMode,
      captionStyle: clipOptions.captionStyle || m.captionStyle,
      brandKitId: m.brandKitId || clipOptions.brandKitId || null
    }));
    if (!moments.length) throw new Error('Could not create a clipping window for this video.');
    let seriesRowsByPart = new Map();
    if (isSeriesMode) {
      // Validate the complete plan BEFORE any part renders. A bad plan (gap, overlap,
      // invalid duration, wrong numbering) must be rejected loudly here — never silently
      // repaired, and never discovered only after partial rendering.
      const planMinDuration = minPartDuration(clipOptions.partDuration, 15);
      const planCheck = validateSeriesPlan(moments, 0, Number(video.durationSeconds || 0), planMinDuration);
      if (!planCheck.valid) {
        console.error('[series:plan-invalid]', { seriesId, videoId: video.id, status: planCheck.status, issues: planCheck.issues });
        throw new Error(`Series plan rejected (${planCheck.status}): ${planCheck.issues.join('; ')}`);
      }
      const seriesDb = loadDb();
      upsertSeriesPlan(seriesDb, {
        seriesId,
        jobId: job.id,
        videoId: video.id,
        userId: jobOwner.id,
        parts: moments,
        targetPartDuration: clipOptions.partDuration,
      });
      const seriesRow = seriesDb.seriesJobs.find(item => item.id === seriesId);
      if (seriesRow) seriesRow.planStatus = planCheck.status;
      saveDb(seriesDb);
      seriesRowsByPart = new Map((seriesDb.seriesParts || [])
        .filter(part => part.seriesId === seriesId)
        .map(part => [part.partNumber, part]));
    }
    updateJob(job.id, { progress: 72, stage: 'creating vertical clips', steps: processingSteps('vertical', 72) });
    const rendered = [];
    for (let i = 0; i < moments.length; i += 1) {
      if (isJobStopped(job.id)) throw new Error('Job was cancelled.');
      const seriesPart = isSeriesMode ? seriesRowsByPart.get(moments[i].partNumber) : null;
      if (seriesPart?.status === 'complete' && seriesPart.clipId) continue;
      if (seriesPart) updateSeriesPart(seriesPart.id, { status: 'running', error: '' });
      updateJob(job.id, {
        progress: Math.min(94, 72 + Math.round((i / Math.max(1, moments.length)) * 22)),
        stage: isSeriesMode ? `Rendering Part ${i + 1} of ${moments.length}` : `rendering clip ${i + 1} of ${moments.length}`,
        steps: processingSteps('rendering', 80)
      });
      try {
        const clip = await renderClip(db, video, mediaPath, moments[i], i, job.id);
        if (seriesPart) updateJob(job.id, { stage: `Validating Part ${i + 1} of ${moments.length}` });
        rendered.push(clip);
        // Persist immediately — do not wait for the whole batch to finish. If a later
        // part in this same run fails, this part must still show up in the library.
        appendClipRecord(job.id, video.id, clip);
        if (seriesPart) updateSeriesPart(seriesPart.id, { status: 'complete', clipId: clip.id, outputPath: clip.outputPath, error: '' });
      } catch (error) {
        if (seriesPart) updateSeriesPart(seriesPart.id, { status: 'failed', error: String(error.message || error) });
        throw error;
      }
    }
    if (!rendered.length || rendered.some(clip => !clip.outputPath)) throw new Error('Rendering failed: no clips were saved.');
    // previousPartId/nextPartId are cross-linked incrementally in appendClipRecord as each
    // part lands — that handles out-of-order renders (retry/regenerate-from-here/resume)
    // correctly, which a simple pass over `rendered` (only this run's subset) would not.

    completeJobWithClips(job.id, video.id, rendered);

    // ── Gemini post-render enrichment (async, non-blocking) ──
    // Generate rich per-clip metadata and run QA for each rendered clip
    const geminiKey = settingValue(db, 'GEMINI_API_KEY');
    if (geminiKey) {
      Promise.all(rendered.map(async (clip, i) => {
        const moment = moments[i] || {};
        try {
          // Rich metadata: titles, descriptions, hashtags, thumbnail ideas
          const meta = await geminiGenerateClipMetadata(db, video, { ...moment, ...clip });
          if (meta && Object.keys(meta).length) {
            const db2 = loadDb();
            const dbClip = db2.clips.find(c => c.id === clip.id);
            if (dbClip) {
              Object.assign(dbClip, {
                aiTitle:              meta.title              || dbClip.aiTitle,
                youtubeTitle:         meta.youtube_title      || '',
                tiktokDescription:    meta.tiktok_description || '',
                reelsDescription:     meta.reels_description  || '',
                shortsDescription:    meta.shorts_description || '',
                xCaption:             meta.x_caption          || '',
                linkedinCaption:      meta.linkedin_caption   || '',
                hashtagsTikTok:       meta.hashtags_tiktok    || [],
                hashtagsInstagram:    meta.hashtags_instagram || [],
                hashtagsYouTube:      meta.hashtags_youtube   || [],
                seoKeywords:          meta.seo_keywords       || [],
                thumbnailIdea:        meta.thumbnail_idea     || dbClip.thumbnailIdea || '',
                brollSuggestions:     meta.broll_suggestions  || dbClip.brollKeywords || [],
                soundEffects:         meta.sound_effect_suggestions || [],
                cta:                  meta.cta                || '',
                bestPostingTime:      meta.best_posting_time  || '',
                metaEnrichedAt:       new Date().toISOString(),
              });
              saveDb(db2);
            }
          }
        } catch {}

        // QA review
        try {
          const renderReport = { scores: clip.renderQuality || {}, issues: clip.renderIssues || [] };
          const qa = await geminiQAReview(db, { ...clip, ...moment }, renderReport);
          if (qa) {
            const db3 = loadDb();
            const dbClip = db3.clips.find(c => c.id === clip.id);
            if (dbClip) { dbClip.geminiQA = qa; saveDb(db3); }
          }
        } catch {}
      })).catch(() => {});
    }

    if (downloadedPath) unlinkQuiet(downloadedPath);
    if (video.sourceKind === 'upload') {
      unlinkQuiet(mediaPath);
      markSourceCleaned(video.id);
    }
    return { jobId: job.id };
  } catch (error) {
    const rawError = String(error.message || error);
    const cleanError = ytDlpBlockedByYouTube(rawError) || /No supported JavaScript runtime|YouTube download failed|YouTube blocked server download/i.test(rawError)
      ? friendlyYtDlpError(error)
      : rawError;
    if (cleanError !== rawError) console.error('[job:error]', { jobId: job.id, raw: rawError.slice(0, 2000), clean: cleanError });
    updateJob(job.id, { status: 'failed', progress: 100, stage: 'failed', error: cleanError });
    const failedDb = loadDb();
    const failedVideo = failedDb.videos.find(item => item.id === video.id);
    if (failedVideo) {
      failedVideo.status = 'failed';
      failedVideo.lastError = cleanError;
    }
    // Refund the credits deducted at job start — a failed render shouldn't cost the user.
    const failedJob = failedDb.jobs.find(item => item.id === job.id);
    if (CREDITS_ENABLED && jobOwner.role !== 'admin' && failedJob && !failedJob.creditsRefunded) {
      const owner = failedDb.users.find(u => u.id === jobOwner.id);
      if (owner) {
        owner.credits += CLIP_JOB_CREDIT_COST;
        failedDb.creditTransactions.unshift({ id: randomUUID(), userId: owner.id, amount: CLIP_JOB_CREDIT_COST, reason: `Refund — clip job failed (${video.title || 'video'})`, createdAt: new Date().toISOString() });
        failedJob.creditsRefunded = true;
      }
    }
    saveDb(failedDb);
    if (downloadedPath) unlinkQuiet(downloadedPath);
    throw error;
  }
}

function updateJob(jobId, patch) {
  const db = loadDb();
  const job = db.jobs.find(item => item.id === jobId);
  if (job) Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  saveDb(db);
}

function mimeFor(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.mp4')) return 'video/mp4';
  if (file.endsWith('.webm')) return 'video/webm';
  if (file.endsWith('.mov')) return 'video/quicktime';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  if (file.endsWith('.wav')) return 'audio/wav';
  if (file.endsWith('.ogg')) return 'audio/ogg';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

function currentUser(req, db) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const token = bearer ||
    (req.headers['x-session-token'] || '').trim() ||
    new URL(req.url, `http://${req.headers.host}`).searchParams.get('token') || '';
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  return db.users.find(user => user.id === payload.userId) || null;
}

function publicUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

const INTERNAL_API_RESPONSE_KEYS = new Set([
  'passwordHash',
  'storagePath',
  '_sourceAudioInfo',
]);

function apiJsonReplacer(key, value) {
  if (INTERNAL_API_RESPONSE_KEYS.has(key)) return undefined;
  return value;
}

function sanitizeApiPayload(payload) {
  if (payload === undefined) return undefined;
  return JSON.parse(JSON.stringify(payload, apiJsonReplacer));
}

function requireUser(req, db) {
  const user = currentUser(req, db);
  if (!user) throw Object.assign(new Error('Authentication required.'), { status: 401 });
  return user;
}

function requireAdmin(req, db) {
  const user = requireUser(req, db);
  if (user.role !== 'admin') throw Object.assign(new Error('Admin access required.'), { status: 403 });
  return user;
}

function userOwnsRecord(user, record = {}) {
  return Boolean(user && record && (
    user.role === 'admin' ||
    record.userId === user.id ||
    record.createdBy === user.id
  ));
}

function userCanAccessVideo(user, video = {}) {
  return userOwnsRecord(user, video);
}

function userCanAccessClip(user, clip = {}, db = null) {
  if (userOwnsRecord(user, clip)) return true;
  const video = db?.videos?.find(v => v.id === clip.videoId);
  return Boolean(video && userCanAccessVideo(user, video));
}

function requireVideoAccess(db, user, videoId) {
  const video = db.videos.find(item => item.id === videoId);
  if (!video) throw new Error('Video not found.');
  if (!userCanAccessVideo(user, video)) {
    throw Object.assign(new Error('You do not have access to this video.'), { status: 403 });
  }
  return video;
}

function requireBrandKitAccess(db, user, brandKitId) {
  if (!brandKitId) return null;
  const kit = (db.brandKits || []).find(item => item.id === brandKitId);
  if (!kit) throw new Error('Brand kit not found.');
  if (!userOwnsRecord(user, kit)) {
    throw Object.assign(new Error('You do not have access to this brand kit.'), { status: 403 });
  }
  return kit;
}

function requireWatchAccess(db, user, watchId) {
  const watch = db.watchedChannels.find(item => item.id === watchId);
  if (!watch) throw new Error('Watched channel not found.');
  if (!userOwnsRecord(user, watch)) {
    throw Object.assign(new Error('You do not have access to this watched channel.'), { status: 403 });
  }
  return watch;
}

function mediaRecordForPath(relative, db) {
  const clean = relative.replace(/^\/+/, '');
  const basename = path.basename(clean);

  let match = clean.match(/^clips\/([^/]+)\.(?:mp4|mov|webm|m4v)$/i);
  if (match) {
    const clip = db.clips.find(c => c.id === match[1]);
    return clip ? { type: 'clip', record: clip } : null;
  }

  match = clean.match(/^thumbs\/clip_([^/]+)\.(?:jpg|jpeg|png|webp)$/i);
  if (match) {
    const clip = db.clips.find(c => c.id === match[1]);
    return clip ? { type: 'clip', record: clip } : null;
  }

  match = clean.match(/^thumbnails\/thumb_([^/]+)_[^/]+\.(?:jpg|jpeg|png|webp)$/i);
  if (match) {
    const clip = db.clips.find(c => c.id === match[1]);
    return clip ? { type: 'clip', record: clip } : null;
  }

  if (clean.startsWith('uploads/') || clean.startsWith('thumbs/')) {
    const video = db.videos.find(v =>
      (v.storagePath && path.basename(v.storagePath) === basename) ||
      (v.thumbnailUrl && path.basename(v.thumbnailUrl) === basename)
    );
    return video ? { type: 'video', record: video } : null;
  }

  if (clean.startsWith('logos/')) {
    const kit = (db.brandKits || []).find(bk => bk.logoStoredName === basename);
    return kit ? { type: 'brandKit', record: kit } : null;
  }

  if (clean.startsWith('generations/')) {
    const generation = (db.studioGenerations || []).find(g => g.outputPath && path.basename(g.outputPath) === basename);
    return generation ? { type: 'generation', record: generation } : null;
  }

  if (clean.startsWith('audio/')) {
    const audio = (db.audioGenerations || []).find(a => a.outputPath && path.basename(a.outputPath) === basename);
    return audio ? { type: 'audio', record: audio } : null;
  }

  return null;
}

function userCanAccessMedia(user, relative, db) {
  if (user?.role === 'admin') return true;
  if (relative.startsWith('originals/') || relative.startsWith('transcripts/')) return false;
  const media = mediaRecordForPath(relative, db);
  if (!media) return false;
  if (media.type === 'clip') return userCanAccessClip(user, media.record, db);
  return userOwnsRecord(user, media.record);
}

function subscriptionFor(db, userId) {
  const subscription = db.subscriptions.find(item => item.userId === userId && item.status === 'active');
  const plan = db.billingPlans.find(item => item.id === subscription?.planId) || db.billingPlans[0];
  return { subscription, plan };
}

function adminMetrics(db) {
  const revenue = db.subscriptions
    .filter(item => item.status === 'active')
    .reduce((sum, sub) => sum + (db.billingPlans.find(plan => plan.id === sub.planId)?.monthlyPrice || 0), 0);
  return {
    totalUsers: db.users.length,
    activeSubscriptions: db.subscriptions.filter(item => item.status === 'active').length,
    creditsUsed: db.creditTransactions.filter(item => item.amount < 0).reduce((sum, item) => sum + Math.abs(item.amount), 0),
    jobsProcessed: db.jobs.filter(item => item.status === 'complete').length,
    failedJobs: db.jobs.filter(item => item.status === 'failed').length,
    revenue,
    storageUsageMb: Math.round(JSON.stringify(db).length / 1024 / 1024 * 100) / 100
  };
}

function settingReady(db, key) {
  const setting = db.apiSettings.find(item => item.key === key);
  return Boolean(setting?.value || process.env[key]);
}

function settingValue(db, key) {
  const setting = db.apiSettings.find(item => item.key === key);
  return String(setting?.value || process.env[key] || '').trim();
}

// Returns the Gemini model to use, respecting GEMINI_MODEL setting.
// Falls back through the model cascade so quota errors on one model
// don't block the whole pipeline — the native SDK functions handle the
// per-call cascade automatically.
function geminiModel(db) {
  const configured = settingValue(db, 'GEMINI_MODEL');
  if (configured && configured.startsWith('gemini')) return configured;
  return GEMINI_MODEL_CASCADE[0]; // gemini-2.5-flash-lite default
}

function normalizeOpenAiBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === 'REPLACE_WITH_EMERGENT_ENDPOINT') return '';
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function aiConfig(db, fallback = false) {
  // When not in fallback mode, check if Gemini is the primary provider
  if (!fallback) {
    const aiProvider = settingValue(db, 'AI_PROVIDER');
    const geminiKey  = settingValue(db, 'GEMINI_API_KEY');
    // If AI_PROVIDER=gemini (or unset and GEMINI_API_KEY is present), route to Gemini
    if (geminiKey && (aiProvider === 'gemini' || !aiProvider)) {
      const model = settingValue(db, 'GEMINI_MODEL') || settingValue(db, 'LLM_MODEL') || GEMINI_MODEL_CASCADE[0];
      return {
        provider:      'gemini',
        apiKey:        geminiKey,
        baseUrl:       `${GEMINI_COMPAT_BASE}/chat/completions`,
        model:         model.startsWith('gemini') ? model : GEMINI_MODEL_CASCADE[0],
        customBaseUrl: false,
      };
    }
  }

  const prefix = fallback ? 'LLM_FALLBACK_' : 'LLM_';
  const provider = settingValue(db, `${prefix}PROVIDER`) || (fallback ? '' : 'xai');
  const apiKey = settingValue(db, `${prefix}API_KEY`);
  const customBaseUrl = settingValue(db, `${prefix}BASE_URL`);
  const providerDefaults = {
    xai:      'https://api.x.ai/v1',
    grok:     'https://api.x.ai/v1',
    openai:   'https://api.openai.com/v1',
    groq:     'https://api.groq.com/openai/v1',
    together: 'https://api.together.xyz/v1',
    emergent: 'https://api.emergent.sh/v1',
    gemini:   GEMINI_COMPAT_BASE,
  };
  const providerModels = {
    xai: 'grok-3-mini', grok: 'grok-3-mini',
    openai: 'gpt-4o-mini', groq: 'llama-3.3-70b-versatile',
    together: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    gemini: GEMINI_MODEL_CASCADE[0],
  };
  // For the gemini provider in LLM_PROVIDER slot, use GEMINI_API_KEY
  const resolvedApiKey = (provider === 'gemini' && !apiKey)
    ? settingValue(db, 'GEMINI_API_KEY')
    : apiKey;
  const baseUrl = customBaseUrl ? normalizeOpenAiBaseUrl(customBaseUrl) : (providerDefaults[provider] || '');
  const model = settingValue(db, `${prefix}MODEL`) || providerModels[provider] || 'grok-3-mini';
  return { provider, apiKey: resolvedApiKey, baseUrl, model, customBaseUrl: Boolean(customBaseUrl) };
}

// ── Higgsfield / Muapi AI media generation ────────────────────────
// Supports two providers: Muapi.ai (multi-model hub) + Higgsfield cloud
// Both use the same submit-then-poll pattern.
const MUAPI_BASE = 'https://api.muapi.ai/api/v1';
const HIGGSFIELD_BASE = 'https://cloud.higgsfield.ai/v1';

const AI_MEDIA_MODELS = {
  // Text-to-video
  't2v-kling-5-1': { label: 'Kling 2.1 (5s)', endpoint: 'kling/v2.1/standard/text-to-video', provider: 'muapi', category: 't2v', seconds: 5 },
  't2v-kling-10':  { label: 'Kling 2.1 (10s)', endpoint: 'kling/v2.1/standard/text-to-video', provider: 'muapi', category: 't2v', seconds: 10, extra: { duration: 10 } },
  't2v-seedance':  { label: 'Seedance v1 (5s)', endpoint: 'bytedance/seedance/v1/lite/t2v', provider: 'muapi', category: 't2v', seconds: 5 },
  't2v-wan':       { label: 'Wan2.1 (480p)', endpoint: 'wan/v2.1/1.3b/t2v-480p', provider: 'muapi', category: 't2v', seconds: 5 },
  't2v-higgsfield':{ label: 'Higgsfield Cinematic', endpoint: 'text-to-video', provider: 'higgsfield', category: 't2v', seconds: 6 },
  // Image-to-video
  'i2v-kling':     { label: 'Kling i2v (5s)', endpoint: 'kling/v2.1/standard/image-to-video', provider: 'muapi', category: 'i2v', seconds: 5 },
  'i2v-seedance':  { label: 'Seedance i2v', endpoint: 'bytedance/seedance/v1/lite/i2v', provider: 'muapi', category: 'i2v', seconds: 5 },
  'i2v-wan':       { label: 'Wan2.1 i2v', endpoint: 'wan/v2.1/1.3b/i2v-480p', provider: 'muapi', category: 'i2v', seconds: 5 },
  // Text-to-image
  't2i-flux':      { label: 'FLUX 1.1 Pro', endpoint: 'flux/v1.1/pro', provider: 'muapi', category: 't2i' },
  't2i-flux-ultra':{ label: 'FLUX 1.1 Ultra', endpoint: 'flux/v1.1/pro/ultra', provider: 'muapi', category: 't2i' },
  't2i-ideogram':  { label: 'Ideogram 3.0', endpoint: 'ideogram/v3/txt-to-img', provider: 'muapi', category: 't2i' },
  't2i-higgsfield':{ label: 'Higgsfield t2i', endpoint: 'text-to-image', provider: 'higgsfield', category: 't2i' },
  // Lip sync
  'lipsync-wav2lip':{ label: 'Wav2Lip', endpoint: 'wav2lip', provider: 'muapi', category: 'lipsync' },
};

async function muapiSubmit(apiKey, endpoint, payload) {
  const res = await fetch(`${MUAPI_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Muapi error ${res.status}`);
  return data; // { request_id, status, ... }
}

async function muapiPoll(apiKey, requestId, maxMs = 120000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const res = await fetch(`${MUAPI_BASE}/predictions/${requestId}`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === 'completed' || data.status === 'succeeded') return data;
    if (data.status === 'failed' || data.error) throw new Error(data.error || 'Generation failed');
  }
  throw new Error('Generation timed out after 2 minutes');
}

async function higgsfieldSubmit(apiKey, endpoint, payload) {
  const res = await fetch(`${HIGGSFIELD_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Higgsfield error ${res.status}`);
  return data;
}

async function higgsfieldPoll(apiKey, jobId, maxMs = 180000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await fetch(`${HIGGSFIELD_BASE}/generations/${jobId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === 'completed' || data.status === 'succeeded') return data;
    if (data.status === 'failed') throw new Error(data.error || 'Higgsfield generation failed');
  }
  throw new Error('Generation timed out');
}

async function downloadGeneratedMedia(url, destPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Failed to download generated media: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
}

async function runAiMediaGeneration(db, generation) {
  const model = AI_MEDIA_MODELS[generation.model];
  if (!model) throw new Error(`Unknown model: ${generation.model}`);

  const muapiKey = settingValue(db, 'MUAPI_API_KEY');
  const higgsfieldKey = settingValue(db, 'HIGGSFIELD_API_KEY');

  generation.status = 'generating';
  generation.startedAt = new Date().toISOString();
  saveDb(db);

  try {
    let outputUrl = '';

    if (model.provider === 'muapi') {
      if (!muapiKey) throw new Error('MUAPI_API_KEY not configured. Add it in Admin → API Configuration.');
      let payload;
      if (model.category === 'lipsync') {
        // Wav2Lip expects video_url + audio_url, not prompt/image_url
        payload = { video_url: generation.prompt, audio_url: generation.imageUrl };
      } else {
        payload = {
          prompt: generation.prompt,
          negative_prompt: generation.negativePrompt || '',
          ...(generation.imageUrl ? { image_url: generation.imageUrl } : {}),
          ...(model.extra || {})
        };
      }
      const submitted = await muapiSubmit(muapiKey, model.endpoint, payload);
      generation.externalId = submitted.request_id || submitted.id;
      saveDb(db);
      const result = await muapiPoll(muapiKey, generation.externalId);
      // Muapi output can be array of strings or array of objects with .url
      const raw = result.output?.[0];
      outputUrl = (typeof raw === 'string' ? raw : raw?.url) || result.video_url || result.image_url || result.url || '';
    } else if (model.provider === 'higgsfield') {
      if (!higgsfieldKey) throw new Error('HIGGSFIELD_API_KEY not configured. Add it in Admin → API Configuration.');
      const submitted = await higgsfieldSubmit(higgsfieldKey, model.endpoint, {
        prompt: generation.prompt,
        ...(generation.imageUrl ? { image_url: generation.imageUrl } : {})
      });
      generation.externalId = submitted.id || submitted.job_id;
      saveDb(db);
      const result = await higgsfieldPoll(higgsfieldKey, generation.externalId);
      // Higgsfield can return output_url, output.url, or video_url
      outputUrl = result.output_url || result.output?.url || result.video_url || result.url || '';
    }

    if (!outputUrl) throw new Error('No output URL in API response');

    // Derive extension from URL if possible, fall back to category default
    const urlExt = outputUrl.split('?')[0].split('.').pop()?.toLowerCase();
    const safeExt = ['mp4','webm','mov','jpg','jpeg','png','webp','gif'].includes(urlExt) ? urlExt : (model.category === 't2i' ? 'jpg' : 'mp4');
    const filename = `gen_${generation.id}.${safeExt}`;
    const destPath = path.join(STORAGE_DIR, 'generations', filename);
    await downloadGeneratedMedia(outputUrl, destPath);

    generation.outputPath = `/media/generations/${filename}`;
    generation.status = 'completed';
    generation.completedAt = new Date().toISOString();
  } catch (err) {
    generation.status = 'failed';
    generation.error = String(err.message || err).slice(0, 500);
  }
  saveDb(db);
}

function aiMediaReady(db) {
  return Boolean(settingValue(db, 'MUAPI_API_KEY') || settingValue(db, 'HIGGSFIELD_API_KEY'));
}

function aiEndpointCandidates(config) {
  if (!config.baseUrl) return [];
  if (config.customBaseUrl || config.baseUrl.endsWith('/chat/completions')) return [normalizeOpenAiBaseUrl(config.baseUrl)];
  const root = config.baseUrl.replace(/\/+$/, '');
  if (config.provider === 'emergent') {
    return [
      `${root}/chat/completions`,
      `${root}/openai/chat/completions`,
      `${root}/llm/chat/completions`,
      `${root}/ai/chat/completions`
    ];
  }
  return [normalizeOpenAiBaseUrl(root)];
}

function appendAiLog(db, entry) {
  if (!Array.isArray(db.aiLogs)) db.aiLogs = [];
  db.aiLogs.unshift({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    provider: entry.provider || '',
    model: entry.model || '',
    purpose: entry.purpose || '',
    ok: Boolean(entry.ok),
    promptTokens: entry.promptTokens || 0,
    completionTokens: entry.completionTokens || 0,
    totalTokens: entry.totalTokens || 0,
    error: entry.error ? String(entry.error).slice(0, 600) : ''
  });
  db.aiLogs = db.aiLogs.slice(0, 80);
}

function recordAiLog(entry) {
  const db = loadDb();
  appendAiLog(db, entry);
  saveDb(db);
}

function extractJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function aiChat(db, { purpose, messages, temperature = 0.4, responseFormat = 'json_object', fallback = true }) {
  const primaryConfig = aiConfig(db, false);
  const fallbackConfig = aiConfig(db, true);

  // Models actually available on Gemini's OpenAI-compat endpoint (verified).
  // 1.5-flash and 1.5-flash-8b return 404 on the compat endpoint — native SDK only.
  const GEMINI_COMPAT_MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
  ];

  // When primary provider is Gemini, build a model cascade over the compat endpoint.
  // Each model gets its own attempt so 503/429 on one rolls to the next.
  const attempts = [];
  if (primaryConfig.provider === 'gemini' && primaryConfig.apiKey) {
    const configuredModel = primaryConfig.model || GEMINI_COMPAT_MODELS[0];
    const compatModel = GEMINI_COMPAT_MODELS.includes(configuredModel) ? configuredModel : GEMINI_COMPAT_MODELS[0];
    const cascade = [compatModel, ...GEMINI_COMPAT_MODELS.filter(m => m !== compatModel)];
    for (const model of cascade) {
      attempts.push({ ...primaryConfig, model });
    }
  } else {
    attempts.push(primaryConfig);
  }
  if (fallback && fallbackConfig.provider && fallbackConfig.apiKey && fallbackConfig.baseUrl) {
    attempts.push(fallbackConfig);
  }

  // Hard budget: total cascade must finish well within Cloudflare's 30s tunnel limit
  const CASCADE_BUDGET_MS = 22_000;
  // Per-attempt timeout for Gemini cascade models (503s return instantly, no need for 45s)
  const GEMINI_CASCADE_TIMEOUT_MS = 12_000;
  const cascadeStart = Date.now();

  let lastError;
  for (const config of attempts) {
    if (Date.now() - cascadeStart > CASCADE_BUDGET_MS) {
      lastError = new Error('Gemini is currently overloaded across all models. Please try again in 30–60 seconds.');
      break;
    }
    if (!config.apiKey) {
      lastError = new Error(`${config.provider || 'LLM'} API key is not configured.`);
      recordAiLog({ ...config, purpose, ok: false, error: lastError.message });
      continue;
    }
    if (!config.baseUrl) {
      lastError = new Error(`${config.provider || 'LLM'} base URL is not configured.`);
      recordAiLog({ ...config, purpose, ok: false, error: lastError.message });
      continue;
    }
    // Use shorter timeout per attempt when cascading Gemini models
    const perAttemptMs = (config.provider === 'gemini' && attempts.length > 1) ? GEMINI_CASCADE_TIMEOUT_MS : AI_TIMEOUT_MS;
    for (const endpoint of aiEndpointCandidates(config)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), perAttemptMs);
      try {
        const body = { model: config.model, messages, temperature };
        if (responseFormat) body.response_format = { type: responseFormat };
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            'x-clipforge-provider': config.provider
          },
          signal: controller.signal,
          body: JSON.stringify(body)
        });
        clearTimeout(timeout);
        const text = await response.text();
        if (!response.ok) {
          const errMsg = `${response.status} ${text.slice(0, 600)}`;
          const isModelNotFound = response.status === 404 && text.includes('not found');
          if (response.status === 503 || response.status === 429 || isModelNotFound) {
            const label = isModelNotFound ? '404 model-not-found' : response.status;
            console.warn(`[aiChat] ${config.provider}/${config.model} ${label} — trying next model`);
            recordAiLog({ ...config, baseUrl: endpoint, purpose, ok: false, error: errMsg.slice(0, 200) });
            lastError = new Error(errMsg);
            break; // move to next model immediately — no delay
          }
          throw new Error(errMsg);
        }
        let data;
        try { data = JSON.parse(text); } catch {
          // Unexpected non-JSON from a 200 response — treat as transient failure
          lastError = new Error(`Unexpected response from ${config.provider}/${config.model}`);
          recordAiLog({ ...config, baseUrl: endpoint, purpose, ok: false, error: 'non-JSON 200 response' });
          break;
        }
        const content = data.choices?.[0]?.message?.content || '';
        console.log(`[aiChat] ${purpose} — provider: ${config.provider} model: ${config.model}`);
        recordAiLog({
          ...config, baseUrl: endpoint, purpose, ok: true,
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens
        });
        return { content, data, provider: config.provider, model: config.model, usage: data.usage || {} };
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        recordAiLog({ ...config, baseUrl: endpoint, purpose, ok: false, error: error.name === 'AbortError' ? `timed out after ${Math.round(perAttemptMs / 1000)}s` : error.message.slice(0, 200) });
      }
    }
  }
  // Convert Gemini overload / quota / cascade errors to friendly messages
  const finalMsg = lastError?.message || '';
  if (finalMsg.includes('503') || finalMsg.includes('UNAVAILABLE') || finalMsg.includes('high demand') || finalMsg.includes('overloaded') || finalMsg.includes('Please try again') || parseGemini429(lastError)) {
    throw new Error(geminiUserMessage(lastError));
  }
  throw lastError || new Error('AI request failed — no provider responded successfully.');
}

async function testAiConnection(db) {
  const result = await aiChat(db, {
    purpose: 'test connection',
    responseFormat: null,
    messages: [
      { role: 'system', content: 'Reply with a short plain text confirmation.' },
      { role: 'user', content: 'hello world' }
    ]
  });
  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    reply: result.content.slice(0, 240)
  };
}

async function detectViralMoments(db, video, segments, options = {}) {
  const desiredLength = Math.max(60, Math.min(600, Number(options.clipLength || 60)));
  const desiredCount = Math.max(1, Math.min(10, Number(options.clipCount || 3)));
  const targetDurations = options.targetDurations || Array(desiredCount).fill(desiredLength);
  const framingMode = options.framingMode || 'dynamic';
  const videoDuration = Number(video.durationSeconds || 0);
  const minGap = Math.max(30, videoDuration * 0.15);
  const fallbackMoments = scoreMoments(segments, videoDuration)
    .slice(0, desiredCount)
    .map(m => ({ ...m, framingMode }));

  // ── Gemini video analysis path (superior — Gemini watches the actual video) ──
  const geminiKey  = settingValue(db, 'GEMINI_API_KEY');
  const mediaPath  = options.mediaPath;  // set by processVideo when available
  const useVideoAI = geminiKey && mediaPath && existsSync(mediaPath) && videoDuration < 3600;
  if (useVideoAI) {
    try {
      const rawText = await geminiVideoViralAnalysis(geminiKey, mediaPath, video, segments, { ...options, clipCount: desiredCount, targetDurations });
      const parsed = extractJsonObject(rawText);
      if (parsed?.moments?.length) {
        return postProcessMoments(parsed.moments, { desiredCount, desiredLength, targetDurations, framingMode, videoDuration, minGap, fallbackMoments, segments, video, options, source: 'gemini-video' });
      }
    } catch (err) {
      importLog('warn', 'Gemini video analysis failed — falling back to transcript analysis', { error: String(err.message || err).slice(0, 300) });
    }
  }

  // ── Transcript text analysis (works with Gemini text OR other LLM providers) ──
  const transcript = buildTranscriptReference(segments, 32000);
  try {
    const result = await aiChat(db, {
      purpose: 'viral moment detection',
      messages: [
        { role: 'system', content: `You are a world-class viral video editor — the best in the industry. You have cracked the code on what makes content blow up on TikTok, YouTube Shorts, Instagram Reels, and X. You think frame-by-frame like a director, word-by-word like a copywriter, and platform-by-platform like a growth hacker. Your job: identify the EXACT moments that will stop scrollers cold, force an emotional reaction, and get shared. You know that: (1) the first 3 seconds decide everything — a weak open is a dead clip; (2) the best clips have ONE clear emotional arc — a setup, a turn, and a payoff; (3) energy and authenticity beat production quality; (4) controversy and surprise generate comments; (5) actionable value earns saves and shares. Return only valid JSON.` },
        { role: 'user', content: `Analyze this transcript and identify the ${desiredCount} highest-potential viral clips.

Video: "${video.title}"
Total duration: ${videoDuration}s
${targetDurations.map((d, i) => `Clip ${i + 1} target length: ${d}s`).join('\n')}

TEMPORAL DIVERSITY — MANDATORY:
${desiredCount > 1 ? `You MUST select clips from COMPLETELY DIFFERENT sections of the video.
• NO two clips can start within ${Math.round(minGap)}s of each other — they must cover different conversations
• Spread across the FULL video: find moments in early, middle, AND late portions
• If only 1-2 truly different viral moments exist, return fewer clips — NEVER repeat the same section
• Each clip must end within a ${targetDurations.map((d, i) => `~${d}s`).join('/')} window matching the clip order above` : 'Select the single best viral moment.'}

SELECTION RULES:
1. Opening line MUST hook within 3 seconds — pattern interrupt, shocking fact, strong opinion, or story setup. The hook is SACRED — never cut it short.
2. Prioritize moments with: jaw-dropping reveals, emotional peaks, laugh moments, heated arguments, shocking stats, vulnerable confessions, contrarian takes, "you won't believe this" structures
3. NEVER start mid-sentence — always at a clean sentence boundary where the speaker begins a complete thought
4. NEVER cut before the punchline, resolution, or payoff — the end must feel COMPLETE and satisfying
5. End on a natural pause, sentence end, or emotional beat — NEVER cut someone off mid-word or mid-idea
6. Avoid filler, transitions ("so anyway..."), or meandering sections
7. The clip must feel like a COMPLETE story arc: setup → tension/content → payoff
8. NEVER select two clips that cover the same topic or conversation — each clip must stand alone

RETENTION PREDICTION:
- retentionScore (1-10): Would viewers watch 80%+ of this clip to the end?
- dropoffRisk: "low|medium|high" — risk of viewers leaving before the payoff

Transcript (timestamps in seconds):
${transcript}

Score each moment on these 1-10 dimensions:
- hookStrength: Does the OPENING LINE stop a scroll cold?
- emotionalPunch: Emotion intensity (anger/joy/shock/sadness/inspiration)
- voiceEnergy: Speaker energy level and passion
- controversy: Comment-bait potential — will people argue?
- usefulness: Actionable value viewers can apply immediately
- storytelling: Tension + turn + payoff arc quality
- shareability: "I need to send this to someone" factor
- overallScore (1-100): Weighted viral potential score

Return exactly this JSON (no extra fields, no markdown):
{"moments":[{"start":number,"end":number,"overallScore":number,"hookStrength":number,"emotionalPunch":number,"voiceEnergy":number,"controversy":number,"usefulness":number,"storytelling":number,"shareability":number,"retentionScore":number,"dropoffRisk":"low|medium|high","reason":"laugh|revelation|shock|emotion|value|argument|reaction|story|inspiration|confession","rationale":"2-3 sentences: why a top TikTok editor would cut this exact moment, what makes it viral","hooks":{"curiosity":"hook under 96 chars that creates open loop","shock":"hook under 96 chars, pattern interrupt","value":"hook under 96 chars, clear immediate benefit","story":"hook under 96 chars, personal story opener","controversy":"hook under 96 chars, bold contrarian take","sales":"hook under 96 chars, benefit + urgency"},"brollKeywords":["keyword1","keyword2","keyword3","keyword4","keyword5","keyword6"],"bestPlatform":"TikTok|Instagram Reels|YouTube Shorts|X|LinkedIn","captionStyle":"hormozi|mrbeast|karaoke|tiktok|viral|neon|fire|hype|reels|podcast|minimal|luxury|finance|bold","contentWarning":"none|mild|mature"}]}` }
      ]
    });
    const parsed = extractJsonObject(result.content);
    if (parsed?.moments?.length) {
      return postProcessMoments(parsed.moments, { desiredCount, desiredLength, targetDurations, framingMode, videoDuration, minGap, fallbackMoments, segments, video, options, source: 'text-ai' });
    }
    return fallbackMoments;
  } catch {
    return fallbackMoments;
  }
}

// ── Shared moment post-processor — used by both Gemini video + text paths ────
function postProcessMoments(rawItems, ctx) {
  const { desiredCount, desiredLength, targetDurations, framingMode, videoDuration,
          minGap, fallbackMoments, segments, video, options } = ctx;

  const moments = rawItems
    .map(item => {
      const rawStart = Number(item.start);
      const rawEnd = Number(item.end);
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;
      const start = Math.max(0, Math.min(Number(videoDuration || rawStart), rawStart));
      const end = Math.min(Number(videoDuration || start + desiredLength), Math.max(start, rawEnd));
      const text = segments.filter(seg => seg.end >= start && seg.start <= end).map(seg => seg.text).join(' ');
      const hooks = item.hooks || {};
      const primaryHook = hooks.curiosity || hooks.shock || hooks.value || buildCaptionText(text);
      const minEnd = Math.min(Number(videoDuration || end), start + desiredLength);
      const clampedEnd = end - start < 55 ? minEnd : end;
      return {
        start,
        end: clampedEnd,
        score: Math.max(1, Math.min(100, Number(item.overallScore || item.viral_score || item.score || 75))),
        hookStrength:   Number(item.hookStrength || item.hook_strength || 7),
        emotionalPunch: Number(item.emotionalPunch || item.emotional_punch || 7),
        voiceEnergy:    Number(item.voiceEnergy || item.voice_energy || 7),
        controversy:    Number(item.controversy || 5),
        usefulness:     Number(item.usefulness || 7),
        storytelling:   Number(item.storytelling || 6),
        shareability:   Number(item.shareability || 7),
        reason: item.reason || 'educational',
        hook: primaryHook.slice(0, 96),
        hooks: {
          curiosity:   (hooks.curiosity   || primaryHook).slice(0, 96),
          shock:       (hooks.shock       || primaryHook).slice(0, 96),
          value:       (hooks.value       || primaryHook).slice(0, 96),
          story:       (hooks.story       || primaryHook).slice(0, 96),
          controversy: (hooks.controversy || primaryHook).slice(0, 96),
          sales:       (hooks.sales       || primaryHook).slice(0, 96),
        },
        brollKeywords:          Array.isArray(item.brollKeywords)            ? item.brollKeywords.slice(0, 8)            : (Array.isArray(item.broll_suggestions) ? item.broll_suggestions.slice(0, 8) : []),
        soundEffectSuggestions: Array.isArray(item.soundEffectSuggestions)   ? item.soundEffectSuggestions.slice(0, 5)   : (Array.isArray(item.sound_effect_suggestions) ? item.sound_effect_suggestions.slice(0, 5) : []),
        bestPlatform:    item.bestPlatform    || item.best_platform    || 'TikTok',
        captionStyle:    item.captionStyle    || item.caption_style    || 'viral',
        framingMode:     options.framingMode  || 'dynamic',
        brandKitId:      options.brandKitId   || null,
        rationale:       item.rationale || 'AI-selected viral moment.',
        retentionScore:  Number(item.retentionScore || item.retention_score || 7),
        dropoffRisk:     item.dropoffRisk     || item.dropoff_risk     || 'medium',
        contentWarning:  item.contentWarning  || item.content_warning  || 'none',
        // Rich Gemini-generated metadata (populated when using video analysis)
        title:                item.title                || '',
        tiktokDescription:    item.tiktok_description  || '',
        reelsDescription:     item.reels_description   || '',
        hashtags:             Array.isArray(item.hashtags) ? item.hashtags : [],
        thumbnailIdea:        item.thumbnail_idea || item.thumbnailIdea || '',
        framingNotes:         item.framingNotes   || item.framing_notes || '',
        text: text || primaryHook || video.title,
      };
    })
    .filter(Boolean)
    .filter(item => item.end > item.start && item.end - item.start >= 55 && item.end - item.start <= 610);

  // Enforce temporal diversity by both start gap and true overlap. Start-gap
  // alone allowed duplicate clips with slightly shifted starts.
  const diverse = [];
  for (const m of moments.sort((a, b) => b.score - a.score)) {
    if (diverse.every(d => momentsAreDiverse(d, m, minGap))) {
      diverse.push(m);
      if (diverse.length >= desiredCount) break;
    }
  }
  // Fill remaining slots from keyword-score fallback
  for (const fb of fallbackMoments) {
    if (diverse.length >= desiredCount) break;
    if (diverse.every(d => momentsAreDiverse(d, fb, minGap))) diverse.push({ ...fb });
  }

  // Chronological sort + assign target durations
  const sorted = diverse.sort((a, b) => a.start - b.start);
  sorted.forEach((m, i) => {
    const targetLen = targetDurations[i] || desiredLength;
    if (m.end - m.start < targetLen - 5) m.end = Math.min(videoDuration || m.start + targetLen, m.start + targetLen);
    m.framingMode = framingMode;
  });
  return sorted.length ? sorted : fallbackMoments;
}

function overlapSeconds(a, b) {
  return Math.max(0, Math.min(Number(a.end), Number(b.end)) - Math.max(Number(a.start), Number(b.start)));
}

function overlapRatio(a, b) {
  const overlap = overlapSeconds(a, b);
  const shortest = Math.max(1, Math.min(Number(a.end) - Number(a.start), Number(b.end) - Number(b.start)));
  return overlap / shortest;
}

function momentsAreDiverse(a, b, minGap) {
  if (Math.abs(Number(a.start) - Number(b.start)) < minGap) return false;
  return overlapRatio(a, b) <= 0.20;
}

async function generateMultipleHooks(db, video, moment) {
  try {
    const result = await aiChat(db, {
      purpose: 'multi-hook generation',
      messages: [
        { role: 'system', content: 'You write viral short-form video hooks. Each hook must be under 96 characters. Return only JSON.' },
        { role: 'user', content: `Video: "${video.title}"\nClip transcript: "${(moment.text || moment.hook || '').slice(0, 800)}"\nClip reason: ${moment.reason || 'educational'}\n\nGenerate 6 powerful hooks:\n- curiosity: Creates an open loop, makes viewer need to know more\n- shock: Pattern interrupt, unexpected statement or fact\n- value: Promises clear immediate benefit or lesson\n- story: Personal story opener that hooks emotionally\n- controversy: Bold contrarian take that sparks debate\n- sales: Direct benefit-driven hook with urgency\n\nReturn: {"hooks":{"curiosity":"","shock":"","value":"","story":"","controversy":"","sales":""},"recommended":"curiosity|shock|value|story|controversy|sales","reasoning":"why this is the best hook type for this clip"}` }
      ]
    });
    const parsed = extractJsonObject(result.content) || {};
    return {
      hooks: parsed.hooks || moment.hooks || {},
      recommended: parsed.recommended || 'curiosity',
      reasoning: parsed.reasoning || ''
    };
  } catch {
    return { hooks: moment.hooks || {}, recommended: 'curiosity', reasoning: '' };
  }
}

async function generateAllPlatformContent(db, video, clip) {
  const hook = clip.hook || clip.title || video.title;
  const excerpt = (clip.transcriptExcerpt || clip.hook || '').slice(0, 1200);
  try {
    const result = await aiChat(db, {
      purpose: 'multi-platform content generation',
      messages: [
        { role: 'system', content: 'You are a social media expert who writes platform-native viral content. Each platform has a different voice, format, and algorithm. Return only JSON.' },
        { role: 'user', content: `Video: "${video.title}"\nClip hook: "${hook}"\nClip transcript: "${excerpt}"\nViral score: ${clip.score}/100\nReason: ${clip.reason || 'educational'}\n\nGenerate platform-optimized content for each platform.\n\nTikTok: Casual, trend-aware, Gen-Z energy, conversational\nYouTube Shorts: SEO-optimized title, curiosity gap, searchable\nInstagram Reels: Aesthetic, lifestyle, aspirational, save-worthy\nX (Twitter): Punchy, opinionated, debate-starting, 1-3 tweets thread format\nLinkedIn: Professional insights, value-driven, thought leadership\nFacebook: Broad appeal, story-driven, community-focused\n\nReturn: {"tiktok":{"caption":"","hashtags":[],"firstComment":"","bestTime":"","tip":""},"youtube":{"title":"","description":"","tags":[],"thumbnail":"text overlay suggestion"},"instagram":{"caption":"","hashtags":[],"reelCover":"description","tip":""},"x":{"tweet":"","thread":["tweet1","tweet2"],"hashtags":[]},"linkedin":{"post":"","hashtags":[],"insight":"key professional takeaway"},"facebook":{"caption":"","tip":""},"seo":{"keywords":[],"searchQuery":"what someone would Google to find this content"},"postingSchedule":{"bestDay":"","bestTime":"","notes":""}}` }
      ]
    });
    const parsed = extractJsonObject(result.content) || {};
    return parsed;
  } catch {
    return {
      tiktok: { caption: hook, hashtags: ['#viral', '#shorts', '#fyp'], firstComment: '', bestTime: '6-9pm', tip: 'Add trending audio.' },
      youtube: { title: hook, description: `${hook}\n\n${excerpt.slice(0, 200)}`, tags: ['shorts', 'viral'], thumbnail: 'Bold text on left, face on right' },
      instagram: { caption: `${hook} 🔥`, hashtags: ['#reels', '#viral', '#creator'], reelCover: 'Close-up face frame', tip: 'Use trending audio.' },
      x: { tweet: hook, thread: [hook, excerpt.slice(0, 240)], hashtags: [] },
      linkedin: { post: `${hook}\n\n${excerpt.slice(0, 400)}`, hashtags: ['#business', '#growth'], insight: hook },
      facebook: { caption: hook, tip: 'Post to Reels and your page feed.' },
      seo: { keywords: [], searchQuery: video.title },
      postingSchedule: { bestDay: 'Tuesday-Thursday', bestTime: '6pm-9pm local', notes: 'Post consistently' }
    };
  }
}

async function generateThumbnailOptions(clipId, clipPath, hook, title, canDraw) {
  if (!canDraw) return [];
  // Thumbnails are portrait 9:16 (540×960) — clips are already 1080×1920 portrait.
  // Text Y positions are relative to h=960.
  const styles = [
    { name: 'viral',   label: 'Viral Bold',    textColor: 'white',    boxColor: 'black@0.85', fontSize: 46, textY: 'h-200', titleY: '48' },
    { name: 'luxury',  label: 'Luxury Clean',  textColor: 'white',    boxColor: 'black@0.60', fontSize: 38, textY: 'h-230', titleY: '60' },
    { name: 'neon',    label: 'Neon Pop',      textColor: '#00ffcc',  boxColor: 'black@0.90', fontSize: 42, textY: 'h-215', titleY: '54' },
  ];
  const results = [];
  for (const style of styles) {
    const outPath = path.join(STORAGE_DIR, 'thumbnails', `thumb_${clipId}_${style.name}.jpg`);
    try {
      const hookSafe  = ffmpegText(hook.slice(0, 50));
      const titleSafe = ffmpegText(title.slice(0, 32));
      // Scale portrait clip to 540×960 (exact 9:16 half resolution)
      const filters = [
        'scale=540:960:flags=lanczos',
        `drawtext=text='${titleSafe}':x=(w-text_w)/2:y=${style.titleY}:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10`,
        `drawtext=text='${hookSafe}':x=(w-text_w)/2:y=${style.textY}:fontsize=${style.fontSize}:fontcolor=${style.textColor}:box=1:boxcolor=${style.boxColor}:boxborderw=18`,
      ].join(',');
      await run(FFMPEG, ['-y', '-ss', '1', '-i', clipPath, '-frames:v', '1', '-vf', filters, '-q:v', '2', outPath], { timeoutMs: 15_000, label: 'thumbnail gen' });
      if (existsSync(outPath)) {
        results.push({ name: style.name, label: style.label, path: `/media/thumbnails/thumb_${clipId}_${style.name}.jpg` });
      }
    } catch { /* skip failed styles */ }
  }
  return results;
}

async function suggestBrollKeywords(db, transcript, title) {
  const text = transcript.map(s => s.text).join(' ').slice(0, 6000);
  try {
    const result = await aiChat(db, {
      purpose: 'broll keyword extraction',
      messages: [
        { role: 'system', content: 'You suggest B-roll footage keywords for video editors. Return only JSON.' },
        { role: 'user', content: `Video: "${title}"\nTranscript: "${text}"\n\nIdentify key topics and suggest specific B-roll footage that would enhance each section. Think like a professional video editor.\n\nReturn: {"suggestions":[{"timestamp":"0-15s","topic":"what speaker is discussing","brollKeywords":["specific","footage","keywords"],"stockQuery":"exact phrase to search on Pexels/Shutterstock","mood":"energy level: calm|moderate|high|intense"}],"overallTheme":"","recommendedStyle":"talking-head|cinematic|dynamic|documentary"}` }
      ]
    });
    const parsed = extractJsonObject(result.content) || {};
    return parsed;
  } catch {
    return { suggestions: [], overallTheme: title, recommendedStyle: 'talking-head' };
  }
}

async function generateFacelessScript(db, topic, opts = {}) {
  const {
    style = 'documentary', targetSeconds = 45, tone = 'mysterious',
    language = 'English', platform = 'TikTok', hookStrength = 8,
    audienceType = 'general', ctaType = 'follow', storytellingMode = 'revelation'
  } = opts;
  const styleGuides = {
    documentary: 'Cinematic documentary narration, mysterious, factual, authoritative — think National Geographic meets Netflix true crime',
    motivation:  'High-energy motivational, direct, punchy sentences — every line hits like a punch, no filler, pure fuel for action',
    finance:     'Professional financial analysis, data-driven, confident expert tone — like a Wall Street insider sharing alpha',
    crypto:      'Crypto-native, alpha-focused, community language, bullish energy — degens and builders will feel seen',
    education:   'Clear educational breakdown, step-by-step, relatable real-world examples — the viewer learns something valuable by the end',
    comedy:      'Absurdist humor, self-aware, gen-Z energy, meme references — timing is everything, punchline on the last line',
    luxury:      'Premium lifestyle, aspirational, exclusive tone — makes the viewer feel they are being let into a secret world of the elite',
    horror:      'Dark, suspenseful, slow-burn reveal, chilling delivery — each sentence escalates dread until the shocking reveal',
    ai:          'Tech-forward, mind-expanding, future-focused, awe-inspiring — the viewer feels like they are seeing the future first',
    history:     'Epic historical drama, vivid cinematic storytelling, dramatic reveals — brings the past to life like a blockbuster film',
    crime:       'True-crime thriller, tense, suspenseful, detail-obsessed — hooks with a shocking fact, builds tension, delivers the twist',
    health:      'Empathetic, science-backed, actionable, credible expert voice — viewer walks away with something they can use today',
    business:    'Sharp entrepreneurial insight, tactical, results-oriented — founder/operator speak, no corporate BS, pure signal',
    space:       'Cosmic wonder, scientific awe, scale-bending perspective — makes viewers feel small and amazed at the universe',
    reddit:      'Reddit-style first-person storytelling, conversational, confessional — "So this happened to me..." feels authentic and relatable',
    kids:        'Fun, energetic, age-appropriate educational content — bright energy, simple language, encouraging tone, teaches one clear lesson',
    news:        'Breaking news urgency, punchy headlines, quick facts — get to the point immediately, every second counts',
    wellness:    'Calm, grounding, science-backed wellness advice — the viewer feels healthier, calmer, and more in control by the end',
    sports:      'High-energy sports commentary, peak moments, dramatic narration — pumps up the viewer like a championship highlight reel',
    conspiracy:  'Mystery and intrigue, "what they do not want you to know" energy — provocative questions, subtle reveals, audience hooked on the truth',
    travel:      'Wanderlust-inducing, vivid sensory descriptions, adventure energy — viewer books a flight or starts saving money immediately',
    relationship:'Raw, honest relationship insight, relatably painful or joyful — viewer pauses and thinks "this is exactly my situation"',
  };
  const ctaMap = {
    follow:     'Follow for more content like this',
    comment:    'Comment your thoughts below',
    share:      'Share this with someone who needs to see it',
    link:       'Check the link in bio for more',
    subscribe:  'Subscribe so you never miss a drop',
    save:       'Save this for later'
  };
  const guide = styleGuides[style] || styleGuides.documentary;
  const ctaText = ctaMap[ctaType] || ctaMap.follow;
  const wordsPerSecond = 2.5;
  const targetWords = Math.round(targetSeconds * wordsPerSecond);
  try {
    const result = await aiChat(db, {
      purpose: 'faceless video script',
      messages: [
        { role: 'system', content: 'You are an elite viral content strategist who writes faceless short-form video scripts optimized for TikTok, YouTube Shorts, and Instagram Reels algorithm virality. You ONLY respond with valid JSON, no markdown, no explanation.' },
        { role: 'user', content: `Create a complete ${targetSeconds}-second faceless video script package.

Topic: "${topic}"
Style: ${guide}
Tone: ${tone}
Platform: ${platform}
Language: ${language}
Hook Strength: ${hookStrength}/10 (${hookStrength>=8?'ultra-viral aggressive opener':hookStrength>=6?'strong curiosity hook':'moderate hook'})
Audience: ${audienceType}
Storytelling Mode: ${storytellingMode}
CTA: "${ctaText}"
Target word count: ~${targetWords} words (spoken at 2.5 words/second)

Return this exact JSON structure (no markdown fences):
{
  "title": "viral video title",
  "hook": "opening line — first 3 seconds, must stop the scroll",
  "script": "full narration text — all ${targetWords} words",
  "scenes": [
    {
      "timestamp": "0-5s",
      "narration": "exact words spoken",
      "visualDirection": "specific visual description — what camera/shot to use",
      "brollQuery": "stock footage search term",
      "imagePrompt": "AI image generation prompt for this scene (Midjourney/DALL-E style)",
      "videoPrompt": "AI video generation prompt for this scene (Sora/Kling style)"
    }
  ],
  "voiceStyle": "calm|energetic|mysterious|authoritative|conversational|dramatic",
  "backgroundMusic": "specific genre + energy description",
  "brollKeywords": ["keyword1","keyword2","keyword3","keyword4","keyword5","keyword6"],
  "captions": ["caption line 1","caption line 2","caption line 3","caption line 4","caption line 5"],
  "thumbnailTitle": "text overlay for thumbnail — max 6 words, all caps",
  "thumbnailPrompt": "AI image prompt for the thumbnail — ultra specific cinematic description",
  "seoTitle": "SEO-optimized video title with keywords",
  "description": "full video description with natural keyword integration, 80-120 words",
  "hashtags": ["#hashtag1","#hashtag2","#hashtag3","#hashtag4","#hashtag5","#hashtag6","#hashtag7","#hashtag8","#hashtag9","#hashtag10","#hashtag11","#hashtag12"],
  "cta": "the specific call to action line used at the end",
  "wordCount": ${targetWords},
  "estimatedSeconds": ${targetSeconds}
}` }
      ]
    });
    const parsed = extractJsonObject(result.content) || {};
    return { ok: true, ...parsed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function generatePostingAssistant(db, video, moment, platform = 'TikTok') {
  const fallback = postingAssistant(video.title, moment.hook || buildCaptionText(moment.text || video.title), platform);
  try {
    const platformContent = await generateAllPlatformContent(db, video, {
      hook: moment.hook || '',
      score: moment.score || 75,
      reason: moment.reason || 'educational',
      transcriptExcerpt: (moment.text || '').slice(0, 1200)
    });
    const tiktok = platformContent.tiktok || {};
    const youtube = platformContent.youtube || {};
    const allHashtags = [...(tiktok.hashtags || []), ...(youtube.tags || [])].slice(0, 12);
    return {
      ...fallback,
      suggestedTitle: youtube.title || fallback.suggestedTitle,
      caption: tiktok.caption || fallback.caption,
      hashtags: allHashtags.length ? allHashtags : fallback.hashtags,
      bestPlatform: moment.bestPlatform || platform,
      bestTime: platformContent.postingSchedule?.bestTime || fallback.bestTime,
      firstComment: tiktok.firstComment || fallback.firstComment,
      platformContent,
      instructions: fallback.instructions
    };
  } catch {
    return fallback;
  }
}

async function handleApi(req, res, pathname) {
  try {
    if (pathname === '/api/session') {
      const db = loadDb();
      const user = currentUser(req, db); // intentionally not requireUser — returns null instead of throwing
      if (!user) return json(res, 200, { user: null });
      const { subscription, plan } = subscriptionFor(db, user.id);
      // Cache tool checks for the lifetime of this process (spawning subprocesses on every refresh is expensive)
      if (!_toolsCache) {
        const ytdlpCommand = await workingYtDlpCommand();
        const ytdlpStatus = ytdlpCommand ? await commandVersion(ytdlpCommand) : { ok: false, version: '', error: `Tried: ${ytdlpCandidates().join(', ')}` };
        const ffmpegStatus = await commandVersion(FFMPEG);
        _toolsCache = { ytdlpCommand, ytdlpStatus, ffmpegStatus };
      }
      const { ytdlpCommand, ytdlpStatus, ffmpegStatus } = _toolsCache;
      const tools = {
        ytDlp: ytdlpStatus.ok,
        ytDlpVersion: ytdlpStatus.version,
        ytDlpCommand: ytdlpCommand || '',
        ytDlpError: ytdlpStatus.error || '',
        ffmpeg: ffmpegStatus.ok,
        ffmpegVersion: ffmpegStatus.version,
        ffmpegError: ffmpegStatus.error || '',
        youtubeApi: settingReady(db, 'YOUTUBE_API_KEY'),
        llm: settingReady(db, 'LLM_API_KEY'),
        gemini: settingReady(db, 'GEMINI_API_KEY'),
        aiProvider: settingValue(db, 'AI_PROVIDER') || (settingReady(db, 'GEMINI_API_KEY') ? 'gemini' : (settingReady(db, 'LLM_API_KEY') ? settingValue(db, 'LLM_PROVIDER') || 'openai' : 'none')),
        postgres: settingReady(db, 'DATABASE_URL'),
        memory: memorySnapshot(),
        maxUploadMb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
        maxConcurrentRenderJobs: MAX_CONCURRENT_RENDER_JOBS
      };
      const scopedVideos = user.role === 'admin' ? db.videos : db.videos.filter(item => userCanAccessVideo(user, item));
      const scopedVideoIds = new Set(scopedVideos.map(item => item.id));
      const scopedClips = user.role === 'admin' ? db.clips : db.clips.filter(item => userCanAccessClip(user, item, db));
      return json(res, 200, {
        user: publicUser(user),
        subscription,
        plan,
        stats: {
          imports: db.imports.filter(item => item.userId === user.id || user.role === 'admin').length,
          videos: scopedVideos.length,
          projects: db.projects.filter(item => item.userId === user.id || user.role === 'admin').length,
          jobs: db.jobs.filter(item => item.userId === user.id || user.role === 'admin').length,
          clips: scopedClips.length,
          scheduledPosts: db.scheduledPosts?.filter(item => {
            const clip = db.clips.find(c => c.id === item.clipId);
            return user.role === 'admin' || (clip && (userCanAccessClip(user, clip, db) || scopedVideoIds.has(clip.videoId)));
          }).length || 0,
          socialAccounts: db.socialAccounts?.filter(item => item.userId === user.id || !item.userId).length || 0,
          watchedChannels: db.watchedChannels?.filter(item => item.userId === user.id || user.role === 'admin').length || 0
        },
        tools,
        setup: [
          {
            id: 'youtube',
            label: 'YouTube Data API key',
            ready: tools.youtubeApi,
            action: 'Create a Google Cloud API key with YouTube Data API v3 enabled, then set YOUTUBE_API_KEY.'
          },
          {
            id: 'ytdlp',
            label: 'yt-dlp binary',
            ready: tools.ytDlp,
            action: tools.ytDlp ? `${tools.ytDlpVersion} via ${tools.ytDlpCommand}` : `Install yt-dlp on Render. Startup error: ${tools.ytDlpError}`
          },
          {
            id: 'ffmpeg',
            label: 'FFmpeg binary',
            ready: tools.ffmpeg,
            action: tools.ffmpeg ? tools.ffmpegVersion : `Install FFmpeg on Render. Startup error: ${tools.ffmpegError}`
          },
          {
            id: 'gemini',
            label: 'Gemini AI (primary brain)',
            ready: tools.gemini,
            action: tools.gemini
              ? `Active — provider: ${tools.aiProvider} — powers viral detection, hooks, titles, hashtags, QA, and direct video understanding`
              : 'Get a free API key at aistudio.google.com — set GEMINI_API_KEY in Settings. Enables video-native AI analysis (Gemini watches the video, not just the transcript).'
          },
          {
            id: 'llm',
            label: 'Fallback LLM (Whisper + backup chat)',
            ready: tools.llm,
            action: tools.llm
              ? 'Active — used for Whisper transcription and fallback chat when Gemini is unavailable.'
              : 'Optional. Set LLM_PROVIDER + LLM_API_KEY for Whisper word-level transcription (better caption timing) and chat fallback.'
          },
          {
            id: 'postgres',
            label: 'Postgres database',
            ready: tools.postgres,
            action: 'Set DATABASE_URL and run sql/schema.sql when moving from local JSON storage to production.'
          },
          {
            id: 'platforms',
            label: 'Manual posting mode',
            ready: true,
            action: 'No social OAuth is required. Users download clips and manually post with the generated guide.'
          }
        ]
      });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !email.includes('@')) throw new Error('Enter a valid email address.');
      const db = loadDb();
      let user = db.users.find(item => item.email.toLowerCase() === email);
      if (!user) throw new Error('No account found. Create an account first.');
      if (password && !verifyPassword(password, user.passwordHash)) throw new Error('Incorrect password.');
      if (password && !user.passwordHash.startsWith('scrypt:')) {
        // Migrate legacy unsalted hash to scrypt now that we know the plaintext.
        user.passwordHash = hashPassword(password);
        saveDb(db);
      }
      return json(res, 200, { user: publicUser(user), token: signToken(user.id) });
    }
    if (pathname === '/api/signup' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !email.includes('@')) throw new Error('Enter a valid email address.');
      if (password.length < 6) throw new Error('Use at least 6 characters for password.');
      const db = loadDb();
      if (db.users.find(item => item.email.toLowerCase() === email)) throw new Error('That account already exists.');
      const user = {
        id: randomUUID(),
        name: email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase()),
        email,
        passwordHash: hashPassword(password),
        plan: 'Free',
        credits: 20,
        role: 'user',
        onboardingComplete: false,
        defaults: { captionStyle: 'Bold captions', platforms: ['TikTok'] },
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      db.subscriptions.push({ id: randomUUID(), userId: user.id, planId: 'free', status: 'active', currentPeriodEnd: null });
      db.creditTransactions.unshift({ id: randomUUID(), userId: user.id, amount: 20, reason: 'Signup credits', createdAt: new Date().toISOString() });
      saveDb(db);
      return json(res, 200, { user: publicUser(user), token: signToken(user.id) });
    }
    if (pathname === '/api/billing/bank') {
      const db = loadDb();
      return json(res, 200, {
        bankAccount: db.bankAccounts.find(item => item.active) || db.bankAccounts[0],
        creditPackages: [
          { credits: 40, amount: 1000, currency: 'NGN' },
          { credits: 120, amount: 2500, currency: 'NGN' },
          { credits: 300, amount: 6000, currency: 'NGN' }
        ]
      });
    }
    if (pathname === '/api/billing/transfer' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const credits = Number(body.credits || 0);
      const amount = Number(body.amount || 0);
      const depositorName = String(body.depositorName || '').trim();
      const reference = String(body.reference || '').trim();
      if (![40, 120, 300].includes(credits)) throw new Error('Choose a valid credit package.');
      if (!amount || amount < 1) throw new Error('Enter the transfer amount.');
      if (!depositorName) throw new Error('Enter the depositor/account name.');
      if (!reference) throw new Error('Enter the transfer reference.');
      const request = {
        id: randomUUID(),
        userId: user.id,
        credits,
        amount,
        currency: body.currency || 'NGN',
        depositorName,
        reference,
        note: body.note || '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      db.paymentRequests.unshift(request);
      saveDb(db);
      return json(res, 200, request);
    }
    if (pathname === '/api/import' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      // Rate-limit: max 10 import requests per user per 60 seconds
      const importRateWindow = 60 * 1000;
      const importRateMax = 10;
      const now = Date.now();
      const userImportTimes = (importUserAttempts.get(user.id) || []).filter(t => now - t < importRateWindow);
      if (userImportTimes.length >= importRateMax) {
        throw Object.assign(new Error('Too many import requests. Please wait 60 seconds before importing again.'), { status: 429 });
      }
      userImportTimes.push(now);
      importUserAttempts.set(user.id, userImportTimes);
      return json(res, 200, await importSource(body.sourceUrl || '', user.id));
    }
    if (pathname === '/api/upload' && req.method === 'POST') {
      const db = loadDb();
      requireUser(req, db);
      return json(res, 200, await importUploadedVideo(req));
    }
    if (pathname === '/api/debug/import') {
      const db = loadDb();
      requireUser(req, db);
      const debugUrl = new URL(req.url, `http://${req.headers.host}`).searchParams.get('url') || '';
      const parsed = parseYouTubeUrl(debugUrl);
      let apiVideos = [];
      let ytdlpVideos = [];
      let apiError = '';
      let ytdlpError = '';
      try {
        if (parsed.type === 'video') apiVideos = [await fetchYouTubeVideoWithApi(parsed.id)].filter(Boolean);
        else if (parsed.type === 'playlist') apiVideos = await fetchPlaylistWithApi(parsed.id) || [];
        else apiVideos = await fetchChannelWithApi(parsed.canonical) || [];
      } catch (error) {
        apiError = error.message;
      }
      try {
        ytdlpVideos = await fetchWithYtDlp(parsed.canonical);
      } catch (error) {
        ytdlpError = error.message;
      }
      const first = apiVideos[0] || ytdlpVideos[0] || null;
      return json(res, 200, {
        parsed,
        title: first?.title || '',
        durationSeconds: first?.durationSeconds || 0,
        status: first ? 'public/importable' : 'unavailable',
        rejectionReason: first ? '' : (apiError || ytdlpError || 'No public videos found'),
        youtubeApi: { ok: Boolean(apiVideos.length), error: apiError },
        ytdlp: { ok: Boolean(ytdlpVideos.length), error: ytdlpError }
      });
    }
    if (pathname === '/api/watch-channel' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const watch = await addWatchedChannel({ ...body, userId: user.id });
      if (body.checkNow) {
        setTimeout(() => pollWatchedChannel(watch.id).catch(() => {}), 10);
      }
      return json(res, 200, watch);
    }
    if (pathname === '/api/poll-watch' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      requireWatchAccess(db, user, body.watchId);
      return json(res, 200, await pollWatchedChannel(body.watchId));
    }
    if (pathname === '/api/poll-all' && req.method === 'POST') {
      const db = loadDb();
      const user = requireUser(req, db);
      const active = db.watchedChannels.filter(item => item.status === 'active' && (user.role === 'admin' || item.userId === user.id));
      const results = [];
      for (const watch of active) {
        try {
          results.push(await pollWatchedChannel(watch.id));
        } catch (error) {
          results.push({ watchId: watch.id, error: error.message });
        }
      }
      return json(res, 200, { checked: active.length, results });
    }
    if (pathname === '/api/library') {
      recoverStaleJobs('library-check');
      const db = loadDb();
      if (!Array.isArray(db.scheduledPosts)) db.scheduledPosts = [];
      if (!Array.isArray(db.socialAccounts)) db.socialAccounts = [];
      if (!Array.isArray(db.transcriptions)) db.transcriptions = [];
      if (!Array.isArray(db.studioGenerations)) db.studioGenerations = [];
      const user = requireUser(req, db);
      const isAdmin = user.role === 'admin';
      // Scope all collections to the requesting user (admins see everything)
      const myVideos = isAdmin ? db.videos : db.videos.filter(v => v.userId === user.id || v.createdBy === user.id);
      const myVideoIds = new Set(myVideos.map(v => v.id));
      const myClips = isAdmin ? db.clips : db.clips.filter(c => c.userId === user.id || c.createdBy === user.id || myVideoIds.has(c.videoId));
      const myJobs = isAdmin ? db.jobs : db.jobs.filter(j => j.userId === user.id || j.createdBy === user.id || myVideoIds.has(j.videoId));
      const myProjects = isAdmin ? db.projects : db.projects.filter(p => p.userId === user.id || p.createdBy === user.id);
      const mySocialAccounts = isAdmin ? db.socialAccounts : db.socialAccounts.filter(a => a.userId === user.id);
      const myScheduledPosts = isAdmin ? db.scheduledPosts : db.scheduledPosts.filter(p => {
        const clip = db.clips.find(c => c.id === p.clipId);
        return clip && (clip.userId === user.id || clip.createdBy === user.id || myVideoIds.has(clip.videoId));
      });
      const myTranscriptions = isAdmin ? db.transcriptions : db.transcriptions.filter(t => myVideoIds.has(t.videoId));
      const myStudioGenerations = isAdmin ? db.studioGenerations : db.studioGenerations.filter(g => g.userId === user.id);
      const myImports = isAdmin ? db.imports : db.imports.filter(item => item.userId === user.id || myProjects.some(project => project.importId === item.id));
      const myWatchedChannels = isAdmin ? db.watchedChannels : db.watchedChannels.filter(item => item.userId === user.id);
      const myBrandKits = isAdmin ? db.brandKits : db.brandKits.filter(item => item.userId === user.id);
      const myAudioGenerations = isAdmin ? (db.audioGenerations || []) : (db.audioGenerations || []).filter(item => item.userId === user.id);
      const myUsageEvents = isAdmin ? (db.usageEvents || []) : (db.usageEvents || []).filter(item => item.userId === user.id);
      const mySeriesJobs = isAdmin ? (db.seriesJobs || []) : (db.seriesJobs || []).filter(item => item.userId === user.id || myVideoIds.has(item.videoId));
      const mySeriesJobIds = new Set(mySeriesJobs.map(item => item.id));
      const mySeriesParts = isAdmin ? (db.seriesParts || []) : (db.seriesParts || []).filter(item => mySeriesJobIds.has(item.seriesId));
      // Attach live queue position so a queued job shows "waiting behind N others" instead
      // of an indistinguishable-from-stalled 0% progress bar.
      const queuedJobIds = renderQueue.map(item => item.payload.jobId).filter(Boolean);
      const myJobsWithQueue = myJobs.map(job => {
        if (job.status !== 'queued') return job;
        const idx = queuedJobIds.indexOf(job.id);
        if (idx === -1) return job;
        return { ...job, queuePosition: idx + 1, queueTotal: queuedJobIds.length, queueActive: activeRenderJobs };
      });
      const scopedDb = {
        ...db,
        videos: myVideos,
        clips: myClips,
        jobs: myJobsWithQueue,
        projects: myProjects,
        socialAccounts: mySocialAccounts,
        scheduledPosts: myScheduledPosts,
        transcriptions: myTranscriptions,
        studioGenerations: myStudioGenerations,
        imports: myImports,
        watchedChannels: myWatchedChannels,
        brandKits: myBrandKits,
        audioGenerations: myAudioGenerations,
        usageEvents: myUsageEvents,
        seriesJobs: mySeriesJobs,
        seriesParts: mySeriesParts,
        apiSettings: isAdmin
          ? db.apiSettings.map(item => ({ ...item, configured: Boolean(item.value || process.env[item.key]), value: item.value ? '••••••••' : '' }))
          : [],
        aiLogs: isAdmin ? (db.aiLogs || []) : [],
        importCache: isAdmin ? (db.importCache || []) : [],
        bankAccounts: isAdmin ? (db.bankAccounts || []) : [],
        // Admins see all users; regular users only see themselves
        users: isAdmin ? db.users.map(publicUser) : [publicUser(db.users.find(u => u.id === user.id))].filter(Boolean),
        subscriptions: isAdmin ? db.subscriptions : db.subscriptions.filter(s => s.userId === user.id),
        creditTransactions: isAdmin ? db.creditTransactions : db.creditTransactions.filter(t => t.userId === user.id),
        paymentRequests: isAdmin ? db.paymentRequests : db.paymentRequests.filter(p => p.userId === user.id),
      };
      return json(res, 200, scopedDb);
    }
    if (pathname === '/api/transcript' && req.method === 'GET') {
      const videoId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('videoId');
      const db = loadDb();
      const user = requireUser(req, db);
      if (!Array.isArray(db.transcriptions)) db.transcriptions = [];
      const video = db.videos.find(v => v.id === videoId && v.userId === user.id);
      if (!video) return json(res, 200, { segments: [], fullText: '', wordCount: 0 });
      const t = db.transcriptions.find(r => r.videoId === videoId);
      return json(res, 200, t || { segments: [], fullText: '', wordCount: 0 });
    }
    if (pathname === '/api/hooks/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const clip = db.clips.find(c => c.id === body.clipId && c.userId === user.id);
      const video = clip ? db.videos.find(v => v.id === clip.videoId && v.userId === user.id) : null;
      if (!clip || !video) throw new Error('Clip not found.');
      const result = await generateMultipleHooks(db, video, clip);
      await dbMutation(freshDb => {
        const freshClip = freshDb.clips.find(c => c.id === clip.id);
        if (freshClip) freshClip.hooks = result.hooks;
      });
      return json(res, 200, result);
    }
    if (pathname === '/api/social/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const clip = db.clips.find(c => c.id === body.clipId && c.userId === user.id);
      const video = clip ? db.videos.find(v => v.id === clip.videoId && v.userId === user.id) : null;
      if (!clip || !video) throw new Error('Clip not found.');
      const result = await generateAllPlatformContent(db, video, clip);
      await dbMutation(freshDb => {
        const freshClip = freshDb.clips.find(c => c.id === clip.id);
        if (freshClip) freshClip.platformContent = result;
      });
      return json(res, 200, result);
    }
    if (pathname === '/api/thumbnail/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const clip = db.clips.find(c => c.id === body.clipId && c.userId === user.id);
      if (!clip) throw new Error('Clip not found.');
      const clipPath = path.join(STORAGE_DIR, 'clips', path.basename(clip.outputPath));
      const canDraw = await drawtextSupported();
      const options = await generateThumbnailOptions(clip.id, clipPath, clip.hook || clip.title, clip.title || '', canDraw);
      await dbMutation(freshDb => {
        const freshClip = freshDb.clips.find(c => c.id === clip.id);
        if (freshClip) freshClip.thumbnailOptions = options;
      });
      return json(res, 200, { options });
    }
    if (pathname === '/api/broll/suggest' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const video = db.videos.find(v => v.id === body.videoId && v.userId === user.id);
      if (!video) throw new Error('Video not found.');
      const transcription = db.transcriptions?.find(t => t.videoId === body.videoId);
      const segments = transcription?.segments || [];
      const result = await suggestBrollKeywords(db, segments, video.title);
      return json(res, 200, result);
    }
    if (pathname === '/api/faceless/generate' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.topic) throw new Error('Topic is required.');
      const db = loadDb();
      const user = requireUser(req, db);
      const FACELESS_COST = 3;
      if (CREDITS_ENABLED && user.role !== 'admin' && user.credits < FACELESS_COST) {
        throw new Error(`Not enough credits. Faceless script generation costs ${FACELESS_COST} credits.`);
      }
      const result = await generateFacelessScript(db, String(body.topic), {
        style:           String(body.style || 'documentary'),
        targetSeconds:   Number(body.duration || 45),
        tone:            String(body.tone || 'mysterious'),
        language:        String(body.language || 'English'),
        platform:        String(body.platform || 'TikTok'),
        hookStrength:    Number(body.hookStrength || 8),
        audienceType:    String(body.audienceType || 'general'),
        ctaType:         String(body.ctaType || 'follow'),
        storytellingMode:String(body.storytellingMode || 'revelation')
      });
      if (result.ok) {
        // Deduct credits only on success — no charge for Gemini outages
        if (CREDITS_ENABLED && user.role !== 'admin') {
          const freshDb = loadDb();
          const userIdx = freshDb.users.findIndex(u => u.id === user.id);
          if (userIdx !== -1) {
            freshDb.users[userIdx].credits -= FACELESS_COST;
            freshDb.creditTransactions.unshift({ id: randomUUID(), userId: user.id, amount: -FACELESS_COST, reason: `Faceless script — ${body.topic}`, createdAt: new Date().toISOString() });
          }
          if (!Array.isArray(freshDb.studioGenerations)) freshDb.studioGenerations = [];
          freshDb.studioGenerations.unshift({ id: randomUUID(), userId: user.id, type: 'faceless_script', topic: body.topic, style: body.style, result, createdAt: new Date().toISOString() });
          freshDb.studioGenerations = freshDb.studioGenerations.slice(0, 50);
          saveDb(freshDb);
        } else {
          const freshDb = loadDb();
          if (!Array.isArray(freshDb.studioGenerations)) freshDb.studioGenerations = [];
          freshDb.studioGenerations.unshift({ id: randomUUID(), userId: user.id, type: 'faceless_script', topic: body.topic, style: body.style, result, createdAt: new Date().toISOString() });
          freshDb.studioGenerations = freshDb.studioGenerations.slice(0, 50);
          saveDb(freshDb);
        }
      }
      return json(res, 200, result);
    }
    // ── Digital Human Studio integration ─────────────────────────────
    // Proxies requests to the local Digital Human Studio server (port 4200).
    // This lets ClipForge users generate AI presenter / talking-head videos
    // without leaving the ClipForge interface.
    if (pathname.startsWith('/api/digital-human/') && (req.method === 'POST' || req.method === 'GET')) {
      const db = loadDb();
      const user = requireUser(req, db);
      const DHS_URL = (settingValue(db, 'DIGITAL_HUMAN_STUDIO_URL') || 'http://localhost:4200').replace(/\/$/, '');
      const dhPath  = pathname.replace('/api/digital-human', '/api');
      const dhHeaders = { 'content-type': 'application/json', 'x-user-id': user.id };
      let fetchOpts = { method: req.method, headers: dhHeaders, signal: AbortSignal.timeout(60_000) };
      if (req.method === 'POST') {
        const body = await readJson(req);
        fetchOpts.body = JSON.stringify(body);
      }
      try {
        const r = await fetch(`${DHS_URL}${dhPath}`, fetchOpts);
        const data = await r.json();
        return json(res, r.status, data);
      } catch (e) {
        throw new Error(`Digital Human Studio unreachable. Make sure it is running at ${DHS_URL}. Error: ${e.message}`);
      }
    }

    // Quick status check — is Digital Human Studio running?
    if (pathname === '/api/digital-human-status') {
      const db = loadDb();
      requireUser(req, db);
      const DHS_URL = (settingValue(db, 'DIGITAL_HUMAN_STUDIO_URL') || 'http://localhost:4200').replace(/\/$/, '');
      try {
        const r = await fetch(`${DHS_URL}/api/setup/check`, { signal: AbortSignal.timeout(5_000) });
        const data = await r.json();
        return json(res, 200, { connected: true, url: DHS_URL, ...data });
      } catch {
        return json(res, 200, { connected: false, url: DHS_URL, error: 'Digital Human Studio not running. Start it with: cd ~/digital-human-studio && npm start' });
      }
    }

    // ── AI Media Generation (Higgsfield / Muapi) ─────────────────────
    if (pathname === '/api/ai/models') {
      const db = loadDb();
      requireUser(req, db);
      const ready = aiMediaReady(db);
      const models = Object.entries(AI_MEDIA_MODELS).map(([id, m]) => ({ id, label: m.label, category: m.category, provider: m.provider, seconds: m.seconds }));
      return json(res, 200, { models, ready });
    }
    if (pathname === '/api/ai/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      if (!body.model || !body.prompt) throw new Error('model and prompt are required');
      if (!AI_MEDIA_MODELS[body.model]) throw new Error(`Unknown model: ${body.model}`);
      const generation = {
        id: randomUUID(),
        userId: user.id,
        model: body.model,
        prompt: String(body.prompt).slice(0, 800),
        negativePrompt: String(body.negativePrompt || '').slice(0, 400),
        imageUrl: body.imageUrl || '',
        clipId: body.clipId || '',
        status: 'queued',
        externalId: '',
        outputPath: '',
        error: '',
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null
      };
      if (!db.studioGenerations) db.studioGenerations = [];
      db.studioGenerations.unshift(generation);
      saveDb(db);
      // run async
      setImmediate(() => {
        const db2 = loadDb();
        const gen = db2.studioGenerations.find(g => g.id === generation.id);
        if (gen) runAiMediaGeneration(db2, gen).catch(e => console.error('[ai-gen]', e.message));
      });
      return json(res, 202, { id: generation.id, status: 'queued' });
    }
    if (pathname === '/api/ai/generations') {
      const db = loadDb();
      const user = requireUser(req, db);
      const gens = (db.studioGenerations || []).filter(g => g.userId === user.id);
      return json(res, 200, { generations: gens });
    }
    if (pathname.startsWith('/api/ai/generation/') && req.method === 'DELETE') {
      const genId = pathname.split('/').pop();
      const db = loadDb();
      const user = requireUser(req, db);
      const gen = (db.studioGenerations || []).find(g => g.id === genId && g.userId === user.id);
      if (gen?.outputPath) {
        const fp = path.join(STORAGE_DIR, gen.outputPath.replace('/media/', ''));
        if (existsSync(fp)) unlinkSync(fp);
      }
      db.studioGenerations = (db.studioGenerations || []).filter(g => !(g.id === genId && g.userId === user.id));
      saveDb(db);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/tts/voices' && req.method === 'GET') {
      const db = loadDb();
      requireUser(req, db);
      const elKey = settingValue(db, 'ELEVENLABS_API_KEY');
      const useEL = !!elKey;
      if (useEL) {
        try {
          const resp = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': elKey } });
          if (resp.ok) {
            const data = await resp.json();
            const voices = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, preview: v.preview_url, provider: 'elevenlabs' }));
            return json(res, 200, { provider: 'elevenlabs', voices });
          }
        } catch {}
      }
      return json(res, 200, { provider: 'openai', voices: [
        { id: 'alloy',   name: 'Alloy — neutral, versatile',   provider: 'openai' },
        { id: 'echo',    name: 'Echo — clear, male',            provider: 'openai' },
        { id: 'fable',   name: 'Fable — warm, British',         provider: 'openai' },
        { id: 'onyx',    name: 'Onyx — deep, authoritative',    provider: 'openai' },
        { id: 'nova',    name: 'Nova — bright, female',         provider: 'openai' },
        { id: 'shimmer', name: 'Shimmer — soft, female',        provider: 'openai' }
      ]});
    }
    if (pathname === '/api/tts/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const text = (body.text || '').trim();
      if (!text) throw new Error('No text provided.');
      if (text.length > 5000) throw new Error('Text too long (max 5000 chars).');
      const elKey = settingValue(db, 'ELEVENLABS_API_KEY');
      const llmKey = settingValue(db, 'LLM_API_KEY');
      const llmProvider = settingValue(db, 'LLM_PROVIDER') || 'openai';
      if (!elKey && !(llmProvider === 'openai' && llmKey)) throw new Error('No TTS API key configured. Add ElevenLabs or OpenAI key in Admin settings.');
      const filename = `tts_${user.id}_${randomUUID()}.mp3`;
      const outPath = path.join(STORAGE_DIR, 'audio', filename);
      let audioBuffer;
      if (elKey) {
        const voiceId = body.voiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel (default)
        const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: { 'xi-api-key': elKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: 'eleven_monolingual_v1', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
        });
        if (!resp.ok) { const e = await resp.text(); throw new Error(`ElevenLabs error: ${e}`); }
        audioBuffer = Buffer.from(await resp.arrayBuffer());
      } else {
        const resp = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${llmKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'tts-1', voice: body.voiceId || 'nova', input: text, response_format: 'mp3' })
        });
        if (!resp.ok) { const e = await resp.text(); throw new Error(`OpenAI TTS error: ${e}`); }
        audioBuffer = Buffer.from(await resp.arrayBuffer());
      }
      writeFileSync(outPath, audioBuffer);
      if (!Array.isArray(db.audioGenerations)) db.audioGenerations = [];
      db.audioGenerations.unshift({
        id: randomUUID(),
        userId: user.id,
        type: 'tts_audio',
        outputPath: `/media/audio/${filename}`,
        chars: text.length,
        voiceId: body.voiceId || '',
        createdAt: new Date().toISOString()
      });
      db.audioGenerations = db.audioGenerations.slice(0, 200);
      saveDb(db);
      return json(res, 200, { url: `/media/audio/${filename}`, filename, chars: text.length });
    }
    if (pathname === '/api/studio/status') {
      const db = loadDb();
      // Gemini is the primary AI brain — features are available when either is configured
      const geminiReady = settingReady(db, 'GEMINI_API_KEY');
      const llmReady    = settingReady(db, 'LLM_API_KEY');
      const aiReady     = geminiReady || llmReady;
      const whisperReady = llmReady; // Whisper needs OpenAI-compat key specifically
      const ffmpegReady = await hasCommand(FFMPEG);
      const canDraw = ffmpegReady ? await drawtextSupported() : false;
      const mediaReady = aiMediaReady(db);
      return json(res, 200, {
        features: {
          transcription:   { available: aiReady,     label: 'AI Transcription',            description: geminiReady ? 'Powered by Gemini (add LLM_API_KEY for Whisper word-level timing)' : 'Requires LLM API key (OpenAI Whisper compatible)' },
          viralDetection:  { available: aiReady,     label: 'Viral Moment Detection',       description: geminiReady ? 'Powered by Gemini — watches actual video' : 'AI scores every moment across 6 dimensions' },
          hookGeneration:  { available: aiReady,     label: '6-Style Hook Generation',      description: 'Curiosity, Shock, Value, Story, Controversy, Sales' },
          platformContent: { available: aiReady,     label: 'Platform Content Generation',  description: 'TikTok, YouTube, Instagram, X, LinkedIn, Facebook posts' },
          captions:        { available: canDraw,     label: 'Styled Captions',              description: 'Hormozi, Karaoke, Minimal, Luxury, Neon styles' },
          thumbnails:      { available: canDraw,     label: 'Thumbnail Generation',         description: '3 styles: Viral Bold, Luxury Clean, Neon Pop' },
          brollSuggestions:{ available: aiReady,     label: 'B-Roll Keyword Extraction',    description: 'AI suggests stock footage keywords per transcript section' },
          facelessContent: { available: aiReady,     label: 'Faceless Content Mode',        description: 'AI writes complete script + scene directions for faceless videos' },
          aiImageGen:      { available: mediaReady,  label: 'AI Image Generation',          description: 'FLUX 1.1 Pro, Ideogram 3.0, Higgsfield — text-to-image', setupKey: 'MUAPI_API_KEY' },
          aiVideoGen:      { available: mediaReady,  label: 'AI Video / B-Roll Studio',     description: 'Kling 2.1, Seedance, Wan2.1, Higgsfield — text-to-video & image-to-video', setupKey: 'MUAPI_API_KEY' },
          lipSync:         { available: mediaReady,  label: 'Lip Sync Studio',              description: 'Sync any voice-over to a video clip with Wav2Lip', setupKey: 'MUAPI_API_KEY' },
          aiVoice:         { available: !!(settingValue(db,'ELEVENLABS_API_KEY') || (settingValue(db,'LLM_PROVIDER')==='openai' && llmReady)), label: 'AI Voiceover (TTS)', description: 'ElevenLabs or OpenAI TTS — type text, pick a voice, get instant audio', setupKey: 'ELEVENLABS_API_KEY' },
          translation:     { available: aiReady,     label: 'Caption Translation',           description: 'Translate captions to 10+ languages via LLM' },
          socialPosting:   { available: false,       label: 'Direct Social Posting',         description: 'Configure TikTok/Instagram OAuth credentials', setupKey: 'TIKTOK_CLIENT_ID' },
          digitalHuman:    { available: true,        label: 'AI Digital Human Studio',        description: 'Generate talking-head videos with lip sync, voice & captions (requires Digital Human Studio running on port 4200)', setupKey: 'DIGITAL_HUMAN_STUDIO_URL' }
        }
      });
    }
    if (pathname === '/api/onboarding' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      user.onboardingComplete = Boolean(body.complete);
      user.defaults = {
        captionStyle: body.captionStyle || user.defaults?.captionStyle || 'Bold captions',
        platforms: Array.isArray(body.platforms) ? body.platforms.filter(platform => PLATFORMS.includes(platform)) : user.defaults?.platforms || ['TikTok'],
        postMode: body.postMode || 'drafts'
      };
      saveDb(db);
      return json(res, 200, { user: publicUser(user) });
    }
    if (pathname === '/api/profile' && req.method === 'PATCH') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      user.name = body.name || user.name;
      user.defaults = {
        ...user.defaults,
        captionStyle: body.captionStyle || user.defaults?.captionStyle || 'Bold captions',
        platforms: Array.isArray(body.platforms) ? body.platforms.filter(platform => PLATFORMS.includes(platform)) : user.defaults?.platforms || []
      };
      user.notifications = {
        jobDone: body.jobDone !== false,
        weeklyReport: body.weeklyReport !== false
      };
      saveDb(db);
      return json(res, 200, { user: publicUser(user) });
    }
    if (pathname === '/api/billing/checkout' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const plan = db.billingPlans.find(item => item.id === body.planId);
      if (!plan) throw new Error('Plan not found.');
      if (!settingReady(db, 'STRIPE_SECRET_KEY')) {
        throw new Error('Stripe is not configured yet. Ask an admin to add STRIPE_SECRET_KEY in Admin API Configuration.');
      }
      return json(res, 200, { checkoutUrl: `${process.env.APP_BASE_URL || `http://${HOST}:${PORT}`}/checkout/${plan.id}?user=${user.id}` });
    }
    if (pathname === '/api/credits/purchase' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const amount = Number(body.amount || 0);
      if (![40, 120, 300].includes(amount)) throw new Error('Choose a valid credit pack.');
      if (!settingReady(db, 'STRIPE_SECRET_KEY')) throw new Error('Stripe checkout is not configured yet.');
      user.credits += amount;
      db.creditTransactions.unshift({ id: randomUUID(), userId: user.id, amount, reason: 'Credit purchase placeholder', createdAt: new Date().toISOString() });
      saveDb(db);
      return json(res, 200, { credits: user.credits });
    }
    if (pathname === '/api/billing/switch' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const plan = db.billingPlans.find(p => p.id === body.planId);
      if (!plan) throw new Error('Plan not found.');
      if (plan.monthlyPrice > 0) throw new Error('Paid plan upgrades require Stripe checkout.');
      const idx = db.users.findIndex(u => u.id === user.id);
      if (idx !== -1) {
        db.users[idx].plan = plan.id;
        db.users[idx].credits = Math.max(db.users[idx].credits || 0, plan.creditsIncluded);
      }
      saveDb(db);
      return json(res, 200, { plan: plan.id, credits: db.users[idx]?.credits });
    }
    if (pathname === '/api/credits/status') {
      const db = loadDb();
      const user = requireUser(req, db);
      const plan = db.billingPlans.find(p => p.id === user.plan) || db.billingPlans.find(p => p.id === (user.plan || '').toLowerCase()) || db.billingPlans[0];
      const txns = db.creditTransactions.filter(t => t.userId === user.id).slice(0, 5);
      return json(res, 200, { credits: user.credits, plan: plan.name, planId: plan.id, recent: txns });
    }
    if (pathname === '/api/process' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const video = requireVideoAccess(db, user, body.videoId);
      requireBrandKitAccess(db, user, body.brandKitId);
      // Check clip count warning for the user's plan
      const { plan } = subscriptionFor(db, user.id);
      const workflowMode = String(body.workflowMode || body.mode || 'viral').toLowerCase();
      const isSeriesRequest = workflowMode !== 'viral';
      const requestedClipCount = Math.max(1, Math.min(10, Number(body.clipCount || 3)));
      if (!isSeriesRequest && requestedClipCount > Number(plan.maxClipsPerVideo || 3)) {
        throw new Error(`Your ${plan.name} plan allows up to ${plan.maxClipsPerVideo} clips per video.`);
      }
      const maxPlanSeconds = Number(plan.maxVideoLength || 0) * 60;
      if (maxPlanSeconds > 0 && Number(video.durationSeconds || 0) > maxPlanSeconds) {
        throw new Error(`Your ${plan.name} plan allows videos up to ${plan.maxVideoLength} minutes. Upgrade or trim this source.`);
      }
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const completedThisMonth = db.jobs.filter(j =>
        j.userId === user.id && j.status === 'complete' &&
        j.updatedAt && j.updatedAt >= monthStart
      ).length;
      const planMonthlyLimit = (plan.maxClipsPerVideo || 3) * 10; // 10 videos worth per month as soft cap
      const atLimit = completedThisMonth >= planMonthlyLimit;
      const job = createQueuedProcessingJob({ ...body, userId: user.id });
      if (job.duplicate) return json(res, 202, { queued: true, duplicate: true, jobId: job.id, queueDepth: renderQueue.length, activeRenderJobs });
      const jobPromise = enqueueRenderJob({ ...body, userId: user.id, jobId: job.id });
      jobPromise.catch(error => console.error('[job:background-failed]', String(error.message || error).slice(0, 2000)));
      return json(res, 202, { queued: true, jobId: job.id, queueDepth: renderQueue.length, activeRenderJobs, warning: atLimit ? `You have processed ${completedThisMonth} jobs this month. Consider upgrading your plan for more capacity.` : null });
    }
    if (pathname === '/api/job' && req.method === 'PATCH') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const job = db.jobs.find(item => item.id === body.jobId);
      if (!job) throw new Error('Job not found.');
      if (job.userId !== user.id && user.role !== 'admin') throw Object.assign(new Error('You do not have access to this job.'), { status: 403 });
      if (body.action === 'delete') {
        killActiveJobProcesses(job.id);
        db.jobs = db.jobs.filter(item => item.id !== body.jobId);
        saveDb(db);
        return json(res, 200, { deleted: true });
      }
      if (body.action === 'cancel') {
        const killed = killActiveJobProcesses(job.id);
        job.status = 'failed';
        job.progress = 100;
        job.stage = 'cancelled';
        job.error = 'Job cancelled.';
        job.updatedAt = new Date().toISOString();
        saveDb(db);
        return json(res, 200, { cancelled: true, killed });
      }
      if (body.action === 'retry') {
        const video = db.videos.find(item => item.id === job.videoId);
        if (!video) throw new Error('Video not found for retry.');
        const retryPayload = {
          ...(job.payload || {}),
          videoId: video.id,
          userId: user.role === 'admin' ? (video.userId || video.createdBy || user.id) : user.id,
          rightsConfirmed: true,
          clipCount: body.clipCount || job.payload?.clipCount || 3,
          clipLength: body.clipLength || job.payload?.clipLength || 60,
        };
        db.jobs = db.jobs.filter(item => item.id !== body.jobId);
        saveDb(db);
        const queued = createQueuedProcessingJob(retryPayload);
        const retry = enqueueRenderJob({ ...retryPayload, userId: queued.userId, jobId: queued.id });
        retry.catch(error => console.error('[job:retry-failed]', String(error.message || error).slice(0, 2000)));
        return json(res, 202, { queued: true, jobId: queued.id, queueDepth: renderQueue.length, activeRenderJobs });
      }
      if (body.action === 'retry-series-part') {
        const part = db.seriesParts?.find(item => item.id === body.partId || (item.seriesId === body.seriesId && item.partNumber === Number(body.partNumber)));
        if (!part) throw new Error('Series part not found.');
        const series = db.seriesJobs?.find(item => item.id === part.seriesId);
        if (!series) throw new Error('Series not found.');
        if (user.role !== 'admin' && series.userId !== user.id) throw Object.assign(new Error('You do not have access to this series.'), { status: 403 });
        const video = db.videos.find(item => item.id === series.videoId);
        if (!video) throw new Error('Video not found for series retry.');
        part.status = 'queued';
        part.error = '';
        part.updatedAt = new Date().toISOString();
        const basePayload = job.payload || db.jobs.find(item => item.id === series.jobId)?.payload || {};
        saveDb(db);
        const queued = createQueuedProcessingJob({
          ...basePayload,
          videoId: video.id,
          userId: user.role === 'admin' ? (video.userId || video.createdBy || user.id) : user.id,
          rightsConfirmed: true,
          workflowMode: 'series',
          seriesId: series.id,
          partDuration: series.targetPartDuration || basePayload.partDuration || basePayload.clipLength || 90,
        });
        const retry = enqueueRenderJob({ ...(queued.payload || basePayload), videoId: video.id, userId: queued.userId, jobId: queued.id, rightsConfirmed: true, workflowMode: 'series', seriesId: series.id });
        retry.catch(error => console.error('[series:part-retry-failed]', String(error.message || error).slice(0, 2000)));
        return json(res, 202, { queued: true, jobId: queued.id, seriesId: series.id, partNumber: part.partNumber, queueDepth: renderQueue.length, activeRenderJobs });
      }
      if (body.action === 'regenerate-series-from') {
        const fromPart = db.seriesParts?.find(item => item.id === body.partId || (item.seriesId === body.seriesId && item.partNumber === Number(body.partNumber)));
        if (!fromPart) throw new Error('Series part not found.');
        const series = db.seriesJobs?.find(item => item.id === fromPart.seriesId);
        if (!series) throw new Error('Series not found.');
        if (user.role !== 'admin' && series.userId !== user.id) throw Object.assign(new Error('You do not have access to this series.'), { status: 403 });
        const video = db.videos.find(item => item.id === series.videoId);
        if (!video) throw new Error('Video not found for series regenerate.');
        const toRegenerate = db.seriesParts.filter(item => item.seriesId === series.id && item.partNumber >= fromPart.partNumber);
        killActiveJobProcesses(job.id);
        for (const part of toRegenerate) {
          part.status = 'queued';
          part.error = '';
          part.updatedAt = new Date().toISOString();
        }
        const basePayload = job.payload || db.jobs.find(item => item.id === series.jobId)?.payload || {};
        saveDb(db);
        const queued = createQueuedProcessingJob({
          ...basePayload,
          videoId: video.id,
          userId: user.role === 'admin' ? (video.userId || video.createdBy || user.id) : user.id,
          rightsConfirmed: true,
          workflowMode: 'series',
          seriesId: series.id,
          partDuration: series.targetPartDuration || basePayload.partDuration || basePayload.clipLength || 90,
        });
        const retry = enqueueRenderJob({ ...(queued.payload || basePayload), videoId: video.id, userId: queued.userId, jobId: queued.id, rightsConfirmed: true, workflowMode: 'series', seriesId: series.id });
        retry.catch(error => console.error('[series:regenerate-from-failed]', String(error.message || error).slice(0, 2000)));
        return json(res, 202, { queued: true, jobId: queued.id, seriesId: series.id, fromPartNumber: fromPart.partNumber, regeneratingParts: toRegenerate.length, queueDepth: renderQueue.length, activeRenderJobs });
      }
      if (body.action === 'cancel-series-remaining') {
        const series = db.seriesJobs?.find(item => item.id === body.seriesId);
        if (!series) throw new Error('Series not found.');
        if (user.role !== 'admin' && series.userId !== user.id) throw Object.assign(new Error('You do not have access to this series.'), { status: 403 });
        const killed = killActiveJobProcesses(job.id);
        const remaining = db.seriesParts.filter(item => item.seriesId === series.id && !['complete', 'cancelled'].includes(item.status));
        for (const part of remaining) {
          part.status = 'cancelled';
          part.error = 'Cancelled by user.';
          part.updatedAt = new Date().toISOString();
        }
        if (remaining.length) series.status = 'partial_failed';
        series.updatedAt = new Date().toISOString();
        if (['running', 'queued'].includes(job.status)) {
          job.status = 'failed';
          job.stage = 'cancelled';
          job.error = 'Remaining series parts cancelled by user.';
          job.updatedAt = new Date().toISOString();
        }
        saveDb(db);
        return json(res, 200, { cancelled: true, killed, cancelledParts: remaining.length });
      }
      throw new Error('Unsupported job action.');
    }
    if (pathname === '/api/video' && req.method === 'DELETE') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const video = db.videos.find(v => v.id === body.videoId);
      if (!video) throw new Error('Video not found.');
      // Only the video owner or an admin can delete
      if (user.role !== 'admin' && video.userId !== user.id && video.createdBy !== user.id) {
        throw Object.assign(new Error('You do not have permission to delete this video.'), { status: 403 });
      }
      const cleanup = cleanupVideoAssets(db, [video.id], cleanupResult('user-delete-video', 'video-delete'));
      recordStorageCleanupRun(db, cleanup);
      saveDb(db);
      return json(res, 200, { deleted: true, cleanup });
    }
    if (pathname === '/api/clip/download' && req.method === 'GET') {
      // Authenticated clip download — checks ownership before serving
      const clipId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('clipId');
      const db = loadDb();
      const user = requireUser(req, db);
      const clip = db.clips.find(c => c.id === clipId);
      if (!clip) return json(res, 404, { error: 'Clip not found.' });
      // Only the clip owner or an admin can download via this route
      if (user.role !== 'admin' && clip.userId !== user.id && clip.createdBy !== user.id) {
        // Also allow if the clip belongs to a video owned by the user
        const video = db.videos.find(v => v.id === clip.videoId);
        const videoOwnedByUser = video && (video.userId === user.id || video.createdBy === user.id);
        if (!videoOwnedByUser) {
          throw Object.assign(new Error('You do not have permission to download this clip.'), { status: 403 });
        }
      }
      if (!clip.outputPath) return json(res, 404, { error: 'Clip file path not found.' });
      const clipFile = path.join(STORAGE_DIR, 'clips', path.basename(clip.outputPath));
      if (!existsSync(clipFile)) return json(res, 404, { error: 'Clip file not found on disk.' });
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': statSync(clipFile).size,
        'content-disposition': `attachment; filename="${path.basename(clipFile)}"`,
        'cache-control': 'no-store'
      });
      return res.end(readFileSync(clipFile));
    }
    if (pathname === '/api/clip' && req.method === 'DELETE') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      if (body.all) {
        const userClips = db.clips.filter(c => c.userId === user.id || c.createdBy === user.id);
        const cleanup = cleanupClipAssets(db, userClips.map(clip => clip.id), cleanupResult('user-delete-all-clips', 'clip-delete'));
        recordStorageCleanupRun(db, cleanup);
        saveDb(db);
        return json(res, 200, { deleted: true, count: cleanup.clipsDeleted, cleanup });
      }
      const clip = db.clips.find(c => c.id === body.clipId && (c.userId === user.id || c.createdBy === user.id || user.role === 'admin'));
      if (!clip) throw new Error('Clip not found.');
      const cleanup = cleanupClipAssets(db, [clip.id], cleanupResult('user-delete-clip', 'clip-delete'));
      recordStorageCleanupRun(db, cleanup);
      saveDb(db);
      return json(res, 200, { deleted: true, cleanup });
    }
    if (pathname === '/api/clip' && req.method === 'PATCH') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const clip = db.clips.find(item => item.id === body.id && item.userId === user.id);
      if (!clip) throw new Error('Clip not found.');
      Object.assign(clip, {
        title: body.title ?? clip.title,
        hook: body.hook ?? clip.hook,
        postCaption: body.postCaption ?? clip.postCaption,
        hashtags: Array.isArray(body.hashtags) ? body.hashtags : clip.hashtags,
        postingAssistant: body.postingAssistant ?? clip.postingAssistant,
        transformation: body.transformation ?? clip.transformation ?? defaultTransformation(clip.title),
        postedAt: body.posted ? new Date().toISOString() : clip.postedAt
      });
      if (body.posted && clip.postingAssistant) clip.postingAssistant.posted = true;
      saveDb(db);
      return json(res, 200, clip);
    }
    if (pathname === '/api/schedule' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const clip = db.clips.find(item => item.id === body.clipId);
      if (!clip) throw new Error('Clip not found.');
      if (clip.userId !== user.id && user.role !== 'admin') throw Object.assign(new Error('You do not have access to this clip.'), { status: 403 });
      const platform = String(body.platform || '').trim();
      const scheduledFor = String(body.scheduledFor || '').trim();
      if (!PLATFORMS.includes(platform)) throw new Error('Choose a supported platform.');
      if (!scheduledFor) throw new Error('Choose a schedule date and time.');
      const account = db.socialAccounts.find(item => item.platform === platform && item.userId === user.id);
      if (!account) throw new Error(`Add a ${platform} posting account before scheduling.`);
      if (account.oauthStatus !== 'connected') throw new Error(`${platform} is not connected yet. Go to Social Accounts and connect OAuth before scheduling.`);
      const post = {
        id: randomUUID(),
        userId: user.id,
        clipId: clip.id,
        platform,
        accountId: account.id,
        scheduledFor,
        status: 'scheduled',
        caption: body.caption || clip.postCaption,
        createdAt: new Date().toISOString()
      };
      db.scheduledPosts.unshift(post);
      saveDb(db);
      return json(res, 200, post);
    }
    if (pathname === '/api/social-account' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const platform = String(body.platform || '').trim();
      const handle = String(body.handle || '').trim();
      if (!PLATFORMS.includes(platform)) throw new Error('Choose a supported platform.');
      if (!handle) throw new Error('Add the account handle or channel name.');
      const existing = db.socialAccounts.find(item => item.userId === user.id && item.platform === platform && item.handle.toLowerCase() === handle.toLowerCase());
      const account = existing || {
        id: randomUUID(),
        userId: user.id,
        platform,
        handle,
        status: 'saved',
        oauthStatus: 'not_connected',
        permissions: [],
        createdAt: new Date().toISOString()
      };
      account.handle = handle;
      account.updatedAt = new Date().toISOString();
      if (!existing) db.socialAccounts.unshift(account);
      saveDb(db);
      return json(res, 200, account);
    }
    if (pathname === '/api/social-account/test' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const account = db.socialAccounts.find(item => item.id === body.accountId);
      if (!account) throw new Error('Account not found.');
      if (account.userId !== user.id && user.role !== 'admin') throw Object.assign(new Error('You do not have access to this account.'), { status: 403 });
      if (account.oauthStatus !== 'connected') throw new Error('OAuth is not connected for this account.');
      return json(res, 200, { ok: true, message: `${account.platform} connection is healthy.` });
    }
    if (pathname === '/api/social-account/disconnect' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const account = db.socialAccounts.find(item => item.id === body.accountId);
      if (!account) throw new Error('Account not found.');
      if (account.userId !== user.id && user.role !== 'admin') throw Object.assign(new Error('You do not have access to this account.'), { status: 403 });
      account.oauthStatus = 'not_connected';
      account.status = 'saved';
      account.permissions = [];
      account.updatedAt = new Date().toISOString();
      saveDb(db);
      return json(res, 200, account);
    }
    if (pathname === '/api/post-now' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const clip = db.clips.find(item => item.id === body.clipId);
      const account = db.socialAccounts.find(item => item.id === body.accountId);
      if (!clip) throw new Error('Clip not found.');
      if (clip.userId !== user.id && user.role !== 'admin') throw Object.assign(new Error('You do not have access to this clip.'), { status: 403 });
      if (!account) throw new Error('Posting account not found.');
      if (account.userId !== user.id && user.role !== 'admin') throw Object.assign(new Error('You do not have access to this account.'), { status: 403 });
      if (account.oauthStatus !== 'connected') throw new Error(`${account.platform} is not connected.`);
      throw new Error(`Real ${account.platform} auto-posting needs approved OAuth credentials. The app saved the account and clip; connect the platform developer app before posting.`);
    }
    if (pathname === '/api/admin/overview') {
      const db = loadDb();
      requireAdmin(req, db);
      return json(res, 200, {
        metrics: adminMetrics(db),
        apiHealth: {
          youtube: settingReady(db, 'YOUTUBE_API_KEY'),
          llm: settingReady(db, 'LLM_API_KEY'),
          stripe: settingReady(db, 'STRIPE_SECRET_KEY'),
          tiktok: settingReady(db, 'TIKTOK_CLIENT_ID') && settingReady(db, 'TIKTOK_CLIENT_SECRET'),
          meta: settingReady(db, 'META_APP_ID') && settingReady(db, 'META_APP_SECRET'),
          youtubeUpload: settingReady(db, 'YOUTUBE_CLIENT_ID') && settingReady(db, 'YOUTUBE_CLIENT_SECRET'),
          x: settingReady(db, 'X_CLIENT_ID') && settingReady(db, 'X_CLIENT_SECRET'),
          storage: settingReady(db, 'S3_BUCKET') && settingReady(db, 'S3_ACCESS_KEY_ID'),
          queue: settingReady(db, 'REDIS_URL')
        }
      });
    }
    if (pathname === '/api/admin/bank') {
      const db = loadDb();
      requireAdmin(req, db);
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const account = db.bankAccounts[0] || { id: randomUUID(), active: true };
        Object.assign(account, {
          bankName: body.bankName || account.bankName,
          accountName: body.accountName || account.accountName,
          accountNumber: body.accountNumber || account.accountNumber,
          instructions: body.instructions || account.instructions,
          active: true,
          updatedAt: new Date().toISOString()
        });
        db.bankAccounts[0] = account;
        saveDb(db);
      }
      return json(res, 200, { bankAccount: db.bankAccounts[0], paymentRequests: db.paymentRequests });
    }
    if (pathname === '/api/admin/ai-settings') {
      const db = loadDb();
      requireAdmin(req, db);
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const allowed = ['LLM_PROVIDER', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_FALLBACK_PROVIDER', 'LLM_FALLBACK_API_KEY', 'LLM_FALLBACK_BASE_URL', 'LLM_FALLBACK_MODEL'];
        for (const key of allowed) {
          if (!(key in body)) continue;
          const setting = db.apiSettings.find(item => item.key === key);
          if (setting) {
            setting.value = String(body[key] || '').trim();
            setting.updatedAt = new Date().toISOString();
          }
        }
        saveDb(db);
      }
      const config = aiConfig(db, false);
      const fallbackConfig = aiConfig(db, true);
      return json(res, 200, {
        settings: {
          provider: settingValue(db, 'LLM_PROVIDER') || 'emergent',
          model: settingValue(db, 'LLM_MODEL') || 'gpt-4o-mini',
          baseUrl: settingValue(db, 'LLM_BASE_URL'),
          apiKeyConfigured: Boolean(settingValue(db, 'LLM_API_KEY')),
          effectiveBaseUrl: config.baseUrl,
          candidateRoutes: aiEndpointCandidates(config),
          fallbackProvider: settingValue(db, 'LLM_FALLBACK_PROVIDER'),
          fallbackModel: settingValue(db, 'LLM_FALLBACK_MODEL'),
          fallbackBaseUrl: settingValue(db, 'LLM_FALLBACK_BASE_URL'),
          fallbackApiKeyConfigured: Boolean(settingValue(db, 'LLM_FALLBACK_API_KEY')),
          effectiveFallbackBaseUrl: fallbackConfig.baseUrl
        },
        logs: (db.aiLogs || []).slice(0, 20)
      });
    }
    if (pathname === '/api/admin/ai-test' && req.method === 'POST') {
      const db = loadDb();
      requireAdmin(req, db);
      const result = await testAiConnection(db);
      return json(res, 200, result);
    }
    // ── Gemini-specific test endpoint ──
    if (pathname === '/api/admin/gemini-test' && req.method === 'POST') {
      const db = loadDb();
      requireAdmin(req, db);
      const body = await readJson(req).catch(() => ({}));
      const apiKey = body.apiKey || settingValue(db, 'GEMINI_API_KEY');
      if (!apiKey) throw new Error('GEMINI_API_KEY is not configured. Get a free key at aistudio.google.com/app/apikey');
      const model = body.model || geminiModel(db);
      console.log(`[Gemini] connection test — model: ${model}, provider: gemini`);
      try {
        const { text, usage, model: usedModel } = await geminiGenerateText({
          apiKey,
          prompt: 'Reply with OK',
          systemPrompt: 'You are a connectivity test. Reply with just the word OK.',
          model,
          temperature: 0,
        });
        recordAiLog({ provider: 'gemini', model: usedModel, purpose: 'gemini connection test', ok: true, ...usage });
        console.log(`[Gemini] test OK — used model: ${usedModel}`);
        return json(res, 200, {
          ok: true, provider: 'gemini', model: usedModel, requestedModel: model,
          usage, reply: text.slice(0, 200),
          features: ['viral-detection', 'video-analysis', 'hooks', 'titles', 'hashtags', 'thumbnail-ideas', 'broll-suggestions', 'qa-review', 'transcription-fallback'],
        });
      } catch (err) {
        const q429 = parseGemini429(err);
        const message = q429
          ? `Quota exceeded on all Gemini models — retry after ${Math.ceil(q429.retryMs / 1000)}s. Try again later or add a fallback LLM key.`
          : err.message;
        console.error(`[Gemini] test FAILED — model: ${model} — ${message}`);
        recordAiLog({ provider: 'gemini', model, purpose: 'gemini connection test', ok: false, error: message });
        return json(res, 200, {
          ok: false, provider: 'gemini', model,
          error: message,
          isQuota: Boolean(q429),
          retryAfterSeconds: q429 ? Math.ceil(q429.retryMs / 1000) : null,
        });
      }
    }
    if (pathname === '/api/admin/payments') {
      const db = loadDb();
      requireAdmin(req, db);
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const payment = db.paymentRequests.find(item => item.id === body.paymentId);
        if (!payment) throw new Error('Payment request not found.');
        if (!['approved', 'rejected'].includes(body.status)) throw new Error('Use approved or rejected.');
        payment.status = body.status;
        payment.adminNote = body.adminNote || '';
        payment.updatedAt = new Date().toISOString();
        if (body.status === 'approved' && !payment.creditedAt) {
          const user = db.users.find(item => item.id === payment.userId);
          if (!user) throw new Error('Payment user not found.');
          user.credits += payment.credits;
          payment.creditedAt = new Date().toISOString();
          db.creditTransactions.unshift({
            id: randomUUID(),
            userId: user.id,
            amount: payment.credits,
            reason: `Bank transfer verified: ${payment.reference}`,
            createdAt: new Date().toISOString()
          });
        }
        saveDb(db);
      }
      return json(res, 200, { paymentRequests: db.paymentRequests, users: db.users.map(publicUser) });
    }
    if (pathname === '/api/admin/llm/verify' && req.method === 'POST') {
      const db = loadDb();
      requireAdmin(req, db);
      const body = await readJson(req);
      const provider = body.provider || settingValue(db, 'LLM_PROVIDER') || 'xai';
      const model    = body.model    || settingValue(db, 'LLM_MODEL') || 'grok-3-mini';

      // ── Gemini: use native SDK path, not OpenAI-compat ──────────────────────
      if (provider === 'gemini') {
        const geminiKey = body.apiKey || settingValue(db, 'GEMINI_API_KEY');
        const geminiMdl = body.model  || geminiModel(db);
        if (!geminiKey) return json(res, 400, { ok: false, error: 'No Gemini API key. Add it in Admin → Gemini AI section, or paste it here.' });
        console.log(`[Gemini] LLM verify — model: ${geminiMdl}`);
        const t0 = Date.now();
        try {
          const { text, model: usedModel } = await geminiGenerateText({
            apiKey: geminiKey, prompt: 'Reply with OK', model: geminiMdl, temperature: 0,
          });
          return json(res, 200, { ok: true, reply: text.trim(), model: usedModel, ms: Date.now() - t0, provider: 'gemini' });
        } catch (err) {
          const q429 = parseGemini429(err);
          const message = q429
            ? `Quota exceeded — retry after ${Math.ceil(q429.retryMs / 1000)}s. Your free tier limit for all models is exhausted. Wait or check aistudio.google.com/app/apikey for usage.`
            : err.message;
          return json(res, 200, { ok: false, error: message, isQuota: Boolean(q429), ms: Date.now() - t0, provider: 'gemini' });
        }
      }

      // ── OpenAI-compatible providers ──────────────────────────────────────────
      const apiKey = body.apiKey || settingValue(db, 'LLM_API_KEY');
      if (!apiKey) return json(res, 400, { ok: false, error: 'No API key provided.' });
      const customBase = body.baseUrl || settingValue(db, 'LLM_BASE_URL');
      const providerBases = {
        xai: 'https://api.x.ai/v1', grok: 'https://api.x.ai/v1',
        openai: 'https://api.openai.com/v1', groq: 'https://api.groq.com/openai/v1',
        together: 'https://api.together.xyz/v1', emergent: 'https://api.emergent.sh/v1',
      };
      const base = (customBase || providerBases[provider] || '').replace(/\/+$/, '');
      if (!base) return json(res, 400, { ok: false, error: `Unknown provider "${provider}". Set a custom base URL.` });
      const endpoint = `${base}/chat/completions`;
      const t0 = Date.now();
      try {
        const testRes = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: working' }], max_tokens: 10, temperature: 0 }),
          signal: AbortSignal.timeout(20000)
        });
        const data = await testRes.json().catch(() => ({}));
        const ms = Date.now() - t0;
        if (!testRes.ok) return json(res, 200, { ok: false, error: data.error?.message || data.error || `HTTP ${testRes.status}`, status: testRes.status, ms });
        const reply = data.choices?.[0]?.message?.content?.trim() || '';
        return json(res, 200, { ok: true, reply, model: data.model || model, ms, provider, endpoint });
      } catch (err) {
        return json(res, 200, { ok: false, error: String(err.message || err), ms: Date.now() - t0 });
      }
    }
    if (pathname === '/api/admin/settings') {
      const db = loadDb();
      requireAdmin(req, db);
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        for (const [key, value] of Object.entries(body.settings || {})) {
          const setting = db.apiSettings.find(item => item.key === key);
          if (setting) {
            setting.value = String(value || '');
            setting.updatedAt = new Date().toISOString();
          }
        }
        saveDb(db);
      }
      return json(res, 200, { settings: db.apiSettings.map(item => ({ ...item, configured: Boolean(item.value || process.env[item.key]), value: item.value ? '••••••••' : '' })) });
    }
    if (pathname === '/api/admin/youtube-cookies') {
      const db = loadDb();
      const admin = requireAdmin(req, db);
      if (req.method === 'PUT' || req.method === 'PATCH') {
        const body = await readJson(req);
        const cookies = String(body.cookies || '').trim();
        if (!cookies) throw Object.assign(new Error('Paste the exported cookies.txt contents.'), { status: 400 });
        if (cookies.length > 200 * 1024) throw Object.assign(new Error('Cookie file is too large (max 200KB).'), { status: 400 });
        if (!/youtube\.com|\.google\.com/i.test(cookies)) {
          throw Object.assign(new Error('That does not look like a YouTube/Google cookies.txt export (Netscape format).'), { status: 400 });
        }
        const tmpPath = `${YTDLP_COOKIES_PATH}.tmp-${randomUUID()}`;
        writeFileSync(tmpPath, cookies.endsWith('\n') ? cookies : `${cookies}\n`, { mode: 0o600 });
        renameSync(tmpPath, YTDLP_COOKIES_PATH);
        importLog('log', 'YouTube cookies updated by admin', { adminId: admin.id, bytes: cookies.length });
      } else if (req.method === 'DELETE') {
        if (existsSync(YTDLP_COOKIES_PATH)) unlinkSync(YTDLP_COOKIES_PATH);
        importLog('log', 'YouTube cookies removed by admin', {});
      }
      const stats = existsSync(YTDLP_COOKIES_PATH) ? statSync(YTDLP_COOKIES_PATH) : null;
      return json(res, 200, {
        configured: Boolean(stats),
        updatedAt: stats ? stats.mtime.toISOString() : null,
        sizeBytes: stats ? stats.size : 0
      });
    }
    if (pathname === '/api/admin/storage-cleanup') {
      const db = loadDb();
      const admin = requireAdmin(req, db);
      if (req.method === 'GET') {
        return json(res, 200, { stats: videoStorageStats(db), recent: (db.storageCleanupRuns || []).slice(0, 10) });
      }
      if (req.method !== 'POST') throw Object.assign(new Error('Unsupported method.'), { status: 405 });
      const body = await readJson(req);
      let result;
      if (body.action === 'run-retention') {
        result = runStorageRetentionCleanup({
          reason: `admin-retention:${admin.id}`,
          retentionDays: normalizeRetentionDays(body.retentionDays),
        });
      } else if (body.action === 'delete-all-video-assets') {
        if (body.confirm !== 'DELETE VIDEO FILES') {
          throw Object.assign(new Error('Type DELETE VIDEO FILES to confirm video asset deletion.'), { status: 400 });
        }
        result = deleteAllVideoAssetsForAdmin({ reason: `admin-delete-all:${admin.id}` });
      } else {
        throw new Error('Unsupported storage cleanup action.');
      }
      importLog('warn', 'Admin storage cleanup completed', {
        adminId: admin.id,
        action: body.action,
        filesDeleted: result.filesDeleted,
        bytesFreed: result.bytesFreed,
        videosDeleted: result.videosDeleted,
        clipsDeleted: result.clipsDeleted,
      });
      return json(res, 200, { result, stats: videoStorageStats() });
    }
    if (pathname === '/api/admin/plans') {
      const db = loadDb();
      requireAdmin(req, db);
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const plan = db.billingPlans.find(item => item.id === body.id);
        if (!plan) throw new Error('Plan not found.');
        Object.assign(plan, {
          name: body.name ?? plan.name,
          monthlyPrice: Number(body.monthlyPrice ?? plan.monthlyPrice),
          creditsIncluded: Number(body.creditsIncluded ?? plan.creditsIncluded),
          maxVideoLength: Number(body.maxVideoLength ?? plan.maxVideoLength),
          maxClipsPerVideo: Number(body.maxClipsPerVideo ?? plan.maxClipsPerVideo),
          autoWatchAllowed: Boolean(body.autoWatchAllowed),
          autoPostAllowed: Boolean(body.autoPostAllowed)
        });
        saveDb(db);
      }
      return json(res, 200, { plans: db.billingPlans });
    }
    if (pathname === '/api/admin/users') {
      const db = loadDb();
      requireAdmin(req, db);
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const user = db.users.find(item => item.id === body.userId);
        if (!user) throw new Error('User not found.');
        if (body.plan) user.plan = body.plan;
        if (Number.isFinite(Number(body.creditDelta))) {
          const amount = Number(body.creditDelta);
          user.credits += amount;
          db.creditTransactions.unshift({ id: randomUUID(), userId: user.id, amount, reason: 'Admin adjustment', createdAt: new Date().toISOString() });
        }
        if (body.suspended !== undefined) user.suspended = Boolean(body.suspended);
        saveDb(db);
      }
      return json(res, 200, { users: db.users.map(publicUser), subscriptions: db.subscriptions, creditTransactions: db.creditTransactions });
    }
    if (pathname === '/api/admin/jobs') {
      const db = loadDb();
      requireAdmin(req, db);
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const job = db.jobs.find(item => item.id === body.jobId);
        if (!job) throw new Error('Job not found.');
        if (body.action === 'retry') {
          const video = db.videos.find(item => item.id === job.videoId);
          if (!video) throw new Error('Video not found for retry.');
          job.status = 'queued';
          job.progress = 0;
          job.stage = 'queued for retry';
          job.error = '';
          job.updatedAt = new Date().toISOString();
          saveDb(db);
          const retry = enqueueRenderJob({
            videoId: video.id,
            userId: video.userId || video.createdBy || job.userId,
            jobId: job.id,
            rightsConfirmed: true,
            clipCount: body.clipCount || 3,
            clipLength: body.clipLength || 60
          });
          retry.catch(error => console.error('[admin-job:retry-failed]', String(error.message || error).slice(0, 2000)));
          return json(res, 202, { queued: true, jobId: job.id, queueDepth: renderQueue.length, activeRenderJobs });
        }
        if (body.action === 'delete') db.jobs = db.jobs.filter(item => item.id !== body.jobId);
        saveDb(db);
      }
      return json(res, 200, { jobs: db.jobs });
    }
    // ── Full Series timeline debugger ───────────────────────────────
    // Surfaces the shared transcript + committed plan boundaries for a series job so a
    // bad cut can be diagnosed: which rule chose each boundary, whether the timeline has
    // gaps/overlaps, and (when the source file hasn't been cleaned up yet) sample frames
    // and a waveform image right at each boundary.
    if (pathname === '/api/admin/series-timeline' && req.method === 'GET') {
      const db = loadDb();
      requireAdmin(req, db);
      const seriesId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('seriesId');
      const series = seriesId
        ? db.seriesJobs.find(item => item.id === seriesId)
        : null;
      if (seriesId && !series) throw new Error('Series not found.');
      if (!seriesId) {
        return json(res, 200, {
          seriesJobs: (db.seriesJobs || []).map(s => ({
            ...s,
            videoTitle: db.videos.find(v => v.id === s.videoId)?.title || 'Untitled video',
          })),
        });
      }
      const video = db.videos.find(item => item.id === series.videoId);
      const parts = (db.seriesParts || [])
        .filter(item => item.seriesId === seriesId)
        .sort((a, b) => a.partNumber - b.partNumber);
      const transcript = (db.transcriptions || []).find(item => item.videoId === series.videoId);
      const boundaries = candidateBoundariesFromTranscript(transcript?.segments || []);
      const validation = validateSeriesPlan(parts, 0, Number(video?.durationSeconds || 0), minPartDuration(series.targetPartDuration || 90, 15));
      const sourceAvailable = Boolean(video?.storagePath && existsSync(video.storagePath));
      return json(res, 200, {
        series,
        video: video ? { id: video.id, title: video.title, durationSeconds: video.durationSeconds, sourceAvailable } : null,
        parts,
        transcriptBoundaryCount: boundaries.length,
        validation,
      });
    }
    if (pathname === '/api/admin/series-timeline-frames' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      requireAdmin(req, db);
      const series = db.seriesJobs.find(item => item.id === body.seriesId);
      if (!series) throw new Error('Series not found.');
      const video = db.videos.find(item => item.id === series.videoId);
      if (!video) throw new Error('Video not found.');
      if (!video.storagePath || !existsSync(video.storagePath)) {
        return json(res, 200, { available: false, reason: 'Source file has been cleaned up after processing — frames can only be generated while the series is still active or recently failed.' });
      }
      const parts = (db.seriesParts || []).filter(item => item.seriesId === series.id).sort((a, b) => a.partNumber - b.partNumber);
      const boundaryTimes = [0, ...parts.map(p => p.sourceEnd)].filter((t, i, a) => a.indexOf(t) === i);
      const debugDir = path.join(STORAGE_DIR, 'thumbs');
      const frames = [];
      for (const t of boundaryTimes.slice(0, 12)) {
        const frameFile = `debug_${series.id}_${Math.round(t * 100)}.jpg`;
        const framePath = path.join(debugDir, frameFile);
        try {
          await run(FFMPEG, ['-y', '-ss', String(Math.max(0, t - 0.05)), '-i', video.storagePath, '-frames:v', '1', '-vf', 'scale=240:-1', '-q:v', '4', framePath], { timeoutMs: 15_000, label: 'debug-frame' });
          if (existsSync(framePath)) frames.push({ t, url: `/media/thumbs/${frameFile}` });
        } catch {}
      }
      const waveFile = `debug_wave_${series.id}.png`;
      const wavePath = path.join(debugDir, waveFile);
      let waveformUrl = null;
      try {
        await run(FFMPEG, ['-y', '-i', video.storagePath, '-filter_complex', 'showwavespic=s=1600x180:colors=#7c8cff', '-frames:v', '1', wavePath], { timeoutMs: 30_000, label: 'debug-waveform' });
        if (existsSync(wavePath)) waveformUrl = `/media/thumbs/${waveFile}`;
      } catch {}
      return json(res, 200, { available: true, frames, waveformUrl, boundaryTimes });
    }
    // ── Brand Kits ────────────────────────────────────────────────
    if (pathname === '/api/brand-kits' && req.method === 'GET') {
      const db = loadDb();
      const user = requireUser(req, db);
      return json(res, 200, { brandKits: db.brandKits.filter(bk => bk.userId === user.id) });
    }
    if (pathname === '/api/brand-kit' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const kit = {
        id: `bk_${randomUUID().replace(/-/g,'')}`,
        userId: user.id,
        name: String(body.name || 'My Brand').slice(0, 80),
        textWatermark: String(body.textWatermark || '').slice(0, 60),
        textStyle: ['auto','clean','bold','minimal','pill','outlined'].includes(body.textStyle) ? body.textStyle : 'auto',
        logoStoredName: null,
        logoUrl: null,
        logoPosition: body.logoPosition || 'top-left',
        logoSize: body.logoSize || 'medium',
        logoSizePercent: Number(body.logoSizePercent || 12),
        logoOpacity: Math.min(1, Math.max(0.1, Number(body.logoOpacity ?? 0.9))),
        logoBg: Boolean(body.logoBg),
        watermarkEnabled: body.watermarkEnabled !== false,
        captionStyle: body.captionStyle || 'bold',
        exportFormat: body.exportFormat || 'tiktok',
        primaryColor: body.primaryColor || '#FFFFFF',
        highlightColor: body.highlightColor || '#FFD700',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.brandKits.push(kit);
      saveDb(db);
      return json(res, 201, kit);
    }
    if (pathname === '/api/brand-kit' && req.method === 'PUT') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const kit = db.brandKits.find(bk => bk.id === body.id && bk.userId === user.id);
      if (!kit) throw Object.assign(new Error('Brand kit not found.'), { status: 404 });
      const editable = ['name','textWatermark','textStyle','logoPosition','logoSize','logoSizePercent','logoOpacity',
                        'logoBg','watermarkEnabled','captionStyle','exportFormat','primaryColor','highlightColor'];
      for (const k of editable) { if (k in body) kit[k] = body[k]; }
      kit.updatedAt = new Date().toISOString();
      saveDb(db);
      return json(res, 200, kit);
    }
    if (pathname === '/api/brand-kit' && req.method === 'DELETE') {
      const body = await readJson(req);
      const db = loadDb();
      const user = requireUser(req, db);
      const kit = db.brandKits.find(bk => bk.id === body.id && bk.userId === user.id);
      if (!kit) throw Object.assign(new Error('Brand kit not found.'), { status: 404 });
      if (kit.logoStoredName) unlinkQuiet(path.join(STORAGE_DIR, 'logos', kit.logoStoredName));
      db.brandKits = db.brandKits.filter(bk => bk.id !== body.id);
      saveDb(db);
      return json(res, 200, { deleted: true });
    }
    if (pathname === '/api/brand-kit/logo' && req.method === 'POST') {
      const db = loadDb();
      const user = requireUser(req, db);
      const { fields, upload } = await streamUploadedLogo(req);
      const kit = db.brandKits.find(bk => bk.id === fields.brandKitId && bk.userId === user.id);
      if (!kit) {
        unlinkQuiet(upload.logoPath);
        throw Object.assign(new Error('Brand kit not found.'), { status: 404 });
      }
      // Remove old logo file if any
      if (kit.logoStoredName) unlinkQuiet(path.join(STORAGE_DIR, 'logos', kit.logoStoredName));
      kit.logoStoredName = upload.storedName;
      kit.logoUrl = upload.url;
      kit.updatedAt = new Date().toISOString();
      saveDb(db);
      return json(res, 200, { logoUrl: upload.url, kit });
    }

    if (pathname === '/api/health') {
      const db = loadDb();
      const ytdlpCommand = await workingYtDlpCommand();
      const ytdlpStatus = ytdlpCommand ? await commandVersion(ytdlpCommand) : { ok: false, version: '', error: `Tried: ${ytdlpCandidates().join(', ')}` };
      const ffmpegStatus = await commandVersion(FFMPEG);
      const llmReady = settingReady(db, 'LLM_API_KEY');
      const geminiReady = settingReady(db, 'GEMINI_API_KEY');
      const youtubeReady = settingReady(db, 'YOUTUBE_API_KEY');
      const aiReady = llmReady || geminiReady;
      const allReady = ytdlpStatus.ok && ffmpegStatus.ok && aiReady;
      return json(res, 200, {
        status: allReady ? 'ready' : 'degraded',
        tools: {
          ffmpeg: { ok: ffmpegStatus.ok, version: ffmpegStatus.version, error: ffmpegStatus.error || '' },
          ytdlp: { ok: ytdlpStatus.ok, version: ytdlpStatus.version, command: ytdlpCommand || '', error: ytdlpStatus.error || '' },
          llm: { ok: llmReady },
          gemini: { ok: geminiReady },
          youtube_api: { ok: youtubeReady },
          upload: { ok: true, note: 'File upload always available as primary workflow' }
        },
        memory: memorySnapshot(),
        queue: { depth: renderQueue.length, active: activeRenderJobs }
      });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const httpStatus = error.status || 400;
    return json(res, httpStatus, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  if (url.pathname.startsWith('/media/')) {
    const file = path.normalize(path.join(STORAGE_DIR, url.pathname.replace('/media/', '')));
    if (!file.startsWith(STORAGE_DIR) || !existsSync(file)) return json(res, 404, { error: 'Media not found' });
    const db = loadDb();
    const user = currentUser(req, db);
    if (!user) return json(res, 401, { error: 'Authentication required.' });
    const relative = url.pathname.replace('/media/', '');
    if (!userCanAccessMedia(user, relative, db)) return json(res, 403, { error: 'You do not have access to this media.' });
    res.writeHead(200, { 'content-type': mimeFor(file), 'content-length': statSync(file).size });
    return res.end(readFileSync(file));
  }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
    const fallback = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(fallback));
  }
  const isJs = file.endsWith('.js') || file.endsWith('.css');
  res.writeHead(200, {
    'content-type': mimeFor(file),
    'cache-control': isJs ? 'no-store, must-revalidate' : 'public, max-age=86400',
  });
  res.end(readFileSync(file));
});

async function pollDueWatchedChannels() {
  const db = loadDb();
  const now = Date.now();
  const intervalMs = Number(process.env.WATCH_INTERVAL_MINUTES || 15) * 60 * 1000;
  const due = db.watchedChannels.filter(watch => {
    if (watch.status !== 'active') return false;
    if (!watch.lastCheckedAt) return true;
    return now - new Date(watch.lastCheckedAt).getTime() >= intervalMs;
  });
  for (const watch of due) {
    pollWatchedChannel(watch.id).catch(() => {});
  }
}

function runStorageRetentionCleanupSafe(reason = 'interval') {
  try {
    const result = runStorageRetentionCleanup({ reason, retentionDays: STORAGE_RETENTION_DAYS });
    if (result.filesDeleted || result.videosDeleted || result.clipsDeleted || result.errors.length) {
      console.error('[storage-cleanup]', {
        reason,
        retentionDays: result.retentionDays,
        filesDeleted: result.filesDeleted,
        bytesFreed: result.bytesFreed,
        videosDeleted: result.videosDeleted,
        clipsDeleted: result.clipsDeleted,
        errors: result.errors.length,
      });
    }
    return result;
  } catch (error) {
    console.error('[storage-cleanup:failed]', { reason, error: String(error.message || error).slice(0, 800) });
    return null;
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule && process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, async () => {
    console.log(`ClipForge AI running at http://${HOST}:${PORT}`);
    await verifyMediaBinaries();
    recoverStaleJobs('startup');
    recoverQueuedSeriesJobs('startup');
    runStorageRetentionCleanupSafe('startup');
    logMemory('startup');
    pollDueWatchedChannels().catch(() => {});
    setInterval(() => pollDueWatchedChannels().catch(() => {}), Number(process.env.WATCH_INTERVAL_MINUTES || 15) * 60 * 1000);
    setInterval(() => logMemory('heartbeat'), Number(process.env.MEMORY_LOG_INTERVAL_MS || 60_000));
    setInterval(() => recoverStaleJobs('interval'), 60_000);
    setInterval(() => runStorageRetentionCleanupSafe('interval'), STORAGE_CLEANUP_INTERVAL_MS);
  });
}

export {
  buildASSFile,
  buildLogoOverlay,
  buildPortraitFilter,
  buildTargetDurations,
  buildFullSeriesMoments,
  cleanupClipAssets,
  cleanupResult,
  cleanupVideoAssets,
  chooseBestDownloadedMedia,
  clipCaptionWordsToRenderWindow,
  deoverlapCaptionSegments,
  parseYouTubeJson3,
  assessCaptionSync,
  estimateWordTimings,
  isProxyReachable,
  fallbackMomentsForVideo,
  buildTranscriptReference,
  FINAL_AUDIO_MISSING,
  FINAL_AUDIO_SILENT,
  FINAL_AUDIO_VALID,
  CAPTION_ALIGNMENT_LOW_CONFIDENCE,
  CAPTION_SYNC_DRIFT_DETECTED,
  CAPTION_SYNC_OFFSET_DETECTED,
  CAPTION_SYNC_VALID,
  STALE_CAPTION_DATA,
  WORD_TIMESTAMPS_MISSING,
  isEffectivelySilent,
  momentsAreDiverse,
  overlapRatio,
  parseFrameRate,
  parseVolumeStats,
  postProcessMoments,
  resolveManagedDeletionPath,
  resolveMediaDurationSeconds,
  runStorageRetentionCleanup,
  sanitizeApiPayload,
  SOURCE_AUDIO_EXTRACTION_FAILED,
  SOURCE_AUDIO_PRESENT,
  SOURCE_HAS_NO_AUDIO,
  upsertSeriesPlan,
  userCanAccessMedia,
  videoStorageStats,
  chooseNaturalBoundary,
  minPartDuration,
  momentsFromPersistedSeriesPlan,
  validateClipRender,
  validateSeriesPlan,
};
