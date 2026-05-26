import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'originals'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'clips'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'uploads'), { recursive: true });
mkdirSync(path.join(STORAGE_DIR, 'thumbs'), { recursive: true });

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
  usageEvents: []
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
    const parts = String(command).trim().split(/\s+/).filter(Boolean);
    const executable = parts.shift();
    if (!executable) return reject(new Error('No command provided.'));
    const child = spawn(executable, [...parts, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${command} exited with ${code}`));
    });
  });
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

async function commandVersion(command) {
  try {
    const { stdout, stderr } = await run(command, command === FFMPEG ? ['-version'] : ['--version']);
    return { ok: true, version: (stdout || stderr).split(/\r?\n/)[0] || 'installed' };
  } catch (error) {
    return { ok: false, version: '', error: error.message };
  }
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
  const args = ['--dump-single-json', '--skip-download', '--no-warnings', '--ignore-no-formats-error', '--playlist-end', '12', source];
  importLog('log', 'yt-dlp metadata fallback started', { source, command: ytdlpCommand });
  const { stdout, stderr } = await run(ytdlpCommand, args);
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

function parseMultipart(req, buffer) {
  const type = req.headers['content-type'] || '';
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw new Error('Upload request is missing multipart boundary.');
  const body = buffer.toString('binary');
  const parts = body.split(`--${boundary}`);
  const fields = {};
  const files = [];
  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const [rawHeaders, rawContent = ''] = part.split('\r\n\r\n');
    const name = rawHeaders.match(/name="([^"]+)"/)?.[1];
    const filename = rawHeaders.match(/filename="([^"]*)"/)?.[1];
    const mimeType = rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || 'application/octet-stream';
    const content = rawContent.replace(/\r\n$/, '');
    if (!name) continue;
    if (filename) files.push({ field: name, filename, mimeType, buffer: Buffer.from(content, 'binary') });
    else fields[name] = Buffer.from(content, 'binary').toString('utf8');
  }
  return { fields, files };
}

async function readMultipart(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return parseMultipart(req, Buffer.concat(chunks));
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
    await run(FFMPEG, ['-y', '-ss', '1', '-i', filePath, '-frames:v', '1', '-q:v', '3', output]);
    return `/media/thumbs/${uploadId}.jpg`;
  } catch (error) {
    importLog('warn', 'thumbnail generation failed', { error: error.message });
    return '';
  }
}

async function importUploadedVideo(req) {
  const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 500 * 1024 * 1024);
  const { fields, files } = await readMultipart(req);
  const file = files.find(item => item.field === 'video') || files[0];
  if (!file) throw new Error('No video file was uploaded.');
  if (file.buffer.length > maxBytes) throw new Error('File too large. Upload a smaller video file.');
  const ext = path.extname(file.filename || '').toLowerCase();
  const allowed = new Set(['.mp4', '.mov', '.webm', '.m4v']);
  if (!allowed.has(ext)) throw new Error('Unsupported file type. Upload mp4, mov, webm, or m4v.');
  const uploadId = randomUUID();
  const storedName = `${uploadId}${ext}`;
  const uploadPath = path.join(STORAGE_DIR, 'uploads', storedName);
  writeFileSync(uploadPath, file.buffer);
  const probe = await probeMedia(uploadPath);
  const thumbnailUrl = await thumbnailForUpload(uploadPath, uploadId);
  const title = fields.title || file.filename.replace(/\.[^.]+$/, '') || 'Uploaded video';
  const video = classifyVideoForImport({
    youtubeId: `upload_${uploadId}`,
    url: `/media/uploads/${storedName}`,
    title,
    channelTitle: 'Uploaded file',
    durationSeconds: Math.round(probe.durationSeconds || 0),
    viewCount: 0,
    publishedAt: new Date().toISOString(),
    thumbnailUrl,
    isShort: Number(probe.durationSeconds || 0) <= 90,
    sourceKind: 'upload',
    storagePath: uploadPath,
    originalFilename: file.filename,
    mimeType: file.mimeType,
    status: 'imported'
  }, { source: 'upload' }).video;
  const db = loadDb();
  const result = addImportedVideos(db, 'upload', 'upload', [video]);
  saveDb(db);
  return { ...result, source: 'upload', warnings: [], canonicalUrl: 'upload' };
}

function queueBackgroundProcess(videoId, options) {
  setTimeout(async () => {
    try {
      await processVideo({ videoId, ...options });
    } catch {
      // processVideo records the failed job; the watcher keeps running.
    }
  }, 10);
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

async function downloadVideo(video) {
  const ytdlpCommand = await workingYtDlpCommand();
  if (!ytdlpCommand) throw new Error('yt-dlp is required to download owned or permissioned source videos.');
  const output = path.join(STORAGE_DIR, 'originals', `${video.youtubeId}.%(ext)s`);
  await run(ytdlpCommand, ['-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4', '-o', output, video.url]);
  const files = await readdir(path.join(STORAGE_DIR, 'originals'));
  const found = files.find(file => file.startsWith(video.youtubeId) && file.endsWith('.mp4'));
  if (!found) throw new Error('yt-dlp completed but no mp4 output was found.');
  return path.join(STORAGE_DIR, 'originals', found);
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
      await run(ytdlpCommand, ['--skip-download', '--write-auto-subs', '--sub-lang', 'en', '--sub-format', 'json3', '-o', path.join(STORAGE_DIR, 'originals', `${video.youtubeId}.%(ext)s`), video.url]);
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

function scoreMoments(segments, durationSeconds) {
  const hotWords = ['secret', 'mistake', 'truth', 'money', 'growth', 'viral', 'failed', 'winner', 'risk', 'never', 'best', 'worst', 'proof'];
  const windows = [];
  for (let i = 0; i < segments.length; i += 1) {
    const start = segments[i].start;
    const endLimit = Math.min(start + 60, durationSeconds || start + 60);
    const group = [];
    for (let j = i; j < segments.length && segments[j].end <= endLimit; j += 1) group.push(segments[j]);
    const end = group.at(-1)?.end || start + 30;
    if (end - start < 15 || end - start > 60) continue;
    const text = group.map(seg => seg.text).join(' ');
    const wordCount = text.split(/\s+/).length;
    const hotScore = hotWords.reduce((sum, word) => sum + (text.toLowerCase().includes(word) ? 12 : 0), 0);
    const punctuation = (text.match(/[?!]/g) || []).length * 6;
    const density = Math.min(30, Math.round(wordCount / Math.max(1, end - start) * 12));
    windows.push({
      start,
      end,
      score: Math.min(98, 35 + hotScore + punctuation + density),
      text
    });
  }
  return windows
    .sort((a, b) => b.score - a.score)
    .filter((candidate, index, all) => all.findIndex(other => Math.abs(other.start - candidate.start) < 20) === index)
    .slice(0, 5);
}

function buildCaptionText(text) {
  return text
    .split(/\s+/)
    .slice(0, 22)
    .join(' ')
    .replace(/'/g, "\\'");
}

function ffmpegText(value = '') {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

async function renderClip(db, video, mediaPath, moment, index) {
  if (!(await hasCommand(FFMPEG))) throw new Error('FFmpeg is required to render 9:16 clips.');
  const clipId = randomUUID();
  const output = path.join(STORAGE_DIR, 'clips', `${clipId}.mp4`);
  const title = `${video.title}`.slice(0, 42).replace(/:/g, ' ');
  const hook = (moment.hook || buildCaptionText(moment.text)).slice(0, 96);
  const intelligence = buildViralIntelligence(video, moment, hook, index);
  const renderSegments = (intelligence.smartEditPlan?.segments || [{ start: moment.start, end: moment.end }])
    .filter(segment => Number(segment.end) - Number(segment.start) > 1)
    .slice(0, 3);
  const visualFilters = [
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920",
    "setsar=1",
    `drawtext=text='${ffmpegText(title)}':x=(w-text_w)/2:y=140:fontsize=58:fontcolor=white:box=1:boxcolor=black@0.48:boxborderw=24`,
    `drawtext=text='${ffmpegText(hook)}':x=(w-text_w)/2:y=h-360:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.58:boxborderw=22:enable='between(t,0,${Math.min(8, moment.end - moment.start)})'`
  ].join(',');
  if (renderSegments.length > 1) {
    const trims = renderSegments.map((segment, i) => [
      `[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${i}]`,
      `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${i}]`
    ].join(';')).join(';');
    const concatInputs = renderSegments.map((_, i) => `[v${i}][a${i}]`).join('');
    const filterComplex = `${trims};${concatInputs}concat=n=${renderSegments.length}:v=1:a=1[cv][ca];[cv]${visualFilters}[outv]`;
    await run(FFMPEG, ['-y', '-i', mediaPath, '-filter_complex', filterComplex, '-map', '[outv]', '-map', '[ca]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', output]);
  } else {
    await run(FFMPEG, ['-y', '-ss', String(moment.start), '-to', String(moment.end), '-i', mediaPath, '-vf', visualFilters, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', output]);
  }
  return {
    id: clipId,
    title: `${title} #${index + 1}`,
    hook,
    startSeconds: moment.start,
    endSeconds: moment.end,
    score: moment.score,
    rationale: moment.rationale || 'High-density transcript window with hook language and clean 15-60 second duration.',
    reason: moment.reason || 'educational',
    transcriptExcerpt: moment.text.slice(0, 420),
    outputPath: `/media/clips/${clipId}.mp4`,
    thumbnailPath: '',
    platform: 'universal',
    postCaption: `${hook}\n\nDesigned for TikTok, Reels, Shorts, and Facebook Reels.`,
    hashtags: ['#shorts', '#reels', '#tiktok', '#creator'],
    postingAssistant: await generatePostingAssistant(db, video, { ...moment, hook }, 'TikTok'),
    transformation: defaultTransformation(title),
    intelligence
  };
}

