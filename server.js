import http from 'node:http';
import { createHash, createHmac, randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STORAGE_DIR = path.join(__dirname, 'storage');
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const CREDITS_ENABLED = process.env.CREDITS_ENABLED !== 'false';
const CLIP_JOB_CREDIT_COST = Number(process.env.CLIP_JOB_CREDIT_COST || 5);
const MIN_CLIP_SOURCE_SECONDS = Number(process.env.MIN_CLIP_SOURCE_SECONDS || 15);
const IMPORT_RATE_LIMIT_MS = Number(process.env.IMPORT_RATE_LIMIT_MS || 8000);
const YTDLP_BLOCK_COOLDOWN_MS = Number(process.env.YTDLP_BLOCK_COOLDOWN_MS || 15 * 60 * 1000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 300 * 1024 * 1024);
const MAX_CONCURRENT_RENDER_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_RENDER_JOBS || 1));
const PROCESS_TIMEOUT_MS = Number(process.env.PROCESS_TIMEOUT_MS || 10 * 60 * 1000);
const JOB_STALE_MS = Number(process.env.JOB_STALE_MS || 12 * 60 * 1000);
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45 * 1000);
const MAX_RSS_MB = Number(process.env.MAX_RSS_MB || 420);
const RENDER_WIDTH = Number(process.env.RENDER_WIDTH || 720);
const RENDER_HEIGHT = Number(process.env.RENDER_HEIGHT || 1280);
const importAttempts = new Map();
const importUserAttempts = new Map(); // userId → [timestamps] for rate-limiting by user
const ytdlpBlock = { until: 0, reason: '' };
let activeRenderJobs = 0;
const renderQueue = [];
const activeJobProcesses = new Map();

mkdirSync(DATA_DIR, { recursive: true });
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
  studioGenerations: []
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
  const body = JSON.stringify(payload);
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
    // A running job that has been running for > 30 minutes is definitely stuck
    const isStaleByRuntime = job.status === 'running' && now - startedAt > JOB_RUNNING_MAX_MS;
    // A job created longer ago than PROCESS_TIMEOUT_MS + JOB_STALE_MS with no activity
    const isStaleByCreation = now - created > PROCESS_TIMEOUT_MS + JOB_STALE_MS;
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
  return args;
}

