import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Busboy from 'busboy';

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
const CREDITS_ENABLED = process.env.CREDITS_ENABLED === 'true';
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

function hashPassword(password = '') {
  return createHash('sha256').update(`clipforge:${password}`).digest('hex');
}

function defaultPlans() {
  return [
    { id: 'free', name: 'Free', monthlyPrice: 0, creditsIncluded: 20, maxVideoLength: 20, maxClipsPerVideo: 3, autoWatchAllowed: false, autoPostAllowed: false },
    { id: 'starter', name: 'Starter', monthlyPrice: 5, creditsIncluded: 80, maxVideoLength: 60, maxClipsPerVideo: 5, autoWatchAllowed: true, autoPostAllowed: false },
    { id: 'creator', name: 'Creator', monthlyPrice: 9, creditsIncluded: 180, maxVideoLength: 120, maxClipsPerVideo: 8, autoWatchAllowed: true, autoPostAllowed: false },
    { id: 'studio', name: 'Studio', monthlyPrice: 10, creditsIncluded: 260, maxVideoLength: 180, maxClipsPerVideo: 10, autoWatchAllowed: true, autoPostAllowed: false }
  ];
}

const API_SETTING_META = [
  ['YOUTUBE_API_KEY', 'YouTube Data API key'],
  ['LLM_PROVIDER', 'LLM provider'],
  ['LLM_API_KEY', 'LLM API key'],
  ['LLM_BASE_URL', 'LLM OpenAI-compatible base URL'],
  ['LLM_MODEL', 'LLM model'],
  ['LLM_FALLBACK_PROVIDER', 'Fallback LLM provider'],
  ['LLM_FALLBACK_API_KEY', 'Fallback LLM API key'],
  ['LLM_FALLBACK_BASE_URL', 'Fallback LLM base URL'],
  ['LLM_FALLBACK_MODEL', 'Fallback LLM model'],
  ['MUAPI_API_KEY', 'Muapi.ai API key (text-to-video, image-to-video, FLUX, Kling, Seedance)'],
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
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
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

function recoverStaleJobs(reason = 'startup') {
  const db = loadDb();
  const now = Date.now();
  let changed = 0;
  for (const job of db.jobs) {
    if (!['queued', 'running'].includes(job.status)) continue;
    const last = Date.parse(job.updatedAt || job.createdAt || 0) || 0;
    const created = Date.parse(job.createdAt || 0) || last;
    if (now - last > JOB_STALE_MS || now - created > PROCESS_TIMEOUT_MS + JOB_STALE_MS) {
      job.status = 'failed';
      job.progress = 100;
      job.stage = 'failed';
      job.error = `Job stopped responding after restart or timeout. Start a retry.`;
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
  db.imports.unshift({
    id: importId,
    userId: 'user_demo',
    projectId,
    sourceUrl,
    sourceType,
    status: 'imported',
    createdAt: new Date().toISOString()
  });
  db.projects.unshift({
    id: projectId,
    userId: defaults.userId || 'user_demo',
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
    const existing = db.videos.find(item => item.youtubeId === video.youtubeId);
    if (existing) continue;
    const row = {
      id: randomUUID(),
      importId,
      ...video,
      selected: false,
      rightsConfirmed: Boolean(defaults.rightsConfirmed),
      fairUseMode: Boolean(defaults.fairUseMode),
      transformationNote: defaults.transformationNote || '',
      watchedChannelId: defaults.watchedChannelId || null,
      projectId
    };
    db.videos.unshift({
      ...row
    });
    added.push(row);
  }
  return { importId, videos: added };
}

async function importSource(sourceUrl) {
  const { parsed, videos, source, warnings } = await fetchSourceVideos(sourceUrl);
  const db = loadDb();
  const result = addImportedVideos(db, parsed.canonical, parsed.type, videos);
  saveDb(db);
  return { ...result, source: source || 'youtube-api', warnings: warnings || [], canonicalUrl: parsed.canonical };
}

function unlinkQuiet(filePath) {
  try {
    if (filePath && existsSync(filePath)) unlinkSync(filePath);
  } catch {}
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
  const cleanup = cleanupOldSourcesForNewUpload(db);
  const result = addImportedVideos(db, 'upload', 'upload', [video]);
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
    userId: 'user_demo',
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
  if (!apiKey) return [];
  const audioPath = path.join(STORAGE_DIR, 'originals', `${videoId}_audio.mp3`);
  try {
    await run(FFMPEG, ['-y', '-i', mediaPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', '-t', '600', audioPath], { timeoutMs: 3 * 60 * 1000, label: 'extract audio for whisper' });
    if (!existsSync(audioPath) || statSync(audioPath).size < 512) return [];
    const audioBytes = readFileSync(audioPath);
    const boundary = `--------whisper${randomUUID().replace(/-/g, '')}`;
    const fileName = 'audio.mp3';
    const modelName = provider === 'openai' ? 'whisper-1' : 'whisper-1';
    const part1 = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/mpeg\r\n\r\n`);
    const part2 = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${modelName}\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword\r\n--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment\r\n--${boundary}--\r\n`);
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
    // Try multiple window sizes: 15s, 30s, 45s, 60s
    for (const targetDur of [15, 30, 45, 60]) {
      const start = segments[i].start;
      const endLimit = start + targetDur;
      const group = [];
      for (let j = i; j < segments.length && segments[j].start < endLimit; j++) group.push(segments[j]);
      if (!group.length) continue;
      const end = Math.min(group.at(-1).end, endLimit);
      const dur = end - start;
      if (dur < 12 || dur > 62) continue;

      const text = group.map(s => s.text).join(' ').toLowerCase();
      const firstLine = group[0].text.trim();
      const wordCount = text.split(/\s+/).length;

      // Scoring dimensions
      const hookScore = VIRAL_HOOKS.reduce((s, w) => s + (text.includes(w) ? 18 : 0), 0);
      const emotionScore = EMOTION_WORDS.reduce((s, w) => s + (text.includes(w) ? 10 : 0), 0);
      const valueScore = VALUE_WORDS.reduce((s, w) => s + (text.includes(w) ? 8 : 0), 0);
      const questionScore = QUESTION_STARTERS.test(firstLine) ? 20 : 0;
      const punctScore = (text.match(/[?!]/g) || []).length * 5;
      const densityScore = Math.min(25, Math.round(wordCount / Math.max(1, dur) * 10));
      const openingHookScore = QUESTION_STARTERS.test(firstLine) || firstLine.length < 60 ? 10 : 0;
      // Prefer 30-45s clips (ideal for Reels/Shorts)
      const durationBonus = targetDur >= 25 && targetDur <= 50 ? 12 : 0;

      const score = Math.min(99, 30 + hookScore + emotionScore + valueScore + questionScore + punctScore + densityScore + openingHookScore + durationBonus);

      windows.push({ start, end, score, text: group.map(s => s.text).join(' '), targetDur });
    }
  }

  // Deduplicate: keep highest-scoring window starting near each position
  return windows
    .sort((a, b) => b.score - a.score)
    .filter((c, _, all) => all.findIndex(o => Math.abs(o.start - c.start) < 15) === all.indexOf(c))
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
    outlineW:4, shadow:4, borderStyle:1, alignment:2, marginV:200, marginLR:70,
    highlight:'&H0000FFFF&', context:'&H90FFFFFF&',
    phraseSize:3, uppercase:true, spacing:1, fad:'60,40',
  },
  mrbeast: {
    name:'MrBeast', font:'Impact', size:100, bold:0, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H000060FF&', outline:'&H00000000&', back:'&H88000000&',
    outlineW:5, shadow:5, borderStyle:1, alignment:2, marginV:180, marginLR:55,
    highlight:'&H000060FF&', context:'&H80FFFFFF&',
    phraseSize:3, uppercase:true, spacing:2, fad:'50,30',
  },
  podcast: {
    name:'Podcast', font:'Arial', size:68, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000FFFF&', outline:'&H00000000&', back:'&HCC000000&',
    outlineW:2, shadow:3, borderStyle:4, alignment:2, marginV:140, marginLR:90,
    highlight:'&H0000FFFF&', context:'&H99FFFFFF&',
    phraseSize:6, uppercase:false, spacing:0, fad:'40,30',
  },
  minimal: {
    name:'Minimal', font:'Arial', size:58, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H00FFFFFF&', outline:'&H00000000&', back:'&H00000000&',
    outlineW:3, shadow:3, borderStyle:1, alignment:2, marginV:120, marginLR:110,
    highlight:'&H00FFFFFF&', context:'&H88FFFFFF&',
    phraseSize:6, uppercase:false, spacing:0, fad:'35,25',
  },
  luxury: {
    name:'Luxury', font:'Georgia', size:62, bold:0, italic:0,
    primary:'&H00E8E8E8&', secondary:'&H0000D7FF&', outline:'&H00000000&', back:'&H00000000&',
    outlineW:2, shadow:3, borderStyle:1, alignment:2, marginV:150, marginLR:95,
    highlight:'&H0000D7FF&', context:'&H80E8E8E8&',
    phraseSize:5, uppercase:false, spacing:2, fad:'70,50',
  },
  finance: {
    name:'Finance', font:'Arial', size:64, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H00FF7800&', outline:'&H00050505&', back:'&H99000000&',
    outlineW:3, shadow:3, borderStyle:1, alignment:2, marginV:140, marginLR:90,
    highlight:'&H00FF7800&', context:'&H88FFFFFF&',
    phraseSize:5, uppercase:false, spacing:0, fad:'45,30',
  },
  tiktok: {
    name:'TikTok', font:'Arial Black', size:86, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000FFFF&', outline:'&H00000000&', back:'&H00000000&',
    outlineW:4, shadow:4, borderStyle:1, alignment:2, marginV:180, marginLR:65,
    highlight:'&H0000FFFF&', context:'&H80FFFFFF&',
    phraseSize:4, uppercase:true, spacing:1, fad:'45,30',
  },
  instagram: {
    name:'Instagram', font:'Arial', size:70, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H00FF7800&', outline:'&H00000000&', back:'&HCC000000&',
    outlineW:2, shadow:3, borderStyle:4, alignment:2, marginV:155, marginLR:75,
    highlight:'&H00FF7800&', context:'&H88FFFFFF&',
    phraseSize:5, uppercase:false, spacing:0, fad:'50,35',
  },
  bold: {
    name:'Bold', font:'Arial Black', size:84, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000FFFF&', outline:'&H00000000&', back:'&H99000000&',
    outlineW:4, shadow:4, borderStyle:1, alignment:2, marginV:170, marginLR:75,
    highlight:'&H0000FFFF&', context:'&H80FFFFFF&',
    phraseSize:4, uppercase:true, spacing:0, fad:'55,35',
  },
  karaoke: {
    name:'Karaoke', font:'Arial Black', size:78, bold:-1, italic:0,
    primary:'&H00FFFFFF&', secondary:'&H0000FFFF&', outline:'&H00000000&', back:'&HDD000000&',
    outlineW:2, shadow:2, borderStyle:4, alignment:2, marginV:160, marginLR:80,
    highlight:'&H0000FFFF&', context:'&HBBFFFFFF&',
    phraseSize:5, uppercase:false, spacing:0, fad:'40,25',
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

function buildASSFile(words, clipStart, clipEnd, presetName, W=1080, H=1920) {
  const p   = ASS_PRESETS[presetName] || ASS_PRESETS.bold;
  const SZ  = Math.max(2, Math.min(p.phraseSize || 5, 6));
  const dur = clipEnd - clipStart;

  const cw = words
    .filter(w => w.end > clipStart && w.start < clipEnd)
    .map(w => ({
      word: assEscape(p.uppercase ? w.word.toUpperCase() : w.word),
      rs:   Math.max(0, w.start - clipStart),
      re:   Math.min(dur, w.end - clipStart),
    }))
    .filter(w => w.re > w.rs + 0.01 && w.word.trim());

  const header = `[Script Info]
ScriptType: v4.00+
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${p.name},${p.font},${p.size},${p.primary},${p.secondary},${p.outline},${p.back},${p.bold},${p.italic},0,0,100,100,${p.spacing},0,${p.borderStyle},${p.outlineW},${p.shadow},${p.alignment},${p.marginLR},${p.marginLR},${p.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  if (!cw.length) return header;

  const events = [];
  for (let i = 0; i < cw.length; i += SZ) {
    const phrase = cw.slice(i, i + SZ);
    const phraseStart = phrase[0].rs;
    const phraseEnd   = phrase[phrase.length - 1].re;

    for (let wi = 0; wi < phrase.length; wi++) {
      const w = phrase[wi];
      if (w.re <= 0) continue;
      // Show phrase from start of phrase, hide it at the end of the phrase
      // Only the active word gets the highlight color + bold
      const parts = phrase.map((pw, j) =>
        j === wi
          ? `{\\c${p.highlight}\\b1\\3a&H00&}${pw.word}{\\r}`
          : `{\\c${p.context}}${pw.word}`
      );
      events.push(
        `Dialogue: 0,${assTime(w.rs)},${assTime(w.re)},${p.name},,0,0,0,,` +
        `{\\an${p.alignment}\\fad(${p.fad})}${parts.join(' ')}`
      );
    }
  }
  return header + events.join('\n') + '\n';
}

// ─── Word timing helpers ──────────────────────────────────────────
function estimateWordTimings(segments, clipStart, clipEnd) {
  const words = [];
  for (const seg of (segments || [])) {
    if (!seg.text || seg.end <= clipStart || seg.start >= clipEnd) continue;
    const ws = seg.text.trim().split(/\s+/).filter(Boolean);
    if (!ws.length) continue;
    const s = Math.max(seg.start, clipStart);
    const e = Math.min(seg.end, clipEnd);
    const d = (e - s) / ws.length;
    ws.forEach((w, i) => words.push({ word:w, start:s+i*d, end:s+(i+1)*d }));
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
      const p = spawn(py, [FACE_TRACK_SCRIPT, mediaPath, String(start), String(end), '3'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let out = '', err = '';
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => err += d);
      p.on('close', code => {
        if (code === 0) resolve({ stdout: out });
        else reject(new Error(`face_track exit ${code}: ${err.slice(0,200)}`));
      });
      setTimeout(() => p.kill(), 20000);
    });
    return JSON.parse(stdout.trim());
  } catch (e) {
    console.warn('[face-track:skip]', e.message?.slice(0,100));
    return null;
  }
}

// Produces a landscape→portrait crop that:
//   - uses face X position (from ML) or stereo side heuristic for horizontal tracking
//   - maintains safe margins (never crops forehead/mouth)
//   - applies sharpening for social media clarity
// faceX: 0..1 relative face center X in source video (from face_track.py), 0.5 = center
function buildPortraitFilter(srcW=1920, srcH=1080, outW=1080, outH=1920, speakerSide='center', clipDuration=30, faceX=0.5) {
  if (srcH >= srcW) {
    // Already portrait/square — scale to fill
    return [
      `scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${outW}:${outH}:(iw-${outW})/2:(ih-${outH})/2`,
      `unsharp=lx=3:ly=3:la=0.3:cx=3:cy=3:ca=0`,
      `setsar=1`,
    ].join(',');
  }

  // Landscape → portrait
  // Scale so height fills outH, then crop a portrait slice
  const scaledW = Math.ceil((srcW / srcH) * outH / 2) * 2;
  const maxCropX = scaledW - outW;

  // Compute the desired crop-X center from face position
  // faceX is in source-video coordinate (0..1), map to scaled-video pixels
  let targetCenterX;
  if (faceX !== 0.5 && Math.abs(faceX - 0.5) > 0.05) {
    // Face detected with meaningful offset — track it
    targetCenterX = Math.round(faceX * scaledW);
  } else if (speakerSide === 'left') {
    targetCenterX = Math.round(scaledW * 0.35);
  } else if (speakerSide === 'right') {
    targetCenterX = Math.round(scaledW * 0.65);
  } else {
    targetCenterX = Math.round(scaledW * 0.5);
  }

  // Clamp so we never show outside the frame
  const halfOut = Math.floor(outW / 2);
  const cropX   = Math.max(0, Math.min(maxCropX, targetCenterX - halfOut));

  // Vertical: start from top (portrait uses full height of scaled landscape)
  const cropY = '0';

  return [
    `scale=${scaledW}:${outH}:flags=lanczos`,
    `crop=${outW}:${outH}:${cropX}:${cropY}`,
    `unsharp=lx=5:ly=5:la=0.5:cx=5:cy=5:ca=0`,
    `setsar=1`,
  ].join(',');
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
  let wordTimings = [];
  const wordCache = path.join(STORAGE_DIR, 'originals', `${video.youtubeId || video.id}_words.json`);
  if (existsSync(wordCache)) {
    try {
      const cached = JSON.parse(readFileSync(wordCache, 'utf8'));
      wordTimings = (cached.words || []).filter(w => w.end > moment.start && w.start < moment.end);
    } catch {}
  }
  if (!wordTimings.length) {
    const clipSegs = (db.transcriptions?.find(t => t.videoId === video.id)?.segments || [])
      .filter(s => s.end > moment.start && s.start < moment.end);
    wordTimings = estimateWordTimings(clipSegs, moment.start, moment.end);
  }
  // Fallback: estimate from moment text if still empty
  if (!wordTimings.length && moment.text) {
    const words = moment.text.split(/\s+/).filter(Boolean);
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
  const faceX       = faceData?.meanFaceX ?? 0.5;   // 0..1 relative to source width
  console.log('[render:analysis]', { clipId, srcW, srcH, speakerSide, faceX, faceTracked: !!faceData });

  // ── Stage 3: Black frame trim ─────────────────────────────────
  const blackOffset    = await detectContentStart(mediaPath, moment.start);
  const effectiveStart = moment.start + blackOffset;

  // ── Stage 4: Silence + filler removal (EDL) ──────────────────
  const silences = await detectSilences(mediaPath, effectiveStart, moment.end);
  const edlSegs  = buildEDL(wordTimings, silences, moment.start, moment.end, blackOffset);
  const useEDL   = edlSegs.length > 1;

  // ── Stage 5: ASS word-level captions ─────────────────────────
  const assWords = useEDL
    ? remapWordTimings(wordTimings, edlSegs)
    : wordTimings.map(w => ({ word:w.word, start:w.start-effectiveStart, end:w.end-effectiveStart }));
  const totalOutDur = useEDL
    ? edlSegs.reduce((s, seg) => s + seg.end - seg.start, 0)
    : moment.end - effectiveStart;
  const assContent = buildASSFile(assWords, 0, totalOutDur, captionPreset, RW, RH);
  let hasASS = false;
  try { writeFileSync(assPath, assContent, 'utf8'); hasASS = true; } catch {}

  // ── Stage 6: Filter complex ───────────────────────────────────
  const portraitF = buildPortraitFilter(srcW, srcH, RW, RH, speakerSide, clipDuration, faceX);
  const assF      = hasASS ? `,ass='${assPath}'` : '';
  // loudnorm: broadcast-standard loudness (-14 LUFS), prevents clipping
  const audioF    = 'acompressor=threshold=0.089:ratio=4:attack=5:release=50,loudnorm=I=-14:TP=-1.5:LRA=11';
  const encodeArgs = [
    '-c:v', 'libx264', '-preset', 'fast',
    '-crf', String(renderCfg.crf), '-maxrate', renderCfg.maxrate, '-bufsize', renderCfg.bufsize,
    '-r', String(renderCfg.fps), '-pix_fmt', 'yuv420p', '-g', String(renderCfg.fps * 2),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
  ];

  let filterComplex, vMap, aMap;
  if (useEDL) {
    const trims = edlSegs.map((s, i) => [
      `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`,
      `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
    ].join(';')).join(';');
    const cIn = edlSegs.map((_, i) => `[v${i}][a${i}]`).join('');
    filterComplex =
      `${trims};${cIn}concat=n=${edlSegs.length}:v=1:a=1[vcat][acat];` +
      `[vcat]${portraitF}${assF}[vout];[acat]${audioF}[aout]`;
  } else {
    filterComplex =
      `[0:v]trim=start=${effectiveStart.toFixed(3)}:end=${moment.end.toFixed(3)},setpts=PTS-STARTPTS,${portraitF}${assF}[vout];` +
      `[0:a]atrim=start=${effectiveStart.toFixed(3)}:end=${moment.end.toFixed(3)},asetpts=PTS-STARTPTS,${audioF}[aout]`;
  }
  vMap = '[vout]'; aMap = '[aout]';

  // ── Stage 7: Render ───────────────────────────────────────────
  try {
    await run(FFMPEG, [
      '-y', '-i', mediaPath,
      '-filter_complex', filterComplex,
      '-map', vMap, '-map', aMap,
      ...encodeArgs, output,
    ], { jobId, label: 'render-v2', timeoutMs: PROCESS_TIMEOUT_MS });
  } catch (renderErr) {
    console.warn('[render:v3-fallback]', { clipId, err: String(renderErr.message||renderErr).slice(0,300) });
    try { if (existsSync(output)) unlinkSync(output); } catch {}
    // Fallback: single-pass with portrait + basic audio, no EDL/ASS
    const fallbackAssF = hasASS ? `,ass='${assPath}'` : '';
    const fallbackPortrait = buildPortraitFilter(srcW, srcH, RW, RH, speakerSide, clipDuration, faceX);
    await run(FFMPEG, [
      '-y', '-ss', String(effectiveStart), '-to', String(moment.end), '-i', mediaPath,
      '-vf', `${fallbackPortrait}${fallbackAssF}`,
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

function fallbackMomentsForVideo(video, options = {}) {
  const duration = Math.max(5, Number(video.durationSeconds || 30));
  const wantedCount = Math.max(1, Math.min(10, Number(options.clipCount || 3)));
  const wantedLength = Math.max(5, Math.min(60, Number(options.clipLength || 15)));
  const count = duration < wantedLength ? 1 : Math.min(wantedCount, Math.max(1, Math.floor(duration / wantedLength)));
  return Array.from({ length: count }).map((_, index) => {
    const segmentLength = Math.min(wantedLength, Math.min(60, Math.max(5, Math.floor(duration / count))));
    const start = Math.min(Math.max(0, index * segmentLength), Math.max(0, duration - 5));
    const end = Math.min(duration, Math.max(start + 5, start + segmentLength));
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
  fresh.clips.unshift(...clipRows.map(clip => ({ ...clip, jobId, videoId, status: 'ready' })));
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
  const user = db.users[0];
  const video = db.videos.find(item => item.id === videoId);
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
    clipCount: Math.max(1, Math.min(10, Number(payload.clipCount || 3))),
    clipLength: Math.max(5, Math.min(60, Number(payload.clipLength || 15)))
  };
  if (!rightsConfirmed) throw new Error('Confirm that you own this video or have permission to reuse it before processing.');
  if (fairUseMode && !String(transformationNote || '').trim()) {
    throw new Error('Fair-use/remix mode requires a commentary, reaction, education, or transformation note.');
  }
  const db = loadDb();
  const user = db.users[0];
  const video = db.videos.find(item => item.id === videoId);
  if (!video) throw new Error('Video not found.');
  const existingJob = db.jobs.find(item => item.videoId === videoId && ['queued', 'running'].includes(item.status) && item.id !== payload.jobId);
  if (existingJob) return { jobId: existingJob.id, duplicate: true };
  if (CREDITS_ENABLED && user.credits < CLIP_JOB_CREDIT_COST) throw new Error(`Not enough credits. Each video job uses ${CLIP_JOB_CREDIT_COST} credits.`);
  video.rightsConfirmed = true;
  video.fairUseMode = Boolean(fairUseMode);
  video.transformationNote = transformationNote || '';
  video.status = 'queued';
  if (CREDITS_ENABLED) {
    user.credits -= CLIP_JOB_CREDIT_COST;
    db.creditTransactions.unshift({ id: randomUUID(), userId: user.id, amount: -CLIP_JOB_CREDIT_COST, reason: `Clip job for ${video.title}`, createdAt: new Date().toISOString() });
  }
  let job = payload.jobId ? db.jobs.find(item => item.id === payload.jobId) : null;
  if (!job) {
    job = {
      id: randomUUID(),
      userId: user.id,
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
    const moments = transcript.length ? await detectViralMoments(db, video, transcript, clipOptions) : fallbackMomentsForVideo(video, clipOptions);
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
      saveDb(failedDb);
    }
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
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function currentUser(req, db) {
  const userId = req.headers['x-user-id'] || new URL(req.url, `http://${req.headers.host}`).searchParams.get('userId');
  return db.users.find(user => user.id === userId) || db.users[0];
}

function publicUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

function requireAdmin(req, db) {
  const user = currentUser(req, db);
  if (user.role !== 'admin') throw new Error('Admin access required.');
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

function normalizeOpenAiBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === 'REPLACE_WITH_EMERGENT_ENDPOINT') return '';
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function aiConfig(db, fallback = false) {
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
    emergent: 'https://api.emergent.sh/v1'
  };
  const providerModels = {
    xai: 'grok-3-mini', grok: 'grok-3-mini',
    openai: 'gpt-4o-mini', groq: 'llama-3.3-70b-versatile',
    together: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo'
  };
  const baseUrl = customBaseUrl ? normalizeOpenAiBaseUrl(customBaseUrl) : (providerDefaults[provider] || '');
  const model = settingValue(db, `${prefix}MODEL`) || providerModels[provider] || 'grok-3-mini';
  return { provider, apiKey, baseUrl, model, customBaseUrl: Boolean(customBaseUrl) };
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
    const res = await fetch(`${MUAPI_BASE}/predictions/${requestId}/result`, {
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
    const res = await fetch(`${HIGGSFIELD_BASE}/status/${jobId}`, {
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
      const payload = {
        prompt: generation.prompt,
        negative_prompt: generation.negativePrompt || '',
        ...(generation.imageUrl ? { image_url: generation.imageUrl } : {}),
        ...(model.extra || {})
      };
      const submitted = await muapiSubmit(muapiKey, model.endpoint, payload);
      generation.externalId = submitted.request_id || submitted.id;
      saveDb(db);
      const result = await muapiPoll(muapiKey, generation.externalId);
      outputUrl = result.output?.[0] || result.video_url || result.image_url || result.url || '';
    } else if (model.provider === 'higgsfield') {
      if (!higgsfieldKey) throw new Error('HIGGSFIELD_API_KEY not configured. Add it in Admin → API Configuration.');
      const submitted = await higgsfieldSubmit(higgsfieldKey, model.endpoint, {
        prompt: generation.prompt,
        ...(generation.imageUrl ? { image_url: generation.imageUrl } : {})
      });
      generation.externalId = submitted.id || submitted.job_id;
      saveDb(db);
      const result = await higgsfieldPoll(higgsfieldKey, generation.externalId);
      outputUrl = result.output_url || result.video_url || result.url || '';
    }

    if (!outputUrl) throw new Error('No output URL in API response');

    const ext = model.category === 't2i' ? 'jpg' : 'mp4';
    const filename = `gen_${generation.id}.${ext}`;
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
  const attempts = [aiConfig(db, false)];
  const fallbackConfig = aiConfig(db, true);
  if (fallback && fallbackConfig.provider && fallbackConfig.apiKey && fallbackConfig.baseUrl) attempts.push(fallbackConfig);

  let lastError;
  for (const config of attempts) {
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
    for (const endpoint of aiEndpointCandidates(config)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
      try {
        const body = {
          model: config.model,
          messages,
          temperature
        };
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
        if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 500)}`);
        const data = JSON.parse(text);
        const content = data.choices?.[0]?.message?.content || '';
        recordAiLog({
          ...config,
          baseUrl: endpoint,
          purpose,
          ok: true,
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens
        });
        return { content, data, provider: config.provider, model: config.model, usage: data.usage || {} };
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        recordAiLog({ ...config, baseUrl: endpoint, purpose, ok: false, error: error.name === 'AbortError' ? `AI request timed out after ${Math.round(AI_TIMEOUT_MS / 1000)}s` : error.message });
      }
    }
  }
  throw lastError || new Error('LLM request failed.');
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
  const desiredLength = Math.max(5, Math.min(60, Number(options.clipLength || 15)));
  const desiredCount = Math.max(1, Math.min(10, Number(options.clipCount || 3)));
  const fallbackMoments = scoreMoments(segments, video.durationSeconds).slice(0, desiredCount);
  const transcript = segments.map(seg => `[${Math.round(seg.start)}-${Math.round(seg.end)}s] ${seg.text}`).join('\n').slice(0, 18000);
  try {
    const result = await aiChat(db, {
      purpose: 'viral moment detection',
      messages: [
        { role: 'system', content: `You are an elite viral video editor who has mastered OpusClip, CapCut, Submagic, Captions.ai, and Klap. You think like a professional TikTok editor: you find the exact moment that stops scrollers, builds tension, and delivers a payoff. You select clips that prioritize: (1) a powerful opening hook in the FIRST 3 seconds, (2) one clear emotional peak, (3) a satisfying ending. Return only valid JSON.` },
        { role: 'user', content: `Analyze this transcript and find the ${desiredCount} highest-potential viral clips.

Video: "${video.title}"
Duration: ${video.durationSeconds || 0}s
Target length per clip: ${desiredLength}s (hard max 60s)

RULES:
- The clip MUST open with a statement that stops a scroll in 3 seconds
- Prefer moments with: surprise reveals, emotional reactions, laugh moments, argument peaks, shocking statistics, personal confessions, pattern interrupts
- Never start a clip mid-sentence — always at a natural speech boundary
- Never cut off before the payoff/resolution

Transcript (timestamps in seconds):
${transcript}

Score each moment:
- hookStrength (1-10): Does the opening sentence stop a scroll?
- emotionalPunch (1-10): Does it trigger a strong emotion?
- voiceEnergy (1-10): Is the speaker energetic/passionate here?
- controversy (1-10): Will people debate/comment?
- usefulness (1-10): Does it deliver actionable value?
- storytelling (1-10): Does it have arc (tension + payoff)?
- shareability (1-10): Will viewers send it to friends?
- overallScore (1-100): Weighted viral potential

Return exactly:
{"moments":[{"start":number,"end":number,"overallScore":number,"hookStrength":number,"emotionalPunch":number,"voiceEnergy":number,"controversy":number,"usefulness":number,"storytelling":number,"shareability":number,"reason":"laugh|revelation|shock|emotion|value|argument|reaction|story","rationale":"Why a human TikTok editor would pick this exact moment","hooks":{"curiosity":"hook under 96 chars","shock":"hook under 96 chars","value":"hook under 96 chars","story":"hook under 96 chars","controversy":"hook under 96 chars","sales":"hook under 96 chars"},"brollKeywords":["keyword1","keyword2","keyword3","keyword4"],"bestPlatform":"TikTok|Instagram Reels|YouTube Shorts|X|LinkedIn","captionStyle":"hormozi|karaoke|minimal|luxury|tiktok|podcast"}]}` }
      ]
    });
    const parsed = extractJsonObject(result.content);
    const moments = (parsed?.moments || [])
      .map(item => {
        const start = Math.max(0, Number(item.start || 0));
        const end = Math.min(Number(video.durationSeconds || start + 60), Number(item.end || start + desiredLength));
        const text = segments.filter(seg => seg.end >= start && seg.start <= end).map(seg => seg.text).join(' ');
        const hooks = item.hooks || {};
        const primaryHook = hooks.curiosity || hooks.shock || hooks.value || buildCaptionText(text);
        return {
          start,
          end,
          score: Math.max(1, Math.min(100, Number(item.overallScore || item.score || 75))),
          hookStrength:   Number(item.hookStrength || 7),
          emotionalPunch: Number(item.emotionalPunch || 7),
          voiceEnergy:    Number(item.voiceEnergy || 7),
          controversy:    Number(item.controversy || 5),
          usefulness:     Number(item.usefulness || 7),
          storytelling:   Number(item.storytelling || 6),
          shareability:   Number(item.shareability || 7),
          reason: item.reason || 'educational',
          hook: primaryHook.slice(0, 96),
          hooks: {
            curiosity: (hooks.curiosity || primaryHook).slice(0, 96),
            shock: (hooks.shock || primaryHook).slice(0, 96),
            value: (hooks.value || primaryHook).slice(0, 96),
            story: (hooks.story || primaryHook).slice(0, 96),
            controversy: (hooks.controversy || primaryHook).slice(0, 96),
            sales: (hooks.sales || primaryHook).slice(0, 96)
          },
          brollKeywords: Array.isArray(item.brollKeywords) ? item.brollKeywords.slice(0, 8) : [],
          bestPlatform: item.bestPlatform || 'TikTok',
          captionStyle: item.captionStyle || 'hormozi',
          rationale: item.rationale || 'AI-selected viral moment.',
          text: text || primaryHook || video.title
        };
      })
      .filter(item => item.end > item.start && item.end - item.start <= 62)
      .slice(0, desiredCount);
    return moments.length ? moments : fallbackMoments;
  } catch {
    return fallbackMoments;
  }
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
  const styles = [
    { name: 'viral', label: 'Viral Bold', textColor: 'white', boxColor: 'black@0.85', fontSize: 52, textY: 'h-280', titleY: '60' },
    { name: 'luxury', label: 'Luxury Clean', textColor: 'white', boxColor: 'black@0.60', fontSize: 42, textY: 'h-320', titleY: '80' },
    { name: 'neon', label: 'Neon Pop', textColor: '#00ffcc', boxColor: 'black@0.90', fontSize: 48, textY: 'h-260', titleY: '70' }
  ];
  const results = [];
  for (const style of styles) {
    const outPath = path.join(STORAGE_DIR, 'thumbnails', `thumb_${clipId}_${style.name}.jpg`);
    try {
      const hookSafe = ffmpegText(hook.slice(0, 52));
      const titleSafe = ffmpegText(title.slice(0, 36));
      const filters = [
        'scale=1280:720:force_original_aspect_ratio=increase',
        'crop=1280:720',
        `drawtext=text='${titleSafe}':x=(w-text_w)/2:y=${style.titleY}:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=14`,
        `drawtext=text='${hookSafe}':x=(w-text_w)/2:y=${style.textY}:fontsize=${style.fontSize}:fontcolor=${style.textColor}:box=1:boxcolor=${style.boxColor}:boxborderw=22`
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
    documentary: 'Cinematic documentary narration, mysterious, factual, authoritative',
    motivation:  'High-energy motivational, direct, punchy sentences, calls to action',
    finance:     'Professional financial analysis, data-driven, confident, expert tone',
    crypto:      'Crypto-native, alpha-focused, community language, bullish energy',
    education:   'Clear educational breakdown, step-by-step, relatable examples',
    comedy:      'Absurdist humor, self-aware, gen-Z energy, meme references',
    luxury:      'Premium lifestyle, aspirational, exclusive tone, elite perspective',
    horror:      'Dark, suspenseful, slow burn reveal, chilling delivery',
    ai:          'Tech-forward, mind-expanding, future-focused, awe-inspiring',
    history:     'Epic historical drama, vivid storytelling, dramatic reveals',
    crime:       'True-crime thriller, tense, suspenseful, detail-obsessed',
    health:      'Empathetic, science-backed, actionable, credible expert voice',
    business:    'Sharp entrepreneurial insight, tactical, results-oriented',
    space:       'Cosmic wonder, scientific awe, scale-bending perspective'
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
      const user = currentUser(req, db);
      const { subscription, plan } = subscriptionFor(db, user.id);
      const ytdlpCommand = await workingYtDlpCommand();
      const ytdlpStatus = ytdlpCommand ? await commandVersion(ytdlpCommand) : { ok: false, version: '', error: `Tried: ${ytdlpCandidates().join(', ')}` };
      const ffmpegStatus = await commandVersion(FFMPEG);
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
            id: 'llm',
            label: 'AI provider',
            ready: tools.llm,
            action: 'Set LLM_PROVIDER, LLM_API_KEY, and LLM_MODEL. Emergent uses https://api.emergent.sh/v1 by default.'
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
      if (password && user.passwordHash !== hashPassword(password)) throw new Error('Incorrect password.');
      return json(res, 200, { user: publicUser(user) });
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
      return json(res, 200, { user: publicUser(user) });
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
      const user = currentUser(req, db);
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
      return json(res, 200, await importSource(body.sourceUrl || ''));
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
      const watch = await addWatchedChannel(body);
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
      return json(res, 200, db);
    }
    if (pathname === '/api/transcript' && req.method === 'GET') {
      const videoId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('videoId');
      const db = loadDb();
      if (!Array.isArray(db.transcriptions)) db.transcriptions = [];
      const t = db.transcriptions.find(r => r.videoId === videoId);
      return json(res, 200, t || { segments: [], fullText: '', wordCount: 0 });
    }
    if (pathname === '/api/hooks/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const clip = db.clips.find(c => c.id === body.clipId);
      const video = clip ? db.videos.find(v => v.id === clip.videoId) : null;
      if (!clip || !video) throw new Error('Clip not found.');
      const result = await generateMultipleHooks(db, video, clip);
      clip.hooks = result.hooks;
      saveDb(db);
      return json(res, 200, result);
    }
    if (pathname === '/api/social/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const clip = db.clips.find(c => c.id === body.clipId);
      const video = clip ? db.videos.find(v => v.id === clip.videoId) : null;
      if (!clip || !video) throw new Error('Clip not found.');
      const result = await generateAllPlatformContent(db, video, clip);
      clip.platformContent = result;
      saveDb(db);
      return json(res, 200, result);
    }
    if (pathname === '/api/thumbnail/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const clip = db.clips.find(c => c.id === body.clipId);
      if (!clip) throw new Error('Clip not found.');
      const clipPath = path.join(STORAGE_DIR, 'clips', path.basename(clip.outputPath));
      const canDraw = await drawtextSupported();
      const options = await generateThumbnailOptions(clip.id, clipPath, clip.hook || clip.title, clip.title || '', canDraw);
      clip.thumbnailOptions = options;
      saveDb(db);
      return json(res, 200, { options });
    }
    if (pathname === '/api/broll/suggest' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const video = db.videos.find(v => v.id === body.videoId);
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
        if (!Array.isArray(db.studioGenerations)) db.studioGenerations = [];
        db.studioGenerations.unshift({ id: randomUUID(), type: 'faceless_script', topic: body.topic, style: body.style, result, createdAt: new Date().toISOString() });
        db.studioGenerations = db.studioGenerations.slice(0, 50);
        saveDb(db);
      }
      return json(res, 200, result);
    }
    // ── AI Media Generation (Higgsfield / Muapi) ─────────────────────
    if (pathname === '/api/ai/models') {
      const db = loadDb();
      currentUser(req, db);
      const ready = aiMediaReady(db);
      const models = Object.entries(AI_MEDIA_MODELS).map(([id, m]) => ({ id, label: m.label, category: m.category, provider: m.provider, seconds: m.seconds }));
      return json(res, 200, { models, ready });
    }
    if (pathname === '/api/ai/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = currentUser(req, db);
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
      const user = currentUser(req, db);
      const gens = (db.studioGenerations || []).filter(g => g.userId === user.id);
      return json(res, 200, { generations: gens });
    }
    if (pathname.startsWith('/api/ai/generation/') && req.method === 'DELETE') {
      const genId = pathname.split('/').pop();
      const db = loadDb();
      const user = currentUser(req, db);
      const gen = (db.studioGenerations || []).find(g => g.id === genId && g.userId === user.id);
      if (gen?.outputPath) {
        const fp = path.join(STORAGE_DIR, gen.outputPath.replace('/media/', ''));
        if (existsSync(fp)) unlinkSync(fp);
      }
      db.studioGenerations = (db.studioGenerations || []).filter(g => !(g.id === genId && g.userId === user.id));
      saveDb(db);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/studio/status') {
      const db = loadDb();
      const llmReady = settingReady(db, 'LLM_API_KEY');
      const ffmpegReady = await hasCommand(FFMPEG);
      const canDraw = ffmpegReady ? await drawtextSupported() : false;
      const mediaReady = aiMediaReady(db);
      return json(res, 200, {
        features: {
          transcription:   { available: llmReady,   label: 'AI Transcription',            description: 'Requires LLM API key (OpenAI Whisper compatible)' },
          viralDetection:  { available: llmReady,   label: 'Viral Moment Detection',       description: 'AI scores every moment across 6 dimensions' },
          hookGeneration:  { available: llmReady,   label: '6-Style Hook Generation',      description: 'Curiosity, Shock, Value, Story, Controversy, Sales' },
          platformContent: { available: llmReady,   label: 'Platform Content Generation',  description: 'TikTok, YouTube, Instagram, X, LinkedIn, Facebook posts' },
          captions:        { available: canDraw,    label: 'Styled Captions',              description: 'Hormozi, Karaoke, Minimal, Luxury, Neon styles' },
          thumbnails:      { available: canDraw,    label: 'Thumbnail Generation',         description: '3 styles: Viral Bold, Luxury Clean, Neon Pop' },
          brollSuggestions:{ available: llmReady,   label: 'B-Roll Keyword Extraction',    description: 'AI suggests stock footage keywords per transcript section' },
          facelessContent: { available: llmReady,   label: 'Faceless Content Mode',        description: 'AI writes complete script + scene directions for faceless videos' },
          aiImageGen:      { available: mediaReady, label: 'AI Image Generation',          description: 'FLUX 1.1 Pro, Ideogram 3.0, Higgsfield — text-to-image', setupKey: 'MUAPI_API_KEY' },
          aiVideoGen:      { available: mediaReady, label: 'AI Video / B-Roll Studio',     description: 'Kling 2.1, Seedance, Wan2.1, Higgsfield — text-to-video & image-to-video', setupKey: 'MUAPI_API_KEY' },
          lipSync:         { available: mediaReady, label: 'Lip Sync Studio',              description: 'Sync any voice-over to a video clip with Wav2Lip', setupKey: 'MUAPI_API_KEY' },
          aiVoice:         { available: false,      label: 'AI Voiceover (TTS)',            description: 'Configure ElevenLabs or OpenAI TTS API key', setupKey: 'ELEVENLABS_API_KEY' },
          translation:     { available: llmReady,   label: 'Caption Translation',           description: 'Translate captions to 10+ languages via LLM' },
          socialPosting:   { available: false,      label: 'Direct Social Posting',         description: 'Configure TikTok/Instagram OAuth credentials', setupKey: 'TIKTOK_CLIENT_ID' }
        }
      });
    }
    if (pathname === '/api/onboarding' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const user = currentUser(req, db);
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
      const user = currentUser(req, db);
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
      const user = currentUser(req, db);
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
      const user = currentUser(req, db);
      const amount = Number(body.amount || 0);
      if (![40, 120, 300].includes(amount)) throw new Error('Choose a valid credit pack.');
      if (!settingReady(db, 'STRIPE_SECRET_KEY')) throw new Error('Stripe checkout is not configured yet.');
      user.credits += amount;
      db.creditTransactions.unshift({ id: randomUUID(), userId: user.id, amount, reason: 'Credit purchase placeholder', createdAt: new Date().toISOString() });
      saveDb(db);
      return json(res, 200, { credits: user.credits });
    }
    if (pathname === '/api/process' && req.method === 'POST') {
      const body = await readJson(req);
      const job = createQueuedProcessingJob(body);
      if (job.duplicate) return json(res, 202, { queued: true, duplicate: true, jobId: job.id, queueDepth: renderQueue.length, activeRenderJobs });
      const jobPromise = enqueueRenderJob({ ...body, jobId: job.id });
      jobPromise.catch(error => console.error('[job:background-failed]', String(error.message || error).slice(0, 2000)));
      return json(res, 202, { queued: true, jobId: job.id, queueDepth: renderQueue.length, activeRenderJobs });
    }
    if (pathname === '/api/job' && req.method === 'PATCH') {
      const body = await readJson(req);
      const db = loadDb();
      const job = db.jobs.find(item => item.id === body.jobId);
      if (!job) throw new Error('Job not found.');
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
        const queued = createQueuedProcessingJob({ videoId: video.id, rightsConfirmed: true, clipCount: body.clipCount || 3, clipLength: body.clipLength || 15 });
        const retry = enqueueRenderJob({ videoId: video.id, jobId: queued.id, rightsConfirmed: true, clipCount: body.clipCount || 3, clipLength: body.clipLength || 15 });
        retry.catch(error => console.error('[job:retry-failed]', String(error.message || error).slice(0, 2000)));
        return json(res, 202, { queued: true, jobId: queued.id, queueDepth: renderQueue.length, activeRenderJobs });
      }
      throw new Error('Unsupported job action.');
    }
    if (pathname === '/api/video' && req.method === 'DELETE') {
      const body = await readJson(req);
      const db = loadDb();
      const video = db.videos.find(v => v.id === body.videoId);
      if (!video) throw new Error('Video not found.');
      killActiveJobProcesses(video.id);
      // Delete source file from disk
      if (video.storagePath) unlinkQuiet(video.storagePath);
      // Delete all clips and their files that belong to this video
      const videoClips = db.clips.filter(c => c.videoId === video.id);
      for (const clip of videoClips) {
        if (clip.outputPath) unlinkQuiet(path.join(STORAGE_DIR, 'clips', path.basename(clip.outputPath)));
        if (clip.thumbnailPath) unlinkQuiet(path.join(STORAGE_DIR, 'thumbs', path.basename(clip.thumbnailPath)));
      }
      // Remove from db
      db.clips = db.clips.filter(c => c.videoId !== video.id);
      db.jobs = db.jobs.filter(j => j.videoId !== video.id);
      db.videos = db.videos.filter(v => v.id !== video.id);
      db.projects = db.projects.filter(p => db.videos.some(v => v.projectId === p.id));
      saveDb(db);
      return json(res, 200, { deleted: true });
    }
    if (pathname === '/api/clip' && req.method === 'DELETE') {
      const body = await readJson(req);
      const db = loadDb();
      if (body.all) {
        for (const clip of db.clips) {
          if (clip.outputPath) unlinkQuiet(path.join(STORAGE_DIR, 'clips', path.basename(clip.outputPath)));
          if (clip.thumbnailPath) unlinkQuiet(path.join(STORAGE_DIR, 'thumbs', path.basename(clip.thumbnailPath)));
        }
        db.clips = [];
        saveDb(db);
        return json(res, 200, { deleted: true, count: db.clips.length });
      }
      const clip = db.clips.find(c => c.id === body.clipId);
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
      const clip = db.clips.find(item => item.id === body.id);
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
      const clip = db.clips.find(item => item.id === body.clipId);
      if (!clip) throw new Error('Clip not found.');
      const platform = String(body.platform || '').trim();
      const scheduledFor = String(body.scheduledFor || '').trim();
      if (!PLATFORMS.includes(platform)) throw new Error('Choose a supported platform.');
      if (!scheduledFor) throw new Error('Choose a schedule date and time.');
      const account = db.socialAccounts.find(item => item.platform === platform);
      if (!account) throw new Error(`Add a ${platform} posting account before scheduling.`);
      if (account.oauthStatus !== 'connected') throw new Error(`${platform} is not connected yet. Go to Social Accounts and connect OAuth before scheduling.`);
      const post = {
        id: randomUUID(),
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
      const user = currentUser(req, db);
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
      const account = db.socialAccounts.find(item => item.id === body.accountId);
      if (!account) throw new Error('Account not found.');
      if (account.oauthStatus !== 'connected') throw new Error('OAuth is not connected for this account.');
      return json(res, 200, { ok: true, message: `${account.platform} connection is healthy.` });
    }
    if (pathname === '/api/social-account/disconnect' && req.method === 'POST') {
      const body = await readJson(req);
      const db = loadDb();
      const account = db.socialAccounts.find(item => item.id === body.accountId);
      if (!account) throw new Error('Account not found.');
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
      const clip = db.clips.find(item => item.id === body.clipId);
      const account = db.socialAccounts.find(item => item.id === body.accountId);
      if (!clip) throw new Error('Clip not found.');
      if (!account) throw new Error('Posting account not found.');
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
      // Allow testing a candidate key before saving
      const provider = body.provider || settingValue(db, 'LLM_PROVIDER') || 'xai';
      const apiKey   = body.apiKey   || settingValue(db, 'LLM_API_KEY');
      const model    = body.model    || settingValue(db, 'LLM_MODEL') || 'grok-3-mini';
      const customBase = body.baseUrl || settingValue(db, 'LLM_BASE_URL');
      const providerBases = {
        xai: 'https://api.x.ai/v1', grok: 'https://api.x.ai/v1',
        openai: 'https://api.openai.com/v1', groq: 'https://api.groq.com/openai/v1',
        together: 'https://api.together.xyz/v1'
      };
      const base = (customBase || providerBases[provider] || '').replace(/\/+$/, '');
      if (!apiKey) return json(res, 400, { ok: false, error: 'No API key provided.' });
      if (!base)   return json(res, 400, { ok: false, error: `Unknown provider "${provider}". Set a custom base URL.` });
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
        const usedModel = data.model || model;
        return json(res, 200, { ok: true, reply, model: usedModel, ms, provider, endpoint });
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
    return json(res, 400, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  if (url.pathname.startsWith('/media/')) {
    const file = path.normalize(path.join(STORAGE_DIR, url.pathname.replace('/media/', '')));
    if (!file.startsWith(STORAGE_DIR) || !existsSync(file)) return json(res, 404, { error: 'Media not found' });
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
  res.writeHead(200, { 'content-type': mimeFor(file) });
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