function fallbackMomentsForVideo(video) {
  const duration = Math.max(5, Number(video.durationSeconds || 30));
  const count = duration < 20 ? 1 : Math.min(3, Math.max(1, Math.floor(duration / 20)));
  return Array.from({ length: count }).map((_, index) => {
    const segmentLength = Math.min(60, Math.max(5, Math.floor(duration / count)));
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

function processingSteps(stage, progress) {
  const steps = ['Queued', 'Downloading', 'Clipping', 'Captioning', 'Rendering', 'Completed'];
  const stageText = String(stage || '').toLowerCase();
  let active = 0;
  if (stageText.includes('download')) active = 1;
  else if (stageText.includes('clip') || stageText.includes('viral') || stageText.includes('vertical')) active = 2;
  else if (stageText.includes('caption') || stageText.includes('transcrib')) active = 3;
  else if (stageText.includes('render')) active = 4;
  else if (stageText.includes('complete') || stageText.includes('ready') || progress >= 100) active = 5;
  return steps.map((label, index) => ({
    label,
    status: progress >= 100 || index < active ? 'complete' : index === active ? 'active' : 'waiting'
  }));
}

async function processVideo(payload) {
  const { videoId, rightsConfirmed, fairUseMode, transformationNote } = payload;
  if (!rightsConfirmed) throw new Error('Confirm that you own this video or have permission to reuse it before processing.');
  if (fairUseMode && !String(transformationNote || '').trim()) {
    throw new Error('Fair-use/remix mode requires a commentary, reaction, education, or transformation note.');
  }
  const db = loadDb();
  const user = db.users[0];
  const video = db.videos.find(item => item.id === videoId);
  if (!video) throw new Error('Video not found.');
  if (CREDITS_ENABLED && user.credits < CLIP_JOB_CREDIT_COST) throw new Error(`Not enough credits. Each video job uses ${CLIP_JOB_CREDIT_COST} credits.`);
  video.rightsConfirmed = true;
  video.fairUseMode = Boolean(fairUseMode);
  video.transformationNote = transformationNote || '';
  video.status = 'queued';
  if (CREDITS_ENABLED) {
    user.credits -= CLIP_JOB_CREDIT_COST;
    db.creditTransactions.unshift({ id: randomUUID(), userId: user.id, amount: -CLIP_JOB_CREDIT_COST, reason: `Clip job for ${video.title}`, createdAt: new Date().toISOString() });
  }
  const job = {
    id: randomUUID(),
    userId: user.id,
    videoId,
    status: 'running',
    progress: 5,
    stage: 'downloading',
    steps: processingSteps('downloading', 5),
    error: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.jobs.unshift(job);
  saveDb(db);
  try {
    const ytdlpReady = Boolean(await workingYtDlpCommand());
    const ffmpegReady = await hasCommand(FFMPEG);
    if (!ytdlpReady && video.sourceKind !== 'upload') throw new Error('Download blocked: yt-dlp is not available on this server. Use file upload or redeploy with Docker media tools.');
    if (!ffmpegReady) throw new Error('FFmpeg failed: FFmpeg is not available on this server, so clips cannot be rendered.');
    const mediaPath = video.sourceKind === 'upload' ? video.storagePath : await downloadVideo(video);
    updateJob(job.id, { progress: 30, stage: 'transcribing', steps: processingSteps('transcribing', 30) });
    let transcript = [];
    try {
      transcript = video.sourceKind === 'upload' ? [] : await getTranscript(video, mediaPath);
    } catch (error) {
      updateJob(job.id, { progress: 44, stage: 'no transcript: using visual edit fallback', steps: processingSteps('transcribing', 44) });
    }
    updateJob(job.id, { progress: 58, stage: 'finding viral moments', steps: processingSteps('viral', 58) });
    const moments = transcript.length ? await detectViralMoments(db, video, transcript) : fallbackMomentsForVideo(video);
    if (!moments.length) throw new Error('Could not create a clipping window for this video.');
    updateJob(job.id, { progress: 72, stage: 'creating vertical clips', steps: processingSteps('vertical', 72) });
    const rendered = [];
    for (let i = 0; i < moments.length; i += 1) rendered.push(await renderClip(db, video, mediaPath, moments[i], i));
    completeJobWithClips(job.id, video.id, rendered);
    return { jobId: job.id };
  } catch (error) {
    updateJob(job.id, { status: 'failed', progress: 100, stage: 'failed', error: error.message });
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
  const provider = settingValue(db, `${prefix}PROVIDER`) || (fallback ? '' : 'openai');
  const apiKey = settingValue(db, `${prefix}API_KEY`);
  const customBaseUrl = settingValue(db, `${prefix}BASE_URL`);
  const providerDefaults = {
    emergent: 'https://api.emergent.sh/v1',
    openai: 'https://api.openai.com/v1'
  };
  const baseUrl = customBaseUrl ? normalizeOpenAiBaseUrl(customBaseUrl) : (providerDefaults[provider] || '');
  const model = settingValue(db, `${prefix}MODEL`) || 'gpt-4o-mini';
  return { provider, apiKey, baseUrl, model, customBaseUrl: Boolean(customBaseUrl) };
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
          body: JSON.stringify(body)
        });
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
        lastError = error;
        recordAiLog({ ...config, baseUrl: endpoint, purpose, ok: false, error: error.message });
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

async function detectViralMoments(db, video, segments) {
  const fallbackMoments = scoreMoments(segments, video.durationSeconds);
  const transcript = segments.map(seg => `[${Math.round(seg.start)}-${Math.round(seg.end)}] ${seg.text}`).join('\n').slice(0, 16000);
  try {
    const result = await aiChat(db, {
      purpose: 'viral moment detection',
      messages: [
        { role: 'system', content: 'You find short-form viral moments from transcripts. Return only JSON.' },
        { role: 'user', content: `Video title: ${video.title}\nDuration seconds: ${video.durationSeconds || 0}\n\nTranscript:\n${transcript}\n\nReturn {"moments":[{"start":number,"end":number,"score":number,"reason":"funny|educational|controversial|emotional|surprising|actionable","hook":"short hook","rationale":"why this clip works"}]}. Each moment must be 15 to 60 seconds.` }
      ]
    });
    const parsed = extractJsonObject(result.content);
    const moments = (parsed?.moments || [])
      .map(item => {
        const start = Math.max(0, Number(item.start || 0));
        const end = Math.min(Number(video.durationSeconds || start + 60), Number(item.end || start + 45));
        const text = segments.filter(seg => seg.end >= start && seg.start <= end).map(seg => seg.text).join(' ');
        return {
          start,
          end,
          score: Math.max(1, Math.min(100, Number(item.score || 75))),
          reason: item.reason || 'educational',
          hook: item.hook || buildCaptionText(text),
          rationale: item.rationale || 'AI-selected transcript window with short-form potential.',
          text: text || item.hook || video.title
        };
      })
      .filter(item => item.end - item.start >= 15 && item.end - item.start <= 60)
      .slice(0, 5);
    return moments.length ? moments : fallbackMoments;
  } catch {
    return fallbackMoments;
  }
}

async function generatePostingAssistant(db, video, moment, platform = 'TikTok') {
  const fallback = postingAssistant(video.title, moment.hook || buildCaptionText(moment.text || video.title), platform);
  try {
    const result = await aiChat(db, {
      purpose: 'posting guide generation',
      messages: [
        { role: 'system', content: 'You generate ready-to-post short video metadata and manual upload guidance. Return only JSON.' },
        { role: 'user', content: `Video title: ${video.title}\nClip hook: ${moment.hook || ''}\nClip reason: ${moment.reason || ''}\nTranscript excerpt: ${(moment.text || '').slice(0, 1200)}\nPlatforms: ${PLATFORMS.join(', ')}\n\nReturn {"suggestedTitle":"","caption":"","hashtags":[""],"bestPlatform":"","bestTime":"","firstComment":"","instructions":{"TikTok":[""],"Instagram Reels":[""],"Facebook Reels":[""],"YouTube Shorts":[""],"X":[""]}}.` }
      ]
    });
    const parsed = extractJsonObject(result.content) || {};
    return {
      ...fallback,
      suggestedTitle: parsed.suggestedTitle || fallback.suggestedTitle,
      caption: parsed.caption || fallback.caption,
      hashtags: Array.isArray(parsed.hashtags) && parsed.hashtags.length ? parsed.hashtags.slice(0, 12) : fallback.hashtags,
      bestPlatform: parsed.bestPlatform || fallback.bestPlatform,
      bestTime: parsed.bestTime || fallback.bestTime,
      firstComment: parsed.firstComment || fallback.firstComment,
      instructions: parsed.instructions || fallback.instructions
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
        postgres: settingReady(db, 'DATABASE_URL')
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
      const db = loadDb();
      if (!Array.isArray(db.scheduledPosts)) db.scheduledPosts = [];
      if (!Array.isArray(db.socialAccounts)) db.socialAccounts = [];
      return json(res, 200, db);
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
      const result = await processVideo(body);
      return json(res, 200, result);
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
  pollDueWatchedChannels().catch(() => {});
  setInterval(() => pollDueWatchedChannels().catch(() => {}), Number(process.env.WATCH_INTERVAL_MINUTES || 15) * 60 * 1000);
});