async function commandVersion(command) {
  try {
    const { stdout, stderr } = await run(command, command === FFMPEG ? ['-version'] : ['--version']);
    return { ok: true, version: (stdout || stderr).split(/\r?\n/)[0] || 'installed' };
  } catch (error) {
    return { ok: false, version: '', error: error.message };
  }
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
  if (/YouTube blocked server download/i.test(text)) return 'YouTube blocked server download. Upload the video file instead.';
  if (ytDlpBlockedByYouTube(text)) return 'YouTube blocked server download. Upload the video file instead.';
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
  const args = [...(await ytDlpBaseArgs()), '--dump-single-json', '--skip-download', '--no-warnings', '--ignore-no-formats-error', '--playlist-end', '12', source];
  importLog('log', 'yt-dlp metadata fallback started', { source, command: ytdlpCommand });
  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await run(ytdlpCommand, args));
  } catch (error) {
    rememberYtDlpBlock(error);
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

function unlinkQuiet(filePath) {
  try {
    if (filePath && existsSync(filePath)) unlinkSync(filePath);
  } catch {}
}

// ─── Gemini transcription fallback (no Whisper key needed) ───────────────────
async function transcribeWithGemini(db, mediaPath, videoId, geminiKey) {
  const audioPath = path.join(STORAGE_DIR, 'originals', `${videoId}_audio.mp3`);
  try {
    await run(FFMPEG, ['-y', '-i', mediaPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '96k', '-t', '600', audioPath],
      { timeoutMs: 3 * 60 * 1000, label: 'extract audio for gemini transcription' });
    if (!existsSync(audioPath) || statSync(audioPath).size < 512) return [];

    const text = await geminiTranscribeFile(geminiKey, audioPath, 'audio/mpeg');
    if (!text || text.length < 10) return [];

    // Split into ~4-second segments (no word timing available from Gemini transcript)
    const words = text.split(/\s+/).filter(Boolean);
    const WORDS_PER_SEG = 12;
    const segs = [];
    for (let i = 0; i < words.length; i += WORDS_PER_SEG) {
      const chunk = words.slice(i, i + WORDS_PER_SEG).join(' ');
      const t = i / Math.max(1, words.length) * (words.length / 2.5);
      segs.push({ start: t, end: t + WORDS_PER_SEG / 2.5, text: chunk });
    }
    importLog('log', 'Gemini transcription succeeded', { videoId, segments: segs.length });
    return segs;
  } catch (err) {
    importLog('warn', 'Gemini transcription error', { videoId, error: String(err.message || err).slice(0, 300) });
    return [];
  } finally {
    unlinkQuiet(audioPath);
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

  const transcript = segments.map(s => `[${Math.round(s.start)}-${Math.round(s.end)}s] ${s.text}`).join('\n').slice(0, 20000);

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

async function probeMedia(filePath) {
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
  const probe = await probeMedia(file.path);
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
  const existing = db.watchedChannels.find(item => item.sourceUrl === parsed.canonical);
  const watch = existing || {
    id: randomUUID(),
    userId: payload.userId || 'user_demo',
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
    await run(ytdlpCommand, [...(await ytDlpBaseArgs()), '-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4', '-o', output, video.url], { jobId, label: 'yt-dlp download', timeoutMs: PROCESS_TIMEOUT_MS });
  } catch (error) {
    rememberYtDlpBlock(error);
    importLog('error', 'yt-dlp download failed', { videoId: video.youtubeId, title: video.title, raw: String(error.message || error).slice(0, 1600) });
    throw new Error(friendlyYtDlpError(error));
  }
  const files = await readdir(path.join(STORAGE_DIR, 'originals'));
  const found = files.find(file => file.startsWith(video.youtubeId) && file.endsWith('.mp4'));
  if (!found) throw new Error('yt-dlp completed but no mp4 output was found.');
  return path.join(STORAGE_DIR, 'originals', found);
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
  const audioPath = path.join(STORAGE_DIR, 'originals', `${videoId}_audio.mp3`);
  try {
    // 16kHz mono is Whisper's native format; 96k bitrate improves accuracy vs 64k.
    await run(FFMPEG, ['-y', '-i', mediaPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '96k', '-t', '600', audioPath], { timeoutMs: 3 * 60 * 1000, label: 'extract audio for whisper' });
    if (!existsSync(audioPath) || statSync(audioPath).size < 512) return [];
    const audioBytes = readFileSync(audioPath);
    const boundary = `--------whisper${randomUUID().replace(/-/g, '')}`;
    const fileName = 'audio.mp3';
    const modelName = provider === 'openai' ? 'whisper-1' : 'whisper-1';
    const part1 = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/mpeg\r\n\r\n`);
    // Include a prompt to improve accuracy for accents, slang, and fast speech.
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
    const whisperEndpoint = provider === 'openai' ? 'https://api.openai.com/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
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
      importLog('warn', 'Whisper transcription failed', { status: response.status, body: errText.slice(0, 400) });
      return [];
    }
    const data = await response.json();
    const segs = (data.segments || []).map(seg => ({
      start: Number(seg.start || 0),
      end:   Number(seg.end   || seg.start + 2),
      text:  String(seg.text  || '').trim()
    })).filter(seg => seg.text);
    // Store word-level timestamps for high-quality caption rendering
    const wordData = (data.words || []).map(w => ({
      word:  String(w.word  || '').trim(),
      start: Number(w.start || 0),
      end:   Number(w.end   || w.start + 0.15)
    })).filter(w => w.word);
    if (wordData.length) {
      const wordCachePath = path.join(STORAGE_DIR, 'originals', `${videoId}_words.json`);
      try { writeFileSync(wordCachePath, JSON.stringify({ words: wordData }, null, 2)); } catch {}
    }
    importLog('log', 'Whisper transcription succeeded', { videoId, segments: segs.length, words: wordData.length });
    return segs;
  } catch (error) {
    importLog('warn', 'Whisper transcription error', { videoId, error: String(error.message || error).slice(0, 400) });
    return [];
  } finally {
    unlinkQuiet(audioPath);
  }
}

async function getTranscript(video, mediaPath) {
  const transcriptPath = path.join(STORAGE_DIR, 'originals', `${video.youtubeId}.transcript.json`);
  if (existsSync(transcriptPath)) {
    const cached = JSON.parse(readFileSync(transcriptPath, 'utf8'));
    if (Array.isArray(cached.segments) && cached.segments.length) return cached.segments;
  }
  try {
    const ytdlpCommand = await workingYtDlpCommand();
    if (ytdlpCommand) {
      await run(ytdlpCommand, [...(await ytDlpBaseArgs()), '--skip-download', '--write-auto-subs', '--sub-lang', 'en', '--sub-format', 'json3', '-o', path.join(STORAGE_DIR, 'originals', `${video.youtubeId}.%(ext)s`), video.url]);
    }
  } catch {
    // Keep the pipeline provider-neutral. LLM calls analyze transcripts; audio transcription is configured separately.
  }
  const possible = (await readdir(path.join(STORAGE_DIR, 'originals'))).find(file => file.startsWith(video.youtubeId) && file.endsWith('.json3'));
  if (possible) {
    const raw = JSON.parse(readFileSync(path.join(STORAGE_DIR, 'originals', possible), 'utf8'));
    const events = raw.events || [];
    const segments = events
      .filter(event => event.segs?.length && Number.isFinite(event.tStartMs))
      .map(event => ({
        start: event.tStartMs / 1000,
        end: (event.tStartMs + (event.dDurationMs || 2000)) / 1000,
        text: event.segs.map(seg => seg.utf8).join('').replace(/\s+/g, ' ').trim()
      }))
      .filter(seg => seg.text);
    writeFileSync(transcriptPath, JSON.stringify({ segments }, null, 2));
    return segments;
  }
  throw new Error('No transcript was available. Enable YouTube captions for the source video or add a transcription service before processing.');
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

  // Build caption events — karaoke-style word-by-word highlighting.
  //
  // Caption sync rules:
  //   • Speed-aware chunking: fast speech → fewer words per phrase, slow → more
  //   • Gap-based phrase break: silence > GAP_BREAK forces a new phrase
  //   • Seamless hand-off: highlighted word ends exactly when next word begins
  //   • Hard cap on per-word highlight: prevents stuck captions from bad Whisper ts
  //   • 60ms gap enforced between phrases: prevents bleed-through

  // Timing constants — professional creator standard
  const LINGER       = 0.04;   // 40ms hold after last spoken word then hard cut
  const MAX_WORD_DUR = 0.42;   // cap any single-word highlight (prevents stuck captions)
  const PHRASE_GAP   = 0.03;   // 30ms gap enforced between adjacent phrases
  const PAUSE_BREAK  = 0.22;   // 220ms silence forces a phrase boundary
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

  // Enforce strict inter-phrase gap
  for (let pi = 0; pi < phrases.length - 1; pi++) {
    const lastW    = phrases[pi][phrases[pi].length - 1];
    const nextStart = phrases[pi + 1][0].rs;
    if (lastW.re > nextStart - PHRASE_GAP) {
      lastW.re = Math.max(lastW.rs + 0.03, nextStart - PHRASE_GAP);
    }
  }

  // ── Build ASS dialogue events ─────────────────────────────────
  // Each event = one word's highlight window showing the full phrase.
  // Phrase lifetime: first word start → last word end + LINGER (then instant cut).
  // Instant cut (fad out = 0) = tight sync, no caption overhang.
  const emphSzBig  = Math.round(p.size * 1.14);  // emphasis current word: 14% bigger
  const emphSzCtx  = Math.round(p.size * 0.88);  // emphasis non-current: 12% smaller

  const events = [];
  for (let pi = 0; pi < phrases.length; pi++) {
    const phrase  = phrases[pi];
    const phraseS = phrase[0].rs;
    const lastW   = phrase[phrase.length - 1];
    const phraseE = Math.min(
      lastW.re + LINGER,
      pi < phrases.length - 1 ? phrases[pi + 1][0].rs - PHRASE_GAP : lastW.re + LINGER
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
      evtE = Math.min(evtE, evtS + MAX_WORD_DUR);
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
      words.push({ word: w, start: t, end: Math.min(e, t + d) });
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
      mapped.push({ word:w.word, start:out+(w.start-seg.start), end:out+(w.end-seg.start) });
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
  const result = await run(FFMPEG, ['-i', mediaPath, '-f', 'null', '-'],
    { label:'probe-dims', timeoutMs:15_000 }).catch(e => ({ stderr: e.message||'' }));
  const m = result.stderr.match(/(\d{3,5})x(\d{3,5})/);
  return m ? { w:parseInt(m[1]), h:parseInt(m[2]) } : { w:1920, h:1080 };
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
    _faceTrackAvailable = out.trim() === 'ok' && existsSync(FACE_TRACK_SCRIPT);
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
    // 'dynamic': trust face_track suggestion first
    if (suggestedFrac > 0.01) {
      cropFrac = suggestedFrac;
    } else if (!hasFaces) {
      cropFrac = 0.36;                     // no faces → natural medium shot
    } else {
      switch (sceneType) {
        case 'group':          cropFrac = 0.44; break;
        case 'interview':      cropFrac = faceCount >= 2 ? 0.40 : 0.36; break;
        case 'podcast':        cropFrac = faceCount >= 2 ? 0.38 : 0.34; break;
        case 'reaction':       cropFrac = 0.34; break;
        case 'wide_shot':      cropFrac = 0.40; break;
        case 'close_up':       cropFrac = 0.32; break;
        default:               cropFrac = rangeCX > 0.20 ? 0.36 : 0.34;
      }
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
async function validateClipRender(outputPath) {
  const scores = { captions:90, framing:88, audioSync:95, stability:90, overall:0 };
  const issues = [];
  try {
    // Check dimensions, framerate, duration, codec via ffprobe
    const { stdout: probeOut } = await run('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', outputPath
    ], { label:'validate-probe', timeoutMs:20_000 }).catch(() => ({ stdout:'{}' }));

    const probe = JSON.parse(probeOut || '{}');
    const vStream = (probe.streams || []).find(s => s.codec_type === 'video');
    const aStream = (probe.streams || []).find(s => s.codec_type === 'audio');

    if (vStream) {
      const w = vStream.width || 0;
      const h = vStream.height || 0;
      if (w !== 1080 || h !== 1920) {
        issues.push(`Dimensions ${w}x${h} (expected 1080x1920)`); scores.framing -= 10;
      }
      const fps = eval(vStream.r_frame_rate || '30/1');
      if (fps < 29) { issues.push(`Low framerate: ${fps.toFixed(1)}fps`); scores.stability -= 8; }
      const bitrate = Number(probe.format?.bit_rate || 0);
      if (bitrate > 0 && bitrate < 2_000_000) { issues.push('Low bitrate'); scores.framing -= 5; }
    }

    if (!aStream) { issues.push('No audio stream'); scores.audioSync -= 30; }

    // Quick black frame check at start
    const r = await run(FFMPEG, [
      '-t', '2', '-i', outputPath, '-vf', 'blackdetect=d=0.03:pix_th=0.08', '-f', 'null', '-'
    ], { label:'validate-black', timeoutMs:20_000 }).catch(e => ({ stderr:e.message||'' }));
    if (r.stderr.includes('black_start:0.0')) {
      issues.push('Black frames at opening'); scores.framing -= 12;
    }

    // Check file size is reasonable
    try {
      const stat = statSync(outputPath);
      if (stat.size < 50_000) { issues.push('File too small (<50KB)'); scores.framing -= 20; }
    } catch {}

  } catch {}
  scores.overall = Math.round((scores.captions + scores.framing + scores.audioSync + scores.stability) / 4);
  return { valid: issues.length === 0, scores, issues };
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
    autoPos   = 'bottom-right';
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
  const assPath   = `/tmp/cf_${clipId}.ass`;
  const startedAt = Date.now();
  const title     = String(video.title).slice(0, 42).replace(/:/g, ' ');
  const hook      = (moment.hook || buildCaptionText(moment.text)).slice(0, 120);
  const captionPreset = moment.captionStyle || 'bold';
  const platform  = (moment.bestPlatform || 'universal').toLowerCase().replace(/\s/g, '');
  const renderCfg = RENDER_PRESETS[platform] || RENDER_PRESETS.universal;
  const { width: RW, height: RH } = renderCfg;

  console.log('[render:start]', { jobId, clipId, index, start: moment.start, end: moment.end, preset: captionPreset, memory: memorySnapshot() });

  // ── Stage 1: Word timings ─────────────────────────────────────
  // Try both possible cache key formats (video.id, video.youtubeId)
  let wordTimings = [];
  const wordCacheCandidates = [
    path.join(STORAGE_DIR, 'originals', `${video.id}_words.json`),
    path.join(STORAGE_DIR, 'originals', `${video.youtubeId || ''}_words.json`),
  ].filter((p, i, a) => p && a.indexOf(p) === i); // deduplicate

  for (const wordCache of wordCacheCandidates) {
    if (existsSync(wordCache)) {
      try {
        const cached = JSON.parse(readFileSync(wordCache, 'utf8'));
        const cands  = (cached.words || []).filter(w => w.end > moment.start && w.start < moment.end);
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
    wordTimings = words.map((w, i) => ({ word:w, start:moment.start+i*wd, end:moment.start+(i+1)*wd }));
  }

  // ── Stage 2: Source dimensions + face tracking + stereo analysis
  const clipDuration = moment.end - moment.start;
  const [{ w: srcW, h: srcH }, stereoSide, faceData] = await Promise.all([
    probeVideoDims(mediaPath),
    detectSpeakerSide(mediaPath, moment.start, moment.end),
    trackFaces(mediaPath, moment.start, moment.end),
  ]);
  // Face tracking takes priority over stereo for speaker side
  const speakerSide = faceData?.speakerSide || stereoSide;
  console.log('[render:analysis]', {
    clipId, srcW, srcH, speakerSide,
    faceCount:  faceData?.faceCount ?? 0,
    meanFaceX:  faceData?.meanFaceX ?? 0.5,
    meanFaceW:  faceData?.meanFaceW ?? 0,
    combinedBox: faceData?.combinedBox,
    faceTracked: !!faceData,
  });

  // ── Stage 3: Black frame trim ─────────────────────────────────
  const blackOffset    = await detectContentStart(mediaPath, moment.start);
  const effectiveStart = moment.start + blackOffset;

  // ── Stage 4: Silence + filler removal (EDL) ──────────────────
  const silences = await detectSilences(mediaPath, effectiveStart, moment.end);
  const edlSegs  = buildEDL(wordTimings, silences, moment.start, moment.end, blackOffset);

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
  const assWords = useEDL
    ? remapWordTimings(wordTimings, edlSegs)
    : wordTimings.map(w => ({ word:w.word, start:w.start-effectiveStart, end:w.end-effectiveStart }));
  const totalOutDur = useEDL
    ? edlSegs.reduce((s, seg) => s + seg.end - seg.start, 0)
    : moment.end - effectiveStart;
  // Compute average face Y to position captions above faces in bottom-framed shots
  const kfCyVals = (faceData?.keyframes || []).filter(kf => kf.faceCount > 0).map(kf => kf.cy);
  const faceCyAvg = kfCyVals.length ? kfCyVals.reduce((s, v) => s + v, 0) / kfCyVals.length : null;

  const assContent = buildASSFile(assWords, 0, totalOutDur, captionPreset, RW, RH, faceCyAvg);
  let hasASS = false;
  try { writeFileSync(assPath, assContent, 'utf8'); hasASS = true; } catch {}

  // loudnorm: broadcast-standard loudness (-14 LUFS), prevents clipping
  const audioF = 'acompressor=threshold=0.089:ratio=4:attack=5:release=50,loudnorm=I=-14:TP=-1.5:LRA=11';
  const encodeArgs = [
    '-c:v', 'libx264', '-preset', 'fast',
    '-crf', String(renderCfg.crf), '-maxrate', renderCfg.maxrate, '-bufsize', renderCfg.bufsize,
    '-r', String(renderCfg.fps), '-pix_fmt', 'yuv420p', '-g', String(renderCfg.fps * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
  ];

  // Quality enhancement: sharpen + subtle contrast/saturation lift for premium look
  const qualityF = ',unsharp=5:5:0.7:3:3:0.3,eq=contrast=1.04:saturation=1.10:brightness=0.01';

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
          `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
        ].join(';');
      } else if (pfObj.type === 'fill') {
        return [
          `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,${segFillFilter(segX)}[v${i}]`,
          `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
        ].join(';');
      } else {
        const { fg, bg } = segBlurFilter(segX);
        return [
          `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,split[_s${i}a][_s${i}b]`,
          `[_s${i}a]${bg}[_s${i}bg]`,
          `[_s${i}b]${fg}[_s${i}fg]`,
          `[_s${i}bg][_s${i}fg]overlay=x=0:y=(H-h)/2[v${i}]`,
          `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
        ].join(';');
      }
    });

    const cIn = edlSegs.map((_, i) => `[v${i}][a${i}]`).join('');
    // After concat: apply captions → route to pre-logo label
    const preCapLabel = logoOverlay ? '[_vcap]' : '[vout]';
    const assChain = hasASS ? `[vcat]ass='${assPath}'${preCapLabel}` : '';
    filterComplex =
      `${segParts.join(';')};${cIn}concat=n=${edlSegs.length}:v=1:a=1[vcat][acat]` +
      (hasASS ? `;${assChain}` : '') +
      `;[acat]${audioF}[aout]`;
    vMap = hasASS ? preCapLabel : '[vcat]';
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
    const capF = hasASS ? `,ass='${assPath}'` : '';

    if (pfObj.portraitFill) {
      filterComplex =
        `[0:v]trim=start=${tS}:end=${tE},setpts=PTS-STARTPTS,${pfObj.portraitFill}${qualityF}${capF}${preCapLabel};` +
        `[0:a]atrim=start=${tS}:end=${tE},asetpts=PTS-STARTPTS,${audioF}[aout]`;
    } else if (pfObj.type === 'fill') {
      filterComplex =
        `[0:v]trim=start=${tS}:end=${tE},setpts=PTS-STARTPTS,` +
        `crop=w='${wExpr}':h=${pfObj.cropH}:x='${xExpr}':y=0,` +
        `scale=${RW}:${RH}:flags=lanczos,setsar=1${qualityF}${capF}${preCapLabel};` +
        `[0:a]atrim=start=${tS}:end=${tE},asetpts=PTS-STARTPTS,${audioF}[aout]`;
    } else {
      const dynBgF = pfObj.bgFilterDynamic(xExpr, wExpr);
      filterComplex =
        `[0:v]trim=start=${tS}:end=${tE},setpts=PTS-STARTPTS,split[_dvbg][_dvfg];` +
        `[_dvbg]${dynBgF}[_dbbg];` +
        `[_dvfg]crop=w='${wExpr}':h=${pfObj.cropH}:x='${xExpr}':y=0,` +
        `scale=${RW}:${pfObj.scaledH}:flags=lanczos,setsar=1${qualityF}[_dbfg];` +
        `[_dbbg][_dbfg]overlay=x=0:y=(H-h)/2${capF}${preCapLabel};` +
        `[0:a]atrim=start=${tS}:end=${tE},asetpts=PTS-STARTPTS,${audioF}[aout]`;
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
    const fallbackAssF = hasASS ? `,ass='${assPath}'` : '';
    await run(FFMPEG, [
      '-y', '-ss', String(effectiveStart), '-to', String(moment.end), '-i', mediaPath,
      '-vf', `${fallbackVF}${fallbackAssF}`,
      '-af', audioF,
      ...encodeArgs, output,
    ], { jobId, label: 'render-fallback', timeoutMs: PROCESS_TIMEOUT_MS });
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
  const quality = await validateClipRender(output);
  if (quality.issues.length) console.warn('[render:quality-issues]', { clipId, issues: quality.issues });

  // ── Stage 10: Enrichment ──────────────────────────────────────
  const canDT           = await drawtextSupported();
  const thumbnailOptions = await generateThumbnailOptions(clipId, output, hook, title, canDT);
  const postingData      = await generatePostingAssistant(db, video, { ...moment, hook }, 'TikTok');
  const intelligence     = buildViralIntelligence(video, moment, hook, index);

  return {
    id: clipId,
    title: `${title} #${index + 1}`,
    hook,
    hooks:          moment.hooks || { curiosity:hook, shock:hook, value:hook, story:hook, controversy:hook, sales:hook },
    captionStyle:   captionPreset,
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
    renderIssues:   quality.issues,
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
    createdAt: new Date().toISOString(),
  };
}

function getTargetDurations(videoDurationSeconds) {
  const d = videoDurationSeconds || 0;
  if (d >= 120) return [60, 90, 120];
  if (d >= 90)  return [60, 90];
  if (d >= 60)  return [60];
  return [Math.max(15, Math.floor(d * 0.85))];
}

function fallbackMomentsForVideo(video, options = {}) {
  const duration = Math.max(5, Number(video.durationSeconds || 30));
  const targetDurations = options.targetDurations || getTargetDurations(duration);
  const positions = targetDurations.length === 1
    ? [0]
    : targetDurations.map((_, i) => Math.floor(i * duration / targetDurations.length));
  return targetDurations.map((segLen, index) => {
    const start = Math.min(positions[index], Math.max(0, duration - segLen));
    const end   = Math.min(duration, Math.max(start + 15, start + segLen));
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
  const clipUserId = freshJob.userId || freshVideo.userId || freshVideo.createdBy || '';
  fresh.clips.unshift(...clipRows.map(clip => ({ ...clip, jobId, videoId, userId: clipUserId, status: 'ready' })));
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
  const user = (requestingUserId && db.users.find(u => u.id === requestingUserId))
    || (db2video && db.users.find(u => u.id === (db2video.userId || db2video.createdBy)))
    || db.users.find(u => u.role === 'admin')
    || db.users[0];
  const video = db2video;
  if (!video) throw new Error('Video not found.');
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
  const clipOptions = {
    clipCount:   Math.max(1, Math.min(10, Number(payload.clipCount || 3))),
    clipLength:  Math.max(60, Math.min(600, Number(payload.clipLength || 60))),
    framingMode: ['tight','original','wide','medium','close','dynamic'].includes(payload.framingMode)
                   ? payload.framingMode : 'dynamic',
    brandKitId:  payload.brandKitId || null,
  };
  if (!rightsConfirmed) throw new Error('Confirm that you own this video or have permission to reuse it before processing.');
  if (fairUseMode && !String(transformationNote || '').trim()) {
    throw new Error('Fair-use/remix mode requires a commentary, reaction, education, or transformation note.');
  }
  const db = loadDb();
  const video = db.videos.find(item => item.id === videoId);
  if (!video) throw new Error('Video not found.');
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
    updateJob(job.id, { progress: 30, stage: 'transcribing', steps: processingSteps('transcribing', 30) });
    let transcript = [];
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
    if (transcript.length) {
      saveTranscriptToDb(video.id, transcript);
      updateJob(job.id, { progress: 50, stage: 'extracting B-roll suggestions', steps: processingSteps('analysis', 50) });
      suggestBrollKeywords(db, transcript, video.title).catch(() => {});
    }
    updateJob(job.id, { progress: 58, stage: 'AI analysis — scoring viral moments', steps: processingSteps('analysis', 58) });
    const targetDurations = getTargetDurations(video.durationSeconds);
    const rawMoments = transcript.length
      ? await detectViralMoments(db, video, transcript, {
          ...clipOptions,
          clipCount: targetDurations.length,
          clipLength: targetDurations[0],
          targetDurations,
          mediaPath,  // gives Gemini direct video access for superior analysis
        })
      : fallbackMomentsForVideo(video, { ...clipOptions, targetDurations });
    const moments = rawMoments.map(m => ({ ...m, brandKitId: m.brandKitId || clipOptions.brandKitId || null }));
    if (!moments.length) throw new Error('Could not create a clipping window for this video.');
    updateJob(job.id, { progress: 72, stage: 'creating vertical clips', steps: processingSteps('vertical', 72) });
    const rendered = [];
    for (let i = 0; i < moments.length; i += 1) {
      if (isJobStopped(job.id)) throw new Error('Job was cancelled.');
      updateJob(job.id, {
        progress: Math.min(94, 72 + Math.round((i / Math.max(1, moments.length)) * 22)),
        stage: `rendering clip ${i + 1} of ${moments.length}`,
        steps: processingSteps('rendering', 80)
      });
      rendered.push(await renderClip(db, video, mediaPath, moments[i], i, job.id));
    }
    if (!rendered.length || rendered.some(clip => !clip.outputPath)) throw new Error('Rendering failed: no clips were saved.');

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
          const renderReport = clip.validation || {};
          const qa = await geminiQAReview(db, { ...clip, ...moment }, renderReport);
          if (qa) {
            const db3 = loadDb();
            const dbClip = db3.clips.find(c => c.id === clip.id);
            if (dbClip) { dbClip.geminiQA = qa; saveDb(db3); }
          }
        } catch {}
      })).catch(() => {});
    }

    completeJobWithClips(job.id, video.id, rendered);
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
  const transcript = segments.map(seg => `[${Math.round(seg.start)}-${Math.round(seg.end)}s] ${seg.text}`).join('\n').slice(0, 20000);
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
      const start = Math.max(0, Number(item.start || 0));
      const end = Math.min(Number(videoDuration || start + desiredLength), Number(item.end || start + desiredLength));
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
    .filter(item => item.end > item.start && item.end - item.start >= 55 && item.end - item.start <= 610);

  // Enforce temporal diversity
  const diverse = [];
  for (const m of moments.sort((a, b) => b.score - a.score)) {
    if (diverse.every(d => Math.abs(d.start - m.start) >= minGap)) {
      diverse.push(m);
      if (diverse.length >= desiredCount) break;
    }
  }
  // Fill remaining slots from keyword-score fallback
  for (const fb of fallbackMoments) {
    if (diverse.length >= desiredCount) break;
    if (diverse.every(d => Math.abs(d.start - fb.start) >= minGap)) diverse.push({ ...fb });
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
      return json(res, 200, {
        user: publicUser(user),
        subscription,
        plan,
        stats: {
          imports: db.imports.filter(item => item.userId === user.id || user.role === 'admin').length,
          videos: db.videos.length,
          projects: db.projects.filter(item => item.userId === user.id || user.role === 'admin').length,
          jobs: db.jobs.filter(item => item.userId === user.id || user.role === 'admin').length,
          clips: db.clips.length,
          scheduledPosts: db.scheduledPosts?.length || 0,
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
      return json(res, 200, await importUploadedVideo(req));
    }
    if (pathname === '/api/debug/import') {
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
      return json(res, 200, await pollWatchedChannel(body.watchId));
    }
    if (pathname === '/api/poll-all' && req.method === 'POST') {
      const db = loadDb();
      const active = db.watchedChannels.filter(item => item.status === 'active');
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
      // Check clip count warning for the user's plan
      const { plan } = subscriptionFor(db, user.id);
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
        db.jobs = db.jobs.filter(item => item.id !== body.jobId);
        saveDb(db);
        const queued = createQueuedProcessingJob({ videoId: video.id, rightsConfirmed: true, clipCount: body.clipCount || 3, clipLength: body.clipLength || 60 });
        const retry = enqueueRenderJob({ videoId: video.id, jobId: queued.id, rightsConfirmed: true, clipCount: body.clipCount || 3, clipLength: body.clipLength || 60 });
        retry.catch(error => console.error('[job:retry-failed]', String(error.message || error).slice(0, 2000)));
        return json(res, 202, { queued: true, jobId: queued.id, queueDepth: renderQueue.length, activeRenderJobs });
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
      killActiveJobProcesses(video.id);
      // Delete source file from disk
      if (video.storagePath) unlinkQuiet(video.storagePath);
      // Delete all clips and their files that belong to this video
      const videoClips = db.clips.filter(c => c.videoId === video.id);
      const deletedClipIds = new Set(videoClips.map(c => c.id));
      for (const clip of videoClips) {
        if (clip.outputPath) unlinkQuiet(path.join(STORAGE_DIR, 'clips', path.basename(clip.outputPath)));
        if (clip.thumbnailPath) unlinkQuiet(path.join(STORAGE_DIR, 'thumbs', path.basename(clip.thumbnailPath)));
        // Also remove thumbnail options files
        if (Array.isArray(clip.thumbnailOptions)) {
          for (const opt of clip.thumbnailOptions) {
            if (opt.path) unlinkQuiet(path.join(STORAGE_DIR, opt.path.replace('/media/', '')));
          }
        }
      }
      // Delete scheduled posts linked to these clips
      db.scheduledPosts = (db.scheduledPosts || []).filter(p => !deletedClipIds.has(p.clipId));
      // Remove from db
      db.clips = db.clips.filter(c => c.videoId !== video.id);
      db.jobs = db.jobs.filter(j => j.videoId !== video.id);
      db.videos = db.videos.filter(v => v.id !== video.id);
      db.projects = db.projects.filter(p => db.videos.some(v => v.projectId === p.id));
      saveDb(db);
      return json(res, 200, { deleted: true });
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
        const userClips = db.clips.filter(c => c.userId === user.id);
        for (const clip of userClips) {
          if (clip.outputPath) unlinkQuiet(path.join(STORAGE_DIR, 'clips', path.basename(clip.outputPath)));
          if (clip.thumbnailPath) unlinkQuiet(path.join(STORAGE_DIR, 'thumbs', path.basename(clip.thumbnailPath)));
        }
        const deleted = userClips.length;
        db.clips = db.clips.filter(c => c.userId !== user.id);
        saveDb(db);
        return json(res, 200, { deleted: true, count: deleted });
      }
      const clip = db.clips.find(c => c.id === body.clipId && c.userId === user.id);
      if (!clip) throw new Error('Clip not found.');
      if (clip.outputPath) unlinkQuiet(path.join(STORAGE_DIR, 'clips', path.basename(clip.outputPath)));
      if (clip.thumbnailPath) unlinkQuiet(path.join(STORAGE_DIR, 'thumbs', path.basename(clip.thumbnailPath)));
      db.clips = db.clips.filter(c => c.id !== body.clipId);
      saveDb(db);
      return json(res, 200, { deleted: true });
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
          job.status = 'queued';
          job.progress = 0;
          job.stage = 'queued for retry';
          job.error = '';
        }
        if (body.action === 'delete') db.jobs = db.jobs.filter(item => item.id !== body.jobId);
        saveDb(db);
      }
      return json(res, 200, { jobs: db.jobs });
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
      const youtubeReady = settingReady(db, 'YOUTUBE_API_KEY');
      const allReady = ytdlpStatus.ok && ffmpegStatus.ok && llmReady;
      return json(res, 200, {
        status: allReady ? 'ready' : 'degraded',
        tools: {
          ffmpeg: { ok: ffmpegStatus.ok, version: ffmpegStatus.version, error: ffmpegStatus.error || '' },
          ytdlp: { ok: ytdlpStatus.ok, version: ytdlpStatus.version, command: ytdlpCommand || '', error: ytdlpStatus.error || '' },
          llm: { ok: llmReady },
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
    // Clip video/thumbnail files are named after the clip id — enforce per-user ownership,
    // not just "logged in", since these are the assets an IDOR would actually expose.
    const relative = url.pathname.replace('/media/', '');
    const clipMatch = relative.match(/^(?:clips|thumbs)\/(?:clip_)?([^./]+)\./);
    if (clipMatch) {
      const clip = db.clips.find(c => c.id === clipMatch[1]);
      if (clip && clip.userId !== user.id && user.role !== 'admin') {
        return json(res, 403, { error: 'You do not have access to this clip.' });
      }
    }
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

server.listen(PORT, HOST, async () => {
  console.log(`ClipForge AI running at http://${HOST}:${PORT}`);
  await verifyMediaBinaries();
  recoverStaleJobs('startup');
  logMemory('startup');
  pollDueWatchedChannels().catch(() => {});
  setInterval(() => pollDueWatchedChannels().catch(() => {}), Number(process.env.WATCH_INTERVAL_MINUTES || 15) * 60 * 1000);
  setInterval(() => logMemory('heartbeat'), Number(process.env.MEMORY_LOG_INTERVAL_MS || 60_000));
  setInterval(() => recoverStaleJobs('interval'), 60_000);
});
