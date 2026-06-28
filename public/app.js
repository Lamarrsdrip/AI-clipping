/* ── ClipForge AI — 2026 Content Repurposing Studio ─────────────── */

/* ── Toast notifications ─────────────────────────────────────────── */
function showToast(msg, type='ok', duration=4000) {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('visible'), 10);
  setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 300); }, duration);
}
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function updateWmHint(val) {
  const h = document.getElementById('bkWmHint');
  if (!h) return;
  const v = (val||'').trim();
  if (!v) { h.textContent = ''; return; }
  if (v.startsWith('@'))
    h.textContent = '✓ Social handle detected — bottom-right, clean white style';
  else if (/\.(com|net|org|io|co|tv|me|app|ai|gg|xyz)(\b|\/|$)/i.test(v))
    h.textContent = '✓ Website detected — bottom-center, subtle minimal style';
  else if (v === v.toUpperCase() && /[A-Z]/.test(v) && v.replace(/\s/g,'').length <= 10)
    h.textContent = '✓ Brand name detected — top-right, bold prominent style';
  else if (v.replace(/\s/g,'').length <= 8)
    h.textContent = '✓ Short brand name — top-right, clean style, auto-uppercased';
  else
    h.textContent = '✓ Brand name — top-right, dark pill background for readability';
}
const fmt = n => Number(n) >= 1e6 ? (n/1e6).toFixed(1)+'M' : Number(n) >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n||0);
const dur = s => { const n=Number(s||0); if(!n) return '--'; const m=Math.floor(n/60); return m>0?`${m}m ${n%60|0}s`:`${n|0}s`; };
const when = d => { if(!d) return ''; const ms=Date.now()-new Date(d).getTime(); const m=Math.floor(ms/60000); return m<1?'just now':m<60?`${m}m ago`:m<1440?`${Math.floor(m/60)}h ago`:`${Math.floor(m/1440)}d ago`; };
function uid() { return localStorage.getItem('clipforge:userId') || ''; }
function api(path, opts = {}) {
  return fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-user-id': uid(), ...(opts.headers || {}) } })
    .then(r => r.text().then(text => {
      let d;
      try { d = JSON.parse(text); } catch {
        // Non-JSON response — Cloudflare timeout, server crash, or HTML error page
        if (r.status === 524 || r.status === 503 || r.status === 502) throw new Error('Server is temporarily unavailable. Please try again in a moment.');
        throw new Error('Service temporarily unavailable. Please try again.');
      }
      if (d.error) throw new Error(d.error);
      return d;
    }));
}
function empty(msg) { return `<div class="empty-state"><div class="empty-icon">✦</div><p>${esc(msg)}</p></div>`; }
function pill(label, cls='') { return `<span class="pill ${cls}">${esc(label)}</span>`; }
function scoreColor(n) { return n>=85?'ok':n>=70?'warn':''; }

/* ── Path helper: convert absolute filesystem path → /media/… URL ─── */
function clipUrl(outputPath) {
  if (!outputPath) return '';
  // If it's already a relative/absolute URL (starts with / but not /Users)
  if (outputPath.startsWith('/') && !outputPath.startsWith('/Users')) return outputPath;
  // Extract everything after 'storage/'
  const idx = outputPath.indexOf('storage/');
  if (idx !== -1) return '/media/' + outputPath.slice(idx + 'storage/'.length);
  // Fallback: just use the filename
  const filename = outputPath.split('/').pop();
  return `/media/clips/${filename}`;
}

const PLATFORMS = ['TikTok','YouTube Shorts','Instagram Reels','X','LinkedIn','Facebook'];
const CAPTION_STYLES = ['viral','hormozi','hype','mrbeast','tiktok','reels','fire','neon','karaoke','bold','podcast','minimal','luxury','finance','cinema','faceless','kids'];
const CAPTION_STYLE_LABELS = {
  viral:'Viral',hormozi:'Hormozi',hype:'Hype',mrbeast:'MrBeast',tiktok:'TikTok',
  reels:'Reels',fire:'Fire',neon:'Neon',karaoke:'Karaoke',bold:'Bold',
  podcast:'Podcast',minimal:'Minimal',luxury:'Luxury',finance:'Finance',
  cinema:'Cinema',faceless:'Faceless',kids:'Kids'
};
const FACELESS_STYLES = ['documentary','motivation','finance','crypto','education','comedy','luxury','horror','ai','history','crime','health','business','space','reddit','kids','news','wellness','sports','travel','relationship'];
const HOOK_LABELS = { curiosity:'Curiosity','shock':'Shock','value':'Value','story':'Story','controversy':'Controversy','sales':'Sales' };

const state = {
  authMode: 'login',
  view: 'home',
  library: { videos:[], clips:[], jobs:[], transcriptions:[], studioGenerations:[] },
  session: null,
  clip: null,
  importing: false,
  importUrl: '',
  importStatus: null,
  uploadProgress: 0,
  activeVideoIds: null,
  selected: new Set(),
  studioTab: 'aiVideoGen',
  facelessStyle: 'documentary',
  facelessTopic: '',
  facelessResult: null,
  facelessLoading: false,
  // Dedicated faceless page state
  fl: {
    topic: '', style: 'documentary', duration: 45,
    tone: 'mysterious', language: 'English', platform: 'TikTok',
    hookStrength: 8, audienceType: 'general', ctaType: 'follow',
    storytellingMode: 'revelation', result: null, loading: false
  },
  studioStatus: null,
  studioModels: [],
  generatorMode: 't2v',
  generatorModel: 't2v-kling-5-1',
  generatorPrompt: '',
  generatorNeg: '',
  generatorImageUrl: '',
  generatorClipId: '',
  generatorRunning: false,
  generatorResult: null,
  generations: [],
  transcriptVideoId: null,
  platformTab: 'tiktok',
  hookTab: 'curiosity',
  thumbTab: 0,
  // Clips library state
  clipsSearch: '',
  clipsSort: 'newest',
  clipsBulkSelected: new Set(),
  openMenuClipId: null,
  // Framing mode for new clips
  framingMode: 'dynamic',
  clipLength: 60,
  // Brand kit state
  brandKits: [],
  activeBrandKitId: null,
  brandKitTab: 'list',          // 'list' | 'edit'
  editingBrandKit: null,        // kit being edited
  brandKitSaving: false,
  // TTS studio state
  ttsText: '',
  ttsVoiceId: '',
  ttsVoices: [],
  ttsLoading: false,
  ttsResult: null,
};

/* ── Clip helpers ────────────────────────────────────────────────── */
function clipTitle(c) {
  const hook = c.hook || '';
  // Use hook if it reads like a title (not too long, not starting with quotes/pronouns)
  if (hook && hook.length <= 72) return hook;
  if (hook) return hook.slice(0, 68) + '…';
  return c.title || 'Untitled clip';
}

function scoreChip(score) {
  const n = Number(score || 0);
  const cls = n >= 90 ? 'clip-score-green' : n >= 80 ? 'clip-score-blue' : n >= 70 ? 'clip-score-amber' : 'clip-score-red';
  return `<div class="clip-score-chip ${cls}">${n}<span>/100</span></div>`;
}

function platformBadge(platform) {
  const p = platform || 'TikTok';
  const short = p.replace('YouTube ','').replace('Instagram ','');
  return `<span class="clip-platform-badge">${esc(short)}</span>`;
}

function statusBadge(status) {
  const s = status || 'ready';
  const dot = `<span class="clip-status-dot"></span>`;
  const labels = { ready:'Ready', queued:'Queued', running:'Processing', failed:'Failed', published:'Published' };
  return `<span class="clip-status ${s}">${dot}${labels[s] || s}</span>`;
}

/* ── Clip Modal ──────────────────────────────────────────────────── */
function openClipModal(clipId) {
  const c = (state.library.clips || []).find(x => x.id === clipId);
  if (!c) return;
  const dur2 = Math.round((c.endSeconds || 0) - (c.startSeconds || 0));
  const url = clipUrl(c.outputPath);
  const title = clipTitle(c);
  const score = Number(c.score || 0);
  const hook = c.hookStrength ? Math.round(c.hookStrength * 10) : score;
  const viral = c.emotionalPunch ? Math.round(c.emotionalPunch * 10) : Math.round(score * 0.9);
  const share = c.shareability ? Math.round(c.shareability * 10) : Math.round(score * 0.85);

  let modal = document.getElementById('globalClipModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'globalClipModal';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="clip-modal-overlay" id="clipModalOverlay">
      <div class="clip-modal">
        <div class="clip-modal-video-col">
          <video id="modalVideoEl" src="${esc(url)}" controls autoplay playsinline
            poster="${esc(c.thumbnailPath || '')}"
            style="width:100%;height:100%;object-fit:contain;display:block">
          </video>
        </div>
        <div class="clip-modal-info">
          <div class="clip-modal-header">
            <h2>${esc(title)}</h2>
            <button class="clip-modal-close" id="closeClipModalBtn">✕</button>
          </div>
          <div class="clip-modal-score">
            <div>
              <div class="modal-score-num">${score}</div>
              <div class="modal-score-label">AI Score</div>
            </div>
            <div class="modal-score-breakdown">
              <div class="modal-score-item"><small>🔥 Hook</small><b>${hook}%</b></div>
              <div class="modal-score-item"><small>❤️ Viral</small><b>${viral}%</b></div>
              <div class="modal-score-item"><small>📤 Share</small><b>${share}%</b></div>
              <div class="modal-score-item"><small>⏱ Duration</small><b>${dur2}s</b></div>
            </div>
          </div>
          <div>
            <div class="meta" style="margin-bottom:10px">
              <span>${esc(c.bestPlatform || 'TikTok')}</span>
              <span>Style: ${esc(c.captionStyle || 'bold')}</span>
              <span>${when(c.createdAt)}</span>
            </div>
            ${c.rationale ? `<p style="font-size:.83rem;line-height:1.6;color:var(--muted)">${esc(c.rationale)}</p>` : ''}
          </div>
          <div class="clip-modal-actions">
            <a href="${esc(url)}" download="clip-${c.id}.mp4" class="button" style="text-align:center">⬇ Download</a>
            <button class="ghost" data-copy="${encodeURIComponent(c.hook || title)}" onclick="showToast('Caption copied','ok',2000)">Copy caption</button>
            <button class="ghost" data-open-clip="${c.id}" onclick="closeClipModal()">Full detail →</button>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('clipModalOverlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('clipModalOverlay')) closeClipModal();
  });
  document.getElementById('closeClipModalBtn')?.addEventListener('click', closeClipModal);
  document.addEventListener('keydown', _modalEscHandler);
}

function _modalEscHandler(e) {
  if (e.key === 'Escape') { closeClipModal(); document.removeEventListener('keydown', _modalEscHandler); }
}

function closeClipModal() {
  const modal = document.getElementById('globalClipModal');
  if (modal) {
    const vid = document.getElementById('modalVideoEl');
    if (vid) { vid.pause(); vid.src = ''; }
    modal.innerHTML = '';
  }
}

/* ── Nav (4 core items — clean on mobile) ────────────────────────── */
const NAV = [
  { id:'home',     icon:'⌂', label:'Home'     },
  { id:'create',   icon:'✦', label:'Create'   },
  { id:'clips',    icon:'▶', label:'Clips'    },
  { id:'faceless', icon:'◈', label:'Faceless' },
];

const MENU_ITEMS = [
  { id:'digitalHuman', icon:'🧑', label:'Digital Human Studio', desc:'AI twin & synthetic human video generation' },
  { id:'scheduler',  icon:'◷', label:'Schedule',               desc:'Plan and post your content' },
  { id:'studio',     icon:'⚡', label:'AI Studio',              desc:'B-roll, thumbnails, AI video' },
  { id:'transcript', icon:'◑', label:'Transcripts',            desc:'Full video transcripts' },
  { id:'billing',    icon:'◇', label:'Credits & Billing',      desc:'Plans and usage' },
  { id:'settings',   icon:'⚙', label:'Settings',               desc:'Profile and preferences' },
];
const MENU_ITEMS_ADMIN = [
  { id:'admin', icon:'◈', label:'Admin panel', desc:'Users, logs, API keys' }
];

function renderNav() {
  const user = state.session?.user;
  const navHtml = NAV.map(n => `
    <a class="nav-item ${state.view===n.id?'active':''}" data-view="${n.id}">
      <span class="nav-icon">${n.icon}</span>
      <span class="nav-label">${n.label}</span>
    </a>`).join('');
  const bottomHtml = NAV.map(n => `
    <a class="bottom-item ${state.view===n.id?'active':''}" data-view="${n.id}">
      <span>${n.icon}</span><small>${n.label}</small>
    </a>`).join('') +
    `<button class="bottom-item" id="bottomMoreBtn"><span>≡</span><small>More</small></button>`;

  $('#sideNav').innerHTML = navHtml;
  $('#bottomNav').innerHTML = bottomHtml;
  $('#bottomMoreBtn')?.addEventListener('click', openMenu);

  if (user) {
    $('#userAvatar').textContent = (user.name||user.email||'U')[0].toUpperCase();
    $('#userName').textContent   = user.name || user.email;
    const credits = user.credits ?? 0;
    $('#userPlan').textContent   = credits >= 9999 ? '∞ credits' : `${credits} credits`;
    const creditsEl = $('#navCreditsBar');
    if (creditsEl) {
      const plan = state.library?.billingPlans?.find(p => p.id === (user.plan||'free').toLowerCase());
      const max = plan?.creditsIncluded || 100;
      const unlimited = max >= 99999 || credits >= 9999;
      const pct = unlimited ? 100 : Math.min(100, Math.round((credits / max) * 100));
      const fillClass = !unlimited && pct < 20 ? 'critical' : !unlimited && pct < 40 ? 'low' : '';
      creditsEl.innerHTML = `<div class="nav-credits">
        <div class="nav-credits-bar"><div class="nav-credits-fill ${fillClass}" style="width:${pct}%"></div></div>
        <small>${unlimited ? 'Unlimited credits' : credits + ' / ' + max.toLocaleString() + ' credits'}</small>
      </div>`;
    }
  }
}

/* ── Drawer ──────────────────────────────────────────────────────── */
function openMenu() {
  const user = state.session?.user;
  const isAdmin = user?.role === 'admin';
  const allItems = isAdmin ? [...MENU_ITEMS, ...MENU_ITEMS_ADMIN] : MENU_ITEMS;
  $('#drawerContent').innerHTML = `
    <div class="drawer-user">
      <div class="drawer-avatar">${(user?.name||user?.email||'U')[0].toUpperCase()}</div>
      <div>
        <b>${esc(user?.name||user?.email||'')}</b>
        <small>${user?.credits ?? 0} credits · ${esc(user?.plan||'Free')}</small>
      </div>
    </div>
    <nav class="drawer-nav">
      ${allItems.map(item => `
        <a class="drawer-item" data-view="${item.id}" data-close-drawer>
          <span class="drawer-icon">${item.icon}</span>
          <div>
            <b>${item.label}</b>
            <small>${item.desc}</small>
          </div>
        </a>`).join('')}
    </nav>
    <div class="drawer-footer">
      <button class="drawer-item danger" id="drawerLogout">
        <span class="drawer-icon">↩</span>
        <div><b>Sign out</b><small>${esc(user?.email||'')}</small></div>
      </button>
    </div>`;

  $('#menuDrawer').classList.remove('hidden');
  $('#drawerBd').classList.remove('hidden');
  requestAnimationFrame(() => {
    $('#menuDrawer').classList.add('open');
    $('#drawerBd').classList.add('open');
  });

  $('#drawerClose')?.addEventListener('click', closeMenu);
  $('#drawerBd')?.addEventListener('click', closeMenu);
  $('#drawerLogout')?.addEventListener('click', () => {
    localStorage.removeItem('clipforge:userId'); location.reload();
  });
}

function closeMenu() {
  $('#menuDrawer')?.classList.remove('open');
  $('#drawerBd')?.classList.remove('open');
  setTimeout(() => {
    $('#menuDrawer')?.classList.add('hidden');
    $('#drawerBd')?.classList.add('hidden');
  }, 280);
}

/* ── setView ─────────────────────────────────────────────────────── */
const PAGE_META = {
  home:       { eyebrow:'Overview',        title:'Dashboard'        },
  create:     { eyebrow:'New project',     title:'Create clips'     },
  clips:      { eyebrow:'Library',         title:'Your clips'       },
  clipDetail: { eyebrow:'Clip detail',     title:'Clip'             },
  faceless:     { eyebrow:'AI Content',      title:'Faceless Studio'       },
  digitalHuman: { eyebrow:'AI Video',       title:'Digital Human Studio'  },
  scheduler:    { eyebrow:'Publishing',     title:'Schedule'              },
  studio:       { eyebrow:'AI tools',       title:'AI Studio'             },
  transcript: { eyebrow:'AI tools',        title:'Transcript'       },
  billing:    { eyebrow:'Account',         title:'Credits'          },
  settings:   { eyebrow:'Account',         title:'Settings'         },
  admin:      { eyebrow:'Admin',           title:'Admin panel'      }
};

function setView(id) {
  closeMenu();
  // clipDetail needs a clip loaded
  if (id === 'clipDetail' && !state.clip) { setView('clips'); return; }

  state.view = id;
  $$('.view').forEach(el => el.classList.remove('active'));
  const el = $(`#${id}`);
  if (el) el.classList.add('active');

  const meta = PAGE_META[id] || { eyebrow: id, title: id };
  let eyebrow = meta.eyebrow;
  if (id === 'home') {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const name = (state.session?.user?.name || state.session?.user?.email || '').split(' ')[0] || '';
    eyebrow = name ? `${greeting}, ${name}` : greeting;
  }
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent   = meta.title;
  renderNav();

  if (id === 'home')       renderHome();
  if (id === 'create')     renderCreate();
  if (id === 'clips')      renderClips();
  if (id === 'clipDetail') renderClipDetail();
  if (id === 'faceless')     renderFaceless();
  if (id === 'digitalHuman') renderDigitalHuman();
  if (id === 'studio')       renderStudio();
  if (id === 'transcript') renderTranscript();
  if (id === 'billing')    renderBilling();
  if (id === 'settings')   renderSettings();
  if (id === 'admin')      { if (state.session?.user?.role === 'admin') renderAdmin(); else setView('home'); }
  if (id === 'scheduler')  renderScheduler();
}

/* ── Data loading ─────────────────────────────────────────────────── */
async function loadAll() {
  // Load session and library in parallel; failures are isolated so one can't kill the other
  const [sessResult, libResult] = await Promise.allSettled([
    api('/api/session'),
    api('/api/library'),
  ]);
  if (sessResult.status === 'fulfilled') state.session = sessResult.value;
  else console.warn('Session load failed:', sessResult.reason?.message);
  if (libResult.status === 'fulfilled') state.library = libResult.value;
  else console.warn('Library load failed:', libResult.reason?.message);
  api('/api/ai/generations').then(r => { state.generations = r.generations || []; }).catch(() => {});
  api('/api/brand-kits').then(r => { state.brandKits = r.brandKits || []; }).catch(() => {});
}

/* ── Home ─────────────────────────────────────────────────────────── */
function renderHome() {
  const { clips=[], jobs=[], videos=[] } = state.library;
  const user = state.session?.user || {};
  const name = (user.name||user.email||'').split(' ')[0] || 'there';
  const activeJobs = jobs.filter(j => ['queued','running'].includes(j.status));
  const failedJobs = jobs.filter(j => j.status==='failed');
  const doneClips  = clips.filter(c => c.outputPath && !c.demoMode);
  const isNew = !doneClips.length && !activeJobs.length;
  const avgScore = doneClips.length ? Math.round(doneClips.reduce((s,c)=>s+(c.score||0),0)/doneClips.length) : 0;
  const topClip  = doneClips.length ? doneClips.slice().sort((a,b)=>(b.score||0)-(a.score||0))[0] : null;
  const highScoreClips = doneClips.filter(c => (c.score||0) >= 80).length;

  $('#home').innerHTML = `
    <div class="home-wrap">
      <!-- SVG gradient defs for score rings -->
      <svg class="score-svg-defs" aria-hidden="true">
        <defs>
          <linearGradient id="ringGreen" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#22d3a2"/><stop offset="100%" stop-color="#059669"/></linearGradient>
          <linearGradient id="ringBlue"  x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#7c6ef5"/><stop offset="100%" stop-color="#a899ff"/></linearGradient>
          <linearGradient id="ringAmber" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#fbbf24"/></linearGradient>
        </defs>
      </svg>

      ${activeJobs.length ? `
        <div class="processing-banner">
          <div class="processing-pulse"></div>
          <div style="flex:1">
            <b>AI is generating ${activeJobs.length === 1 ? 'your clips' : activeJobs.length + ' jobs'}…</b>
            <span class="muted" style="display:flex;align-items:center;gap:6px;margin-top:3px">
              ${esc(activeJobs[0].stage||'Processing')}
              <div class="processing-dots"><span></span><span></span><span></span></div>
              ${activeJobs[0].progress||0}%
            </span>
          </div>
          <div style="text-align:right">
            <div style="font-size:.7rem;color:var(--muted);margin-bottom:4px">${activeJobs[0].progress||0}% done</div>
            <button class="ghost" data-view="clips" style="padding:6px 14px;font-size:.8rem">View →</button>
          </div>
        </div>
        <div class="progress glow" style="margin-bottom:22px;height:3px"><span style="width:${activeJobs[0].progress||0}%"></span></div>
      ` : ''}

      ${isNew ? `
        <div class="onboard-hero">
          <div class="onboard-badge">⚡</div>
          <h2>Hey ${esc(name)}, let's make your first clip</h2>
          <p>Upload a video or paste a YouTube link — AI finds the viral moments, auto-reframes, and adds captions automatically.</p>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:24px;flex-wrap:wrap">
            <button data-view="create" style="padding:14px 28px;font-size:.95rem">Start creating →</button>
            <button data-view="faceless" class="ghost" style="padding:14px 24px;font-size:.95rem">Try faceless content</button>
          </div>
        </div>
        <div style="margin:8px 0 20px">
          <div class="feature-highlight-grid">
            <div class="feature-highlight-card">
              <div class="fh-icon">🎯</div>
              <b>AI Viral Detection</b>
              <small>Finds the exact moments that stop scrollers — hooks, reveals, emotional peaks.</small>
            </div>
            <div class="feature-highlight-card">
              <div class="fh-icon green">🎬</div>
              <b>Smart Auto-Reframe</b>
              <small>Scene-aware camera tracks faces, predicts movement, always frames perfectly.</small>
            </div>
            <div class="feature-highlight-card">
              <div class="fh-icon pink">✨</div>
              <b>Elite Captions</b>
              <small>Word-by-word karaoke captions in 14 viral styles with perfect timing.</small>
            </div>
          </div>
        </div>
        <div class="journey-steps">
          ${[['✦','Import video','Upload or paste a YouTube URL'],
             ['◎','AI analysis','Finds the best viral moments'],
             ['▶','Review clips','Preview, edit hooks, download'],
             ['◷','Share','Optimized for every platform']].map(([ic,t,d],i)=>`
            <div class="journey-step">
              <div class="journey-num">Step ${i+1}</div>
              <div class="journey-icon">${ic}</div>
              <b>${t}</b>
              <small>${d}</small>
            </div>`).join('')}
        </div>
      ` : `
        <div class="stats-row">
          <div class="stat-card" style="cursor:pointer" data-view="clips">
            <div class="stat-num">${doneClips.length}</div>
            <div class="stat-label">Clips ready</div>
            ${highScoreClips ? `<div class="stat-card-trend up">▲ ${highScoreClips} viral (80+)</div>` : ''}
          </div>
          <div class="stat-card" style="cursor:pointer" data-view="create">
            <div class="stat-num">${videos.length}</div>
            <div class="stat-label">Videos imported</div>
          </div>
          <div class="stat-card">
            <div class="stat-num" style="${avgScore>=80?'background:linear-gradient(135deg,#22d3a2,#059669);-webkit-background-clip:text;-webkit-text-fill-color:transparent':avgScore>=60?'':'background:linear-gradient(135deg,#f87171,#dc2626);-webkit-background-clip:text;-webkit-text-fill-color:transparent'}">${avgScore || '—'}</div>
            <div class="stat-label">Avg viral score</div>
            ${topClip ? `<div class="stat-card-trend ${avgScore>=70?'up':'neutral'}">Best: ${topClip.score}/100</div>` : ''}
          </div>
          <div class="stat-card" style="cursor:pointer" data-view="billing">
            <div class="stat-num">${(user.credits??0) >= 9999 ? '∞' : (user.credits??0)}</div>
            <div class="stat-label">Credits left</div>
            ${(user.credits??0) < 20 && (user.credits??0) < 9999 ? `<div class="stat-card-trend down">Running low</div>` : ''}
          </div>
        </div>

        ${(user.credits ?? 0) < 10 && (user.credits ?? 0) >= 0 ? `
          <div class="alert-banner" style="background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.25)">
            <span>⚠ Low credits — ${user.credits??0} remaining</span>
            <button class="ghost" data-view="billing">Get more →</button>
          </div>` : ''}

        ${failedJobs.length ? `
          <div class="alert-banner">
            <span>⚠ ${failedJobs.length} job${failedJobs.length>1?'s':''} failed</span>
            <button class="ghost" data-view="clips">Review →</button>
          </div>` : ''}

        <div class="home-actions">
          <button class="primary-action" data-view="create">
            <div class="pa-icon">✦</div>
            <div><b>New project</b><small>Upload video or paste a YouTube link</small></div>
          </button>
          <button class="primary-action" data-view="faceless">
            <div class="pa-icon">◈</div>
            <div><b>Faceless content</b><small>AI-written scripts for faceless videos</small></div>
          </button>
          <button class="primary-action" data-view="clips">
            <div class="pa-icon">▶</div>
            <div><b>My clips</b><small>${doneClips.length} clip${doneClips.length!==1?'s':''} ready to download</small></div>
          </button>
          <button class="primary-action" data-view="billing">
            <div class="pa-icon">◇</div>
            <div><b>Credits & billing</b><small>${(user.credits??0) >= 9999 ? 'Unlimited' : (user.credits??0)+' credits remaining'}</small></div>
          </button>
        </div>

        <!-- Digital Human Studio — full-width featured section -->
        <div class="dh-home-banner" data-view="digitalHuman" role="button" tabindex="0">
          <div class="dh-home-banner-left">
            <div class="dh-home-badge">
              <span class="dh-pulse"></span>AI Digital Human Studio
            </div>
            <h2 class="dh-home-title">Create AI Twins &amp; Synthetic Humans</h2>
            <p class="dh-home-desc">Your face · your voice · any scene. Generate talking-head videos, luxury ads, presenter content — powered by real AI or cloud video providers.</p>
            <div class="dh-home-pills">
              <span class="dh-pill">🧑 AI Twin</span>
              <span class="dh-pill">✨ Synthetic Human</span>
              <span class="dh-pill">🎬 Scene Prompts</span>
              <span class="dh-pill">🗺 Storyboard AI</span>
            </div>
          </div>
          <div class="dh-home-cta">
            <button class="primary dh-home-btn" data-view="digitalHuman">Open Studio →</button>
            <div class="dh-home-sub">Runway · Kling · Pika · Luma supported</div>
          </div>
        </div>

        ${doneClips.length ? `
          <div class="panel-head" style="margin:28px 0 14px">
            <h2>Top clips by viral score</h2>
            <button class="ghost" data-view="clips">View all →</button>
          </div>
          <div class="card-grid">${doneClips.slice().sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,4).map(clipCard).join('')}</div>
        ` : ''}
      `}
    </div>`;
}

/* ── Create ─────────────────────────────────────────────────────────── */
function activeVideos() {
  const videos = state.library.videos || [];
  if (!state.activeVideoIds?.length) return videos;
  const active = videos.filter(v => state.activeVideoIds.includes(v.id));
  return active.length ? active : videos;
}

function renderLogoQuickSetup() {
  const selectedId = state.activeBrandKitId;
  const kits = state.brandKits || [];
  const selected = kits.find(bk => bk.id === selectedId);

  if (!kits.length) {
    // No brand kits at all — show a callout directing user to Settings
    return `
      <div style="margin-top:10px;padding:12px 14px;background:var(--surface2);border-radius:10px;border:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:22px">🏷</span>
          <div style="flex:1">
            <b style="font-size:14px">Add your logo</b>
            <div class="muted" style="font-size:12px;margin-top:2px">Upload your channel or brand logo in Settings → Brand Kits, then select it here to watermark every clip automatically.</div>
          </div>
          <button id="goToLogoSettings" class="btn-sm" style="white-space:nowrap">Set up logo →</button>
        </div>
      </div>`;
  }

  if (selected?.logoUrl) {
    // Kit selected and has a logo — show preview
    return `
      <div style="margin-top:10px;padding:10px 14px;background:var(--surface2);border-radius:10px;border:1px solid var(--accent);display:flex;align-items:center;gap:10px">
        <img src="${esc(selected.logoUrl)}" style="height:32px;max-width:64px;object-fit:contain;border-radius:4px;background:#111">
        <div style="flex:1">
          <b style="font-size:13px">${esc(selected.name)}</b>
          <div class="muted" style="font-size:11px">${esc(selected.logoPosition||'top-left')} · ${esc(selected.logoSize||'medium')} · ${Math.round((selected.logoOpacity??0.9)*100)}% opacity</div>
        </div>
        <span style="font-size:11px;color:var(--accent)">✓ Will appear on clips</span>
      </div>`;
  }

  // Kits exist but none selected or selected has no logo
  return `
    <div style="margin-top:10px;padding:10px 14px;background:var(--surface2);border-radius:10px;border:1px dashed var(--border);display:flex;align-items:center;gap:10px">
      <span style="font-size:18px;opacity:.5">🏷</span>
      <div class="muted" style="font-size:12px;flex:1">${selectedId ? 'Selected kit has no logo yet — ' : 'No logo selected — '}<button id="goToLogoSettings" class="link-btn" style="font-size:12px">upload one in Settings →</button></div>
    </div>`;
}

function renderCreate() {
  const allVideos = state.library?.videos || [];
  const videos = activeVideos();
  const hasVideos = videos.length > 0;
  const statusType = state.importStatus?.type || '';

  $('#create').innerHTML = `
    <div class="create-wrap">

      <!-- Step 1: Import -->
      <section class="create-step panel">
        <div class="step-label"><span class="step-num">1</span> Import video</div>

        <div class="upload-drop" id="uploadDrop">
          <form id="uploadForm">
            <label for="uploadVideo" class="upload-label">
              <div class="upload-icon">⬆</div>
              <b>${state.importing && state.uploadProgress ? `Uploading… ${state.uploadProgress}%` : 'Click to upload'}</b>
              <small>MP4, MOV, WEBM, M4V · up to 300 MB</small>
              <input id="uploadVideo" type="file" accept="video/mp4,video/quicktime,video/webm,.m4v" style="display:none">
            </label>
          </form>
          ${state.importing && state.uploadProgress ? `<div class="progress upload-progress"><span style="width:${state.uploadProgress}%"></span></div>` : ''}
        </div>

        <div class="divider-label">or paste a link</div>

        <form id="importForm" class="source-form">
          <input id="sourceUrl" type="text" value="${esc(state.importUrl)}" placeholder="YouTube URL — youtube.com/watch?v=…" ${state.importing?'disabled':''}>
          <button type="submit" ${state.importing?'disabled':''}>${state.importing?'…':'Import'}</button>
        </form>

        ${state.importStatus?.text ? `<div class="import-msg ${statusType}">${esc(state.importStatus.text)}</div>` : ''}
      </section>

      <!-- Step 2: Select & configure -->
      <section class="create-step panel ${!hasVideos?'step-locked':''}">
        <div class="step-label"><span class="step-num">2</span> Select &amp; configure</div>

        ${hasVideos ? `
          <div class="video-list">${videoCards(videos)}</div>
          ${allVideos.length > 1 ? `<button class="ghost danger-btn" id="clearAllVideos" style="margin-top:4px;font-size:.8rem">Remove all videos</button>` : ''}

          <div class="gen-options" style="margin-top:16px">
            <div class="option-row"><label>Clips</label>
              <select id="clipCount">
                <option value="3">3 clips</option>
                <option value="5">5 clips</option>
                <option value="10">10 clips</option>
              </select>
            </div>
            <div class="option-row"><label>Length</label>
              <select id="clipLength">
                <option value="60"  ${state.clipLength===60 ?'selected':''}>1 min</option>
                <option value="90"  ${state.clipLength===90 ?'selected':''}>90 s</option>
                <option value="120" ${state.clipLength===120?'selected':''}>2 min</option>
                <option value="180" ${state.clipLength===180?'selected':''}>3 min</option>
                <option value="300" ${state.clipLength===300?'selected':''}>5 min</option>
                <option value="600" ${state.clipLength===600?'selected':''}>10 min</option>
              </select>
            </div>
            <div class="option-row"><label>Captions</label>
              <select id="captionStyle">
                ${CAPTION_STYLES.map(s=>`<option value="${s}">${CAPTION_STYLE_LABELS[s]||s}</option>`).join('')}
              </select>
            </div>
            <div class="option-row"><label>Framing</label>
              <select id="framingMode">
                <option value="dynamic" ${state.framingMode==='dynamic'?'selected':''}>Dynamic (AI picks)</option>
                <option value="tight"   ${state.framingMode==='tight'  ?'selected':''}>Tight — fills frame, no bars</option>
                <option value="medium"  ${state.framingMode==='medium' ?'selected':''}>Medium shot</option>
                <option value="wide"    ${state.framingMode==='wide'   ?'selected':''}>Wide shot</option>
                <option value="close"   ${state.framingMode==='close'  ?'selected':''}>Close-up</option>
                <option value="original"${state.framingMode==='original'?'selected':''}>Original frame</option>
              </select>
            </div>
            <div class="option-row"><label>Logo / Watermark</label>
              <select id="brandKitSelect">
                <option value="">No logo</option>
                ${state.brandKits.map(bk=>`<option value="${esc(bk.id)}" ${state.activeBrandKitId===bk.id?'selected':''}>${esc(bk.name)}${bk.logoUrl?' (logo ready)':' (no logo yet)'}</option>`).join('')}
              </select>
            </div>
          </div>

          <!-- Logo quick-setup -->
          ${renderLogoQuickSetup()}

          <label class="permission" style="margin-top:12px"><input id="rightsBulk" type="checkbox"> I own or have permission to use this content.</label>
          <button id="processSelected" style="margin-top:12px;width:100%" ${state.selected.size?'':'disabled'}>
            Generate ${state.selected.size||''} video${state.selected.size!==1?'s':''} with AI →
          </button>
        ` : `
          <div class="step-empty">
            <p class="muted">Import a video above to continue.</p>
          </div>
        `}
      </section>
    </div>`;

  // Go-to-settings shortcut from the logo quick-setup card
  $('#goToLogoSettings')?.addEventListener('click', () => setView('settings'));
  $('#importForm').addEventListener('submit', importSource);
  $('#uploadVideo').addEventListener('change', e => { if (e.target.files?.[0]) uploadSource(e); });
  $$('#create [data-select-video]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.selectVideo;
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    renderCreate();
  }));
  $('#processSelected')?.addEventListener('click', processSelected);
}

function videoCards(videos) {
  return videos.map(v => `<article class="video-card ${state.selected.has(v.id)?'selected':''}">
    <img src="${esc(v.thumbnailUrl||'')}" loading="lazy">
    <div>
      <h3>${esc(v.title)}</h3>
      <div class="meta">
        <span>${dur(v.durationSeconds)}</span>
        <span>${v.sourceKind==='upload'?'Uploaded':fmt(v.viewCount)+' views'}</span>
        <span>${when(v.publishedAt)}</span>
      </div>
      <div class="action-row" style="margin-top:10px">
        <button class="ghost" data-select-video="${v.id}">${state.selected.has(v.id)?'✓ Selected':'Select'}</button>
        <button class="ghost danger-btn" data-delete-video="${v.id}">Delete</button>
      </div>
    </div>
  </article>`).join('');
}

async function importSource(e) {
  e.preventDefault();
  const url = $('#sourceUrl').value.trim();
  if (!url) { state.importStatus={type:'error',text:'Paste a YouTube URL first.'}; renderCreate(); return; }
  state.importUrl=url; state.importing=true; state.importStatus={type:'loading',text:'Fetching metadata…'};
  renderCreate();
  try {
    const res = await api('/api/import', { method:'POST', body:JSON.stringify({ sourceUrl:url }) });
    state.activeVideoIds=(res.videos||[]).map(v=>v.id);
    state.importStatus={type:'success',text:`Imported ${res.videos.length} video${res.videos.length===1?'':'s'}.`};
    await loadAll(); state.importing=false; setView('create');
  } catch(err) {
    state.importing=false; state.importStatus={type:'error',text:err.message||'Import failed.'}; renderCreate();
  }
}

async function uploadSource(e) {
  if (e.preventDefault) e.preventDefault();
  const file=e.target?.files?.[0] || $('#uploadVideo').files?.[0];
  if (!file) { state.importStatus={type:'error',text:'Choose a video file first.'}; renderCreate(); return; }
  const ext=file.name.split('.').pop().toLowerCase();
  if (!['mp4','mov','webm','m4v'].includes(ext)) { state.importStatus={type:'error',text:'Unsupported format. Use mp4, mov, webm, or m4v.'}; renderCreate(); return; }
  state.importing=true; state.uploadProgress=1; state.importStatus={type:'loading',text:`Uploading ${file.name}…`};
  renderCreate();
  try {
    const form=new FormData(); form.append('video',file); form.append('title',file.name.replace(/\.[^.]+$/,''));
    const data=await uploadWithProgress(form);
    state.activeVideoIds=(data.videos||[]).map(v=>v.id);
    state.selected=new Set(state.activeVideoIds);
    state.importStatus={type:'success',text:'Uploaded. Select options and generate clips.'};
    await loadAll(); state.importing=false; state.uploadProgress=0; setView('create');
  } catch(err) {
    state.importing=false; state.importStatus={type:'error',text:err.message||'Upload failed.'}; renderCreate();
  }
}

function uploadWithProgress(form) {
  return new Promise((resolve,reject) => {
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/api/upload'); xhr.setRequestHeader('x-user-id',uid());
    xhr.upload.onprogress=ev => {
      if (!ev.lengthComputable) return;
      state.uploadProgress=Math.max(1,Math.min(99,Math.round((ev.loaded/ev.total)*100)));
      state.importStatus={type:'loading',text:`Uploading… ${state.uploadProgress}%`};
      renderCreate();
    };
    xhr.onerror=()=>reject(new Error('Upload failed.'));
    xhr.onload=()=>{
      let d={};
      try { d=JSON.parse(xhr.responseText||'{}'); } catch { return reject(new Error('Invalid response.')); }
      if (xhr.status>=400||d.error) reject(new Error(d.error||'Upload failed.'));
      else resolve(d);
    };
    xhr.send(form);
  });
}

async function processSelected() {
  if (!$('#rightsBulk').checked) return alert('Confirm permission first.');
  const selected=[...state.selected];
  if (!selected.length) return alert('Select at least one video first.');
  const btn=$('#processSelected');
  const origLabel=btn.textContent;
  btn.disabled=true; btn.textContent='Processing…';
  const clipCount      = Number($('#clipCount')?.value  || 3);
  const clipLength     = Number($('#clipLength')?.value || 60);
  const captionStyle   = $('#captionStyle')?.value  || 'bold';
  const framingMode    = $('#framingMode')?.value   || 'dynamic';
  const brandKitId     = $('#brandKitSelect')?.value || null;
  state.framingMode    = framingMode;
  state.clipLength     = clipLength;
  state.activeBrandKitId = brandKitId || null;
  state.importStatus = {type:'loading', text:'Starting AI analysis. Check Clips page for progress.'};
  renderCreate();
  try {
    await Promise.all(selected.map(videoId => api('/api/process', {
      method:'POST',
      body:JSON.stringify({videoId, rightsConfirmed:true, clipCount, clipLength, captionStyle, framingMode, brandKitId: brandKitId||undefined})
    })));
    state.selected.clear(); await loadAll(); setView('clips');
  } catch(err) {
    state.importStatus={type:'error',text:err.message||'Could not start generation.'};
    await loadAll(); renderCreate();
    // Re-enable button on failure (renderCreate re-renders the button anyway, but guard here too)
    const b2=$('#processSelected');
    if (b2) { b2.disabled=false; b2.textContent=origLabel; }
  }
}

/* ── Clips ─────────────────────────────────────────────────────────── */
function renderClips() {
  const allClips = (state.library.clips||[]).filter(c=>c.outputPath&&!c.demoMode);
  const allJobs  = state.library.jobs||[];
  const activeJobs = allJobs.filter(j=>['queued','running'].includes(j.status));
  const failedJobs = allJobs.filter(j=>j.status==='failed');

  // Filter + sort
  const q = (state.clipsSearch||'').toLowerCase().trim();
  const sortBy = state.clipsSort || 'newest';
  let clips = q ? allClips.filter(c => (clipTitle(c)+' '+(c.bestPlatform||'')+' '+(c.captionStyle||'')).toLowerCase().includes(q)) : [...allClips];
  if (sortBy==='oldest')   clips.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  else if (sortBy==='score')    clips.sort((a,b)=>(b.score||0)-(a.score||0));
  else if (sortBy==='longest')  clips.sort((a,b)=>((b.endSeconds||0)-(b.startSeconds||0))-((a.endSeconds||0)-(a.startSeconds||0)));
  else if (sortBy==='shortest') clips.sort((a,b)=>((a.endSeconds||0)-(a.startSeconds||0))-((b.endSeconds||0)-(b.startSeconds||0)));
  else clips.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));

  const bulkCount = state.clipsBulkSelected.size;

  $('#clips').innerHTML = `
    <!-- Sticky toolbar -->
    <div class="clips-toolbar">
      <div class="toolbar-search">
        <span class="search-icon">⌕</span>
        <input id="clipsSearchInput" type="text" placeholder="Search clips by title, platform, style…" value="${esc(state.clipsSearch||'')}">
      </div>
      <select id="clipsSortSelect">
        <option value="newest"   ${sortBy==='newest'  ?'selected':''}>Newest first</option>
        <option value="oldest"   ${sortBy==='oldest'  ?'selected':''}>Oldest first</option>
        <option value="score"    ${sortBy==='score'   ?'selected':''}>Highest score</option>
        <option value="longest"  ${sortBy==='longest' ?'selected':''}>Longest</option>
        <option value="shortest" ${sortBy==='shortest'?'selected':''}>Shortest</option>
      </select>
      <button data-view="create" class="ghost" style="white-space:nowrap">+ New clip</button>
      ${allClips.length ? `<button class="ghost danger-btn" id="clearAllClips" style="white-space:nowrap">Clear all</button>` : ''}
    </div>

    <!-- Bulk action bar -->
    ${bulkCount ? `
      <div class="bulk-bar">
        <span class="bulk-bar-count">${bulkCount} clip${bulkCount!==1?'s':''} selected</span>
        <button class="ghost" id="bulkDownload">⬇ Download</button>
        <button class="ghost danger-btn" id="bulkDelete">Delete</button>
        <button class="ghost" id="bulkClear">✕ Clear selection</button>
      </div>` : ''}

    <!-- Active jobs -->
    ${activeJobs.length ? `
      <div class="panel" style="margin-bottom:18px;border-color:rgba(245,158,11,.25)">
        <div class="panel-head" style="margin-bottom:13px">
          <div style="display:flex;align-items:center;gap:11px">
            <div class="processing-pulse"></div>
            <h2>Generating ${activeJobs.length} clip batch${activeJobs.length!==1?'es':''}…</h2>
          </div>
          <small class="muted">Auto-refreshing every 3s</small>
        </div>
        ${activeJobs.map(jobCard).join('')}
      </div>` : ''}

    <!-- Failed jobs -->
    ${failedJobs.length ? `
      <div class="panel" style="margin-bottom:18px;border-color:rgba(248,113,113,.28)">
        <h2 style="margin-bottom:13px;color:var(--danger)">Failed jobs (${failedJobs.length})</h2>
        ${failedJobs.map(jobCard).join('')}
      </div>` : ''}

    <!-- Clip grid or empty state -->
    ${clips.length ? `
      <div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span class="muted" style="font-size:.78rem;font-weight:600">${clips.length} clip${clips.length!==1?'s':''}</span>
      </div>
      <div class="clip-grid">${clips.map(clipCard).join('')}</div>
    ` : activeJobs.length ? `
      <div class="empty-state" style="padding:60px 24px">
        <div style="width:52px;height:52px;border-radius:50%;background:rgba(245,158,11,.12);display:flex;align-items:center;justify-content:center;margin-bottom:18px">
          <div class="processing-pulse"></div>
        </div>
        <h2>Generating your clips…</h2>
        <p>AI is finding the best moments. Usually takes 2–5 minutes.</p>
      </div>
    ` : `
      <div class="empty-state" style="padding:80px 24px">
        <div style="font-size:3.5rem;margin-bottom:20px;opacity:.15">▶</div>
        <h2>No clips yet</h2>
        <p style="max-width:320px">Import a video and let AI find the most viral moments automatically.</p>
        <button data-view="create" style="margin-top:26px;padding:13px 28px">Create your first clip →</button>
      </div>`}`;

  // Toolbar events
  $('#clipsSearchInput')?.addEventListener('input', e => {
    state.clipsSearch = e.target.value; renderClips();
  });
  $('#clipsSortSelect')?.addEventListener('change', e => {
    state.clipsSort = e.target.value; renderClips();
  });

  // Bulk actions
  $('#bulkClear')?.addEventListener('click', () => { state.clipsBulkSelected.clear(); renderClips(); });
  $('#bulkDelete')?.addEventListener('click', () => {
    if (!confirm(`Delete ${bulkCount} clip${bulkCount!==1?'s':''}? This cannot be undone.`)) return;
    const ids = [...state.clipsBulkSelected];
    Promise.all(ids.map(id => api('/api/clip',{method:'DELETE',body:JSON.stringify({clipId:id})}))).then(loadAll).then(() => {
      state.clipsBulkSelected.clear(); renderClips();
    });
  });

  // Clip card events (preview, bulk select, context menu)
  $$('.clip-card[data-clip-id]').forEach(card => {
    const id = card.dataset.clipId;
    card.addEventListener('click', e => {
      if (e.target.closest('.clip-action-primary') || e.target.closest('.clip-action-icon') || e.target.closest('.clip-context-menu')) return;
      if (e.target.closest('.clip-select-check')) {
        e.stopPropagation();
        if (state.clipsBulkSelected.has(id)) state.clipsBulkSelected.delete(id);
        else state.clipsBulkSelected.add(id);
        renderClips(); return;
      }
      openClipModal(id);
    });

    card.querySelector('.clip-action-primary')?.addEventListener('click', e => {
      e.stopPropagation(); openClipModal(id);
    });

    card.querySelector('[data-more-clip]')?.addEventListener('click', e => {
      e.stopPropagation();
      state.openMenuClipId = state.openMenuClipId === id ? null : id;
      renderClips();
    });

    card.querySelector('[data-delete-clip-id]')?.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm('Delete this clip?')) return;
      state.openMenuClipId = null;
      api('/api/clip',{method:'DELETE',body:JSON.stringify({clipId:id})}).then(loadAll).then(renderClips);
    });

    card.querySelector('[data-open-clip-detail]')?.addEventListener('click', e => {
      e.stopPropagation();
      state.openMenuClipId = null;
      const c = state.library.clips.find(x=>x.id===id);
      if (c) { state.clip=c; state.hookTab='curiosity'; state.platformTab='tiktok'; setView('clipDetail'); }
    });
  });

  // Close any open context menu when clicking elsewhere
  document.addEventListener('click', function _closer(e) {
    if (!e.target.closest('[data-more-clip]') && !e.target.closest('.clip-context-menu')) {
      if (state.openMenuClipId) { state.openMenuClipId = null; renderClips(); }
      document.removeEventListener('click', _closer);
    }
  });
}

function jobCard(j) {
  const videos = state.library.videos||[];
  const vid = videos.find(v=>v.id===j.videoId);
  const steps = j.steps||[];
  const isFailed = j.status==='failed';
  const isActive = ['queued','running'].includes(j.status);
  const actions = isFailed
    ? `<button data-retry-job="${j.id}" style="font-size:.78rem;padding:7px 14px">Retry</button><button class="ghost" data-delete-job="${j.id}" style="font-size:.78rem;padding:7px 12px">Delete</button>`
    : isActive ? `<button class="ghost" data-cancel-job="${j.id}" style="font-size:.78rem;padding:7px 12px">Cancel</button>` : '';
  return `<div class="job-card ${isFailed?'failed':isActive?'active':''}">
    <div class="job-head">
      <div>
        <b style="font-size:.9rem">${esc(vid?.title||'Video')}</b>
        <span style="margin-left:8px">${pill(j.stage||j.status, isFailed?'error':isActive?'warn':'ok')}</span>
      </div>
      <div class="action-row">${actions}</div>
    </div>
    ${steps.length?`<div class="steps-row">${steps.map(s=>`<div class="step ${s.status}"><span></span><small>${esc(s.label)}</small></div>`).join('')}</div>`:''}
    ${isActive?`<div class="progress" style="margin-top:9px"><span style="width:${j.progress||0}%"></span></div>`:''}
    ${j.error?`<p class="error-text" style="margin-top:7px">${esc(j.error)}</p>`:''}
  </div>`;
}

function clipCard(c) {
  const dur2 = Math.round((c.endSeconds||0)-(c.startSeconds||0));
  const mediaUrl = clipUrl(c.outputPath);
  const score = Number(c.score || 0);
  const hookPct = c.hookStrength ? Math.round(c.hookStrength*10) : score;
  const viralPct = c.emotionalPunch ? Math.round(c.emotionalPunch*10) : Math.round(score*.9);
  const retentionPct = c.retentionScore ? Math.round(c.retentionScore*10) : Math.round(score*.88);
  const title = clipTitle(c);
  const isSelected = state.clipsBulkSelected.has(c.id);
  const menuOpen = state.openMenuClipId === c.id;
  const dropoffRisk = c.dropoffRisk || 'medium';
  const ringColor = score >= 80 ? 'green' : score >= 60 ? 'blue' : 'amber';
  // Score ring dash offset: 175 = full circle; 0 = empty
  const dashOffset = Math.round(175 - (score/100)*175);

  const thumbEl = c.thumbnailPath
    ? `<img class="clip-thumb-img" src="${esc(c.thumbnailPath)}" alt="${esc(title)}" loading="lazy">`
    : `<div class="clip-thumb-skeleton skeleton" style="position:absolute;inset:0"></div>`;

  return `<article class="clip-card${isSelected?' selected':''}" data-clip-id="${c.id}">
    <div class="clip-thumb">
      ${thumbEl}
      <div class="clip-thumb-overlay"></div>
      <div class="clip-thumb-tl">
        <span class="clip-dur-badge">${dur2}s</span>
        ${platformBadge(c.bestPlatform)}
      </div>
      <div class="clip-thumb-tr">${scoreChip(score)}</div>
      <div class="clip-thumb-play"><div class="play-circle">▶</div></div>
      <div class="clip-select-check">${isSelected?'✓':''}</div>
    </div>
    <div class="clip-body">
      <h3 class="clip-title">${esc(title)}</h3>
      <div class="clip-analytics">
        <div class="analytic-row">
          <span class="analytic-label">🔥 Hook</span>
          <div class="analytic-bar-wrap">
            <div class="analytic-bar"><div class="analytic-fill" style="width:${hookPct}%"></div></div>
            <span class="analytic-pct">${hookPct}%</span>
          </div>
        </div>
        <div class="analytic-row">
          <span class="analytic-label">❤️ Viral</span>
          <div class="analytic-bar-wrap">
            <div class="analytic-bar"><div class="analytic-fill pink" style="width:${viralPct}%"></div></div>
            <span class="analytic-pct">${viralPct}%</span>
          </div>
        </div>
        <div class="analytic-row">
          <span class="analytic-label">📊 Retention</span>
          <div class="analytic-bar-wrap">
            <div class="analytic-bar"><div class="analytic-fill ${retentionPct>=80?'green':retentionPct>=60?'':' amber'}" style="width:${retentionPct}%"></div></div>
            <span class="analytic-pct">${retentionPct}%</span>
          </div>
        </div>
      </div>
      <div class="clip-intel-row">
        <div class="clip-intel-item">
          <span>Style:</span>
          <b>${esc(c.captionStyle||'viral')}</b>
        </div>
        <div class="retention-badge ${dropoffRisk}">
          <div class="retention-dot"></div>
          ${dropoffRisk} drop-off
        </div>
        <div class="clip-intel-item"><span>${when(c.createdAt)}</span></div>
      </div>
      <div class="clip-actions" style="position:relative">
        <button class="clip-action-primary">▶ Preview</button>
        <a class="clip-action-icon" href="${esc(mediaUrl)}" download="clip-${c.id}.mp4" title="Download" onclick="event.stopPropagation()">⬇</a>
        <button class="clip-action-icon" data-more-clip="${c.id}" title="More options">•••</button>
        ${menuOpen ? `
        <div class="clip-context-menu">
          <button class="clip-menu-item" data-open-clip-detail="${c.id}"><span class="clip-menu-icon">◎</span>Full detail</button>
          <button class="clip-menu-item" data-copy="${encodeURIComponent(title)}"><span class="clip-menu-icon">⎘</span>Copy hook</button>
          <a class="clip-menu-item" href="${esc(mediaUrl)}" download="clip-${c.id}.mp4" onclick="event.stopPropagation()"><span class="clip-menu-icon">⬇</span>Download</a>
          <div style="height:1px;background:var(--border);margin:5px 0"></div>
          <button class="clip-menu-item danger" data-delete-clip-id="${c.id}"><span class="clip-menu-icon">✕</span>Delete</button>
        </div>` : ''}
      </div>
    </div>
  </article>`;
}

/* ── Clip Detail ─────────────────────────────────────────────────────── */
function renderClipDetail() {
  const c=state.clip;
  if (!c) { $('#clipDetail').innerHTML=empty('Choose a clip first.'); return; }
  const pa=c.postingAssistant||{};
  const pc=c.platformContent||pa.platformContent||{};
  const hooks=c.hooks||{};
  const thumbOptions=c.thumbnailOptions||[];
  const intel=c.intelligence||{};
  const dur2=Math.round((c.endSeconds||0)-(c.startSeconds||0));

  $('#clipDetail').innerHTML = `
    <div class="detail-grid">
      <!-- Left: video + scores -->
      <section class="panel stack">
        <div class="phone-frame">
          ${c.outputPath?`<video src="${clipUrl(c.outputPath)}" controls poster="${c.thumbnailPath||''}" playsinline></video>`:`<div class="demo-frame">${esc(c.hook)}</div>`}
        </div>
        <div class="score-panel">
          <div class="big-score ${scoreColor(c.score)}">${c.score}<small>/100</small></div>
          <div class="score-grid">
            ${[['Hook','hookStrength'],['Emotion','emotionalPunch'],['Controversy','controversy'],['Usefulness','usefulness'],['Story','storytelling'],['Shareability','shareability']].map(([l,k])=>c[k]?`<div class="score-item"><small>${l}</small><b>${c[k]}/10</b></div>`:'').join('')}
          </div>
        </div>
        <div class="meta" style="margin-top:8px">
          <span>${dur2}s clip</span>
          <span>${esc(c.reason||'educational')}</span>
          <span>Style: ${esc(c.captionStyle||'bold')}</span>
        </div>
        <a class="button" href="${clipUrl(c.outputPath)}" download="clip-${c.id}.mp4" style="text-align:center">⬇ Download clip</a>
        ${thumbOptions.length?`
          <div>
            <h4 style="margin-bottom:8px">Thumbnail options</h4>
            <div class="thumb-options">
              ${thumbOptions.map((t,i)=>`<div class="thumb-opt ${state.thumbTab===i?'active':''}" data-thumb-idx="${i}">
                <img src="${t.path}" alt="${esc(t.label)}">
                <small>${esc(t.label)}</small>
                <a href="${t.path}" download="thumb-${c.id}-${t.name}.jpg" class="dl-thumb">⬇</a>
              </div>`).join('')}
            </div>
          </div>
        `:`<button class="ghost" id="genThumbs">Generate thumbnails</button>`}
      </section>

      <!-- Right: tabs -->
      <div class="detail-right">
        <!-- Hooks -->
        <section class="panel">
          <div class="panel-head">
            <h3>AI Hooks <span class="eyebrow" style="margin-left:8px">6 styles</span></h3>
            <button class="ghost" id="regenHooks">Regenerate</button>
          </div>
          <div class="tab-row">
            ${Object.keys(HOOK_LABELS).map(k=>`<button class="tab ${state.hookTab===k?'active':''}" data-hook-tab="${k}">${HOOK_LABELS[k]}</button>`).join('')}
          </div>
          ${Object.entries(HOOK_LABELS).map(([k,l])=>`
            <div class="tab-panel ${state.hookTab===k?'active':''}" data-hook-panel="${k}">
              <div class="hook-text">"${esc(hooks[k]||c.hook||'')}"</div>
              <button class="ghost" data-copy="${encodeURIComponent(hooks[k]||c.hook||'')}">Copy</button>
            </div>
          `).join('')}
        </section>

        <!-- Platform content -->
        <section class="panel" style="margin-top:16px">
          <div class="panel-head">
            <h3>Platform content</h3>
            <button class="ghost" id="regenPlatform">Regenerate</button>
          </div>
          <div class="tab-row">
            ${['tiktok','youtube','instagram','x','linkedin','facebook'].map(p=>`<button class="tab ${state.platformTab===p?'active':''}" data-platform-tab="${p}">${p==='tiktok'?'TikTok':p==='youtube'?'YouTube':p==='instagram'?'Instagram':p==='x'?'X / Twitter':p==='linkedin'?'LinkedIn':'Facebook'}</button>`).join('')}
          </div>
          ${renderPlatformContent(pc)}
        </section>

        <!-- B-roll suggestions -->
        ${c.brollKeywords?.length?`
          <section class="panel" style="margin-top:16px">
            <h3>B-Roll keywords</h3>
            <p class="muted" style="margin-bottom:10px">Search these on Pexels, Shutterstock, or Pixabay</p>
            <div class="keyword-chips">
              ${c.brollKeywords.map(k=>`<div class="kw-chip" data-copy="${encodeURIComponent(k)}">${esc(k)} ⎘</div>`).join('')}
            </div>
          </section>
        `:''}

        <!-- Rationale -->
        <section class="panel" style="margin-top:16px">
          <h3>Why this clip works</h3>
          <p>${esc(c.rationale)}</p>
          ${c.transcriptExcerpt?`<details style="margin-top:12px"><summary class="muted">Transcript excerpt</summary><p style="margin-top:8px;font-size:13px;line-height:1.6">${esc(c.transcriptExcerpt)}</p></details>`:''}
        </section>
      </div>
    </div>`;

  // Hook tabs
  $$('[data-hook-tab]').forEach(btn => btn.addEventListener('click', () => {
    state.hookTab=btn.dataset.hookTab;
    $$('.tab[data-hook-tab]').forEach(b=>b.classList.toggle('active',b===btn));
    $$('[data-hook-panel]').forEach(p=>p.classList.toggle('active',p.dataset.hookPanel===btn.dataset.hookTab));
  }));

  // Platform tabs
  $$('[data-platform-tab]').forEach(btn => btn.addEventListener('click', () => {
    state.platformTab=btn.dataset.platformTab;
    $$('.tab[data-platform-tab]').forEach(b=>b.classList.toggle('active',b===btn));
    $$('[data-platform-panel]').forEach(p=>p.classList.toggle('active',p.dataset.platformPanel===btn.dataset.platformTab));
    renderPlatformPanels(pc);
  }));

  // Thumbnail tabs
  $$('[data-thumb-idx]').forEach(btn => btn.addEventListener('click', () => {
    state.thumbTab=Number(btn.dataset.thumbIdx);
    $$('[data-thumb-idx]').forEach(b=>b.classList.toggle('active',b===btn));
  }));

  $('#regenHooks')?.addEventListener('click', async () => {
    $('#regenHooks').textContent='Regenerating…'; $('#regenHooks').disabled=true;
    try {
      const res=await api('/api/hooks/generate',{method:'POST',body:JSON.stringify({clipId:c.id})});
      state.clip.hooks=res.hooks;
      renderClipDetail();
    } catch(e) { alert(e.message); }
  });

  $('#regenPlatform')?.addEventListener('click', async () => {
    $('#regenPlatform').textContent='Generating…'; $('#regenPlatform').disabled=true;
    try {
      const res=await api('/api/social/generate',{method:'POST',body:JSON.stringify({clipId:c.id})});
      state.clip.platformContent=res;
      renderClipDetail();
    } catch(e) { alert(e.message); }
  });

  $('#genThumbs')?.addEventListener('click', async () => {
    $('#genThumbs').textContent='Generating…'; $('#genThumbs').disabled=true;
    try {
      const res=await api('/api/thumbnail/generate',{method:'POST',body:JSON.stringify({clipId:c.id})});
      state.clip.thumbnailOptions=res.options;
      renderClipDetail();
    } catch(e) { alert(e.message); $('#genThumbs').textContent='Generate thumbnails'; $('#genThumbs').disabled=false; }
  });
}

function renderPlatformContent(pc) {
  return `<div id="platformPanels">
    ${['tiktok','youtube','instagram','x','linkedin','facebook'].map(p => `
      <div class="tab-panel ${state.platformTab===p?'active':''}" data-platform-panel="${p}">
        ${renderPlatformPanel(p, pc[p]||{})}
      </div>
    `).join('')}
  </div>`;
}

function renderPlatformPanels(pc) {
  const el=$('#platformPanels');
  if (!el) return;
  el.innerHTML = ['tiktok','youtube','instagram','x','linkedin','facebook'].map(p=>`
    <div class="tab-panel ${state.platformTab===p?'active':''}" data-platform-panel="${p}">
      ${renderPlatformPanel(p, pc[p]||{})}
    </div>
  `).join('');
  $$('[data-platform-panel] [data-copy]').forEach(btn=>{
    btn.addEventListener('click', ()=>navigator.clipboard?.writeText(decodeURIComponent(btn.dataset.copy)));
  });
}

function renderPlatformPanel(platform, data) {
  if (!data || !Object.keys(data).length) return `<div class="empty-state" style="padding:20px"><p>Click "Regenerate" to generate ${platform} content.</p></div>`;
  const lines = [];
  if (data.title) lines.push(`<div class="content-field"><label>Title</label><div class="content-val">${esc(data.title)}</div><button class="ghost" data-copy="${encodeURIComponent(data.title)}">Copy</button></div>`);
  if (data.caption) lines.push(`<div class="content-field"><label>Caption</label><div class="content-val">${esc(data.caption)}</div><button class="ghost" data-copy="${encodeURIComponent(data.caption)}">Copy</button></div>`);
  if (data.post) lines.push(`<div class="content-field"><label>Post</label><div class="content-val">${esc(data.post)}</div><button class="ghost" data-copy="${encodeURIComponent(data.post)}">Copy</button></div>`);
  if (data.tweet) lines.push(`<div class="content-field"><label>Tweet</label><div class="content-val">${esc(data.tweet)}</div><button class="ghost" data-copy="${encodeURIComponent(data.tweet)}">Copy</button></div>`);
  if (data.description) lines.push(`<div class="content-field"><label>Description</label><div class="content-val">${esc(data.description)}</div><button class="ghost" data-copy="${encodeURIComponent(data.description)}">Copy</button></div>`);
  const tags=[...(data.hashtags||[]),(data.tags||[])].flat().filter(Boolean);
  if (tags.length) lines.push(`<div class="content-field"><label>Hashtags</label><div class="keyword-chips">${tags.map(t=>`<span class="kw-chip">${esc(t)}</span>`).join('')}</div><button class="ghost" data-copy="${encodeURIComponent(tags.join(' '))}">Copy all</button></div>`);
  if (data.bestTime) lines.push(`<p class="muted" style="margin-top:8px">Best time to post: <b>${esc(data.bestTime)}</b></p>`);
  if (data.tip) lines.push(`<p class="muted"><b>Tip:</b> ${esc(data.tip)}</p>`);
  if (data.insight) lines.push(`<p class="muted"><b>Key insight:</b> ${esc(data.insight)}</p>`);
  return lines.join('') || `<div class="empty-state" style="padding:16px"><p>Content for ${platform} not yet generated.</p></div>`;
}

/* ── AI Studio ─────────────────────────────────────────────────────── */
async function renderStudio() {
  if (!state.studioStatus) {
    try { state.studioStatus=await api('/api/studio/status'); } catch {}
  }
  if (!state.studioModels.length) {
    try { const m=await api('/api/ai/models'); state.studioModels=m.models||[]; } catch {}
  }
  if (state.studioTab==='aiVoice' && !state.ttsVoices.length) {
    try { const v=await api('/api/tts/voices'); state.ttsVoices=v.voices||[]; if (!state.ttsVoiceId && state.ttsVoices.length) state.ttsVoiceId=state.ttsVoices[0].id; } catch {}
  }
  if (['aiVideoGen','aiImageGen','lipSync'].includes(state.studioTab) && !state.generations.length) {
    try { const r=await api('/api/ai/generations'); state.generations=r.generations||[]; } catch {}
    const hasPending = state.generations.some(g=>['queued','generating'].includes(g.status));
    if (hasPending && !_genPollTimer) { clearTimeout(_genPollTimer); _genPollTimer=setTimeout(loadGenerations,5000); }
  }
  const features=state.studioStatus?.features||{};
  const videos=state.library.videos||[];

  $('#studio').innerHTML = `
    <div class="studio-wrap">
      <div class="studio-sidebar">
        ${Object.entries(features).map(([key,f])=>`
          <div class="feature-item ${state.studioTab===key?'active':''}" data-studio-tab="${key}">
            <div class="feature-dot ${f.available?'on':'off'}"></div>
            <div>
              <b>${esc(f.label)}</b>
              ${!f.available&&f.setupKey?`<small class="muted">Needs setup</small>`:''}
            </div>
          </div>
        `).join('')}
      </div>
      <div class="studio-main">
        ${renderStudioPanel(features, videos)}
      </div>
    </div>`;

  $$('[data-studio-tab]').forEach(btn=>btn.addEventListener('click',()=>{
    state.studioTab=btn.dataset.studioTab;
    renderStudio();
  }));
  $('#facelessForm')?.addEventListener('submit', runFaceless);
  $('#brollForm')?.addEventListener('submit', runBroll);
  $('#aiGeneratorForm')?.addEventListener('submit', runAiGenerator);
  $('#ttsForm')?.addEventListener('submit', runTts);
  $('#ttsText')?.addEventListener('input', e => { const el=$('#ttsCharCount'); if(el) el.textContent=`${e.target.value.length}/5000 characters`; });
  $('#ttsPreviewVoice')?.addEventListener('click', () => {
    const vid = $('#ttsVoice')?.value;
    const v = state.ttsVoices.find(x=>x.id===vid);
    if (v?.preview) { new Audio(v.preview).play().catch(()=>{}); }
  });
}

function renderStudioPanel(features, videos) {
  const f=features[state.studioTab];
  if (!f) return empty('Select a feature from the left.');

  if (state.studioTab==='facelessContent') return renderFacelessPanel(f);
  if (state.studioTab==='digitalHuman')    return renderDHStudioPanel(f);
  if (state.studioTab==='brollSuggestions') return renderBrollPanel(f, [], videos);
  if (state.studioTab==='aiVoice') return renderVoicePanel(f);
  if (state.studioTab==='aiVideoGen' || state.studioTab==='aiImageGen' || state.studioTab==='lipSync') {
    return renderAiGeneratorPanel(f, state.studioTab);
  }

  const available=f.available;
  return `<div class="studio-panel">
    <div class="feature-header">
      <div class="feature-badge ${available?'on':'off'}">${available?'Available':'Needs Setup'}</div>
      <h2>${esc(f.label)}</h2>
      <p>${esc(f.description)}</p>
    </div>
    ${available
      ? `<div class="feature-ready">
           <div class="ready-icon">✓</div>
           <p>This feature is active. It runs automatically when you generate clips.</p>
           ${state.studioTab==='hookGeneration'?`<p class="muted">Open any clip → Hooks tab to see all 6 hook styles.</p>`:''}
           ${state.studioTab==='platformContent'?`<p class="muted">Open any clip → Platform Content tab to see posts for all 6 platforms.</p>`:''}
           ${state.studioTab==='thumbnails'?`<p class="muted">Open any clip → click "Generate thumbnails" for 3 styles.</p>`:''}
           ${state.studioTab==='captions'?`<p class="muted">Select caption style when creating clips. Options: ${CAPTION_STYLES.join(', ')}.</p>`:''}
           ${state.studioTab==='viralDetection'?`<p class="muted">AI scores every clip across 6 dimensions: hook strength, emotional punch, controversy, usefulness, storytelling, shareability.</p>`:''}
           ${state.studioTab==='transcription'?`<p class="muted">Transcription runs automatically on upload. View full transcripts in the Transcript viewer.</p><button class="ghost" data-view-jump="transcript">View transcript</button>`:''}
           ${state.studioTab==='translation'?`<p class="muted">Caption translation is available when generating clips. Select target language in settings.</p>`:''}
         </div>`
      : `<div class="setup-required">
           <h3>${f.label||'Feature unavailable'}</h3>
           <p>This feature requires additional setup.</p>
           ${state.session?.user?.role==='admin'
             ? `<button data-view-jump="admin">Configure in Admin →</button>`
             : `<small class="muted">Contact your administrator to enable this feature.</small>`}
         </div>`}
  </div>`;
}

function renderAiGeneratorPanel(f, tabKey) {
  const categoryMap = { aiVideoGen: 't2v', aiImageGen: 't2i', lipSync: 'lipsync' };
  const cat = categoryMap[tabKey] || 't2v';
  const models = state.studioModels.filter(m => m.category === cat || (cat==='t2v' && m.category==='i2v'));
  const gens = (state.generations || []).filter(g => {
    const m = state.studioModels.find(mm=>mm.id===g.model);
    return m && (m.category===cat || (cat==='t2v' && m.category==='i2v'));
  });
  const needsImage = state.generatorModel && state.studioModels.find(m=>m.id===state.generatorModel)?.category==='i2v';
  const needsLipsync = cat==='lipsync';

  return `<div class="studio-panel">
    <div class="feature-header">
      <div class="feature-badge ${f.available?'on':'off'}">${f.available?'Available':'Needs Setup'}</div>
      <h2>${esc(f.label)}</h2>
      <p>${esc(f.description)}</p>
    </div>
    ${f.available?`
      <form id="aiGeneratorForm" class="stack" style="max-width:580px" data-cat="${cat}">
        <div class="option-row">
          <label>Model</label>
          <select id="genModel">
            ${models.map(m=>`<option value="${m.id}" ${state.generatorModel===m.id?'selected':''}>${esc(m.label)} ${m.seconds?`(${m.seconds}s)`:''}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>${cat==='lipsync'?'Video URL (talking head)':'Prompt — describe the scene'}</label>
          <textarea id="genPrompt" rows="3" placeholder="${cat==='t2i'?'A cinematic shot of...':cat==='lipsync'?'https://... (video URL)':'A dynamic video of...'}">${esc(state.generatorPrompt)}</textarea>
        </div>
        ${needsImage||needsLipsync?`
          <div>
            <label>${needsLipsync?'Audio URL (voice-over)':'Starting image URL (optional)'}</label>
            <input id="genImageUrl" type="text" placeholder="https://..." value="${esc(state.generatorImageUrl)}">
          </div>
        `:''}
        ${cat!=='lipsync'?`
          <div>
            <label>Negative prompt (optional)</label>
            <input id="genNeg" type="text" placeholder="blurry, low quality, text..." value="${esc(state.generatorNeg)}">
          </div>
        `:''}
        <button type="submit" ${state.generatorRunning?'disabled':''}>
          ${state.generatorRunning?'Generating… (check back in ~30s)':'Generate →'}
        </button>
        ${state.generatorResult?.error?`<div class="message error">${esc(state.generatorResult.error)}</div>`:''}
        ${state.generatorResult?.id&&!state.generatorResult.error?`<div class="message success">Queued! Refresh to see result below.</div>`:''}
      </form>

      ${gens.length?`
        <div style="margin-top:24px">
          <div class="panel-head" style="margin-bottom:12px">
            <h3>Generated ${cat==='t2i'?'images':'videos'}</h3>
            <button class="ghost" onclick="loadGenerations()">Refresh</button>
          </div>
          <div class="gen-gallery">${gens.map(genCard).join('')}</div>
        </div>
      `:''}
    `:setupRequired(f)}
  </div>`;
}

function genCard(g) {
  const isVideo = !state.studioModels.find(m=>m.id===g.model&&m.category==='t2i');
  const isReady = g.status==='completed' && g.outputPath;
  const isPending = ['queued','generating'].includes(g.status);
  return `<div class="gen-card ${isPending?'pending':''}">
    ${isReady
      ? (isVideo
          ? `<video src="${g.outputPath}" controls muted playsinline loop></video>`
          : `<img src="${g.outputPath}" alt="Generated image">`)
      : `<div class="gen-placeholder">${isPending?`<div class="gen-spinner">⟳</div><small>${esc(g.status)}</small>`:`<div class="error-text">${esc(g.error||'Failed')}</div>`}</div>`
    }
    <div class="gen-card-info">
      <p class="gen-prompt">${esc((g.prompt||'').slice(0,80))}</p>
      <div class="action-row">
        ${isReady?`<a class="button ghost" href="${g.outputPath}" download>Download</a>`:''}
        <button class="ghost danger-btn" data-delete-gen="${g.id}">Delete</button>
      </div>
    </div>
  </div>`;
}

let _genPollTimer = null;

async function loadGenerations() {
  try {
    const res = await api('/api/ai/generations');
    state.generations = res.generations || [];
    renderStudio();
    // auto-poll while any generation is still pending
    const hasPending = state.generations.some(g => ['queued','generating'].includes(g.status));
    if (hasPending) {
      clearTimeout(_genPollTimer);
      _genPollTimer = setTimeout(loadGenerations, 5000);
    }
  } catch(e) { console.warn('loadGenerations', e.message); }
}

async function runAiGenerator(e) {
  e.preventDefault();
  const model = $('#genModel')?.value;
  const prompt = $('#genPrompt')?.value?.trim();
  const imageUrl = $('#genImageUrl')?.value?.trim() || '';
  const negativePrompt = $('#genNeg')?.value?.trim() || '';
  if (!model || !prompt) return;
  state.generatorModel=model; state.generatorPrompt=prompt; state.generatorImageUrl=imageUrl; state.generatorNeg=negativePrompt;
  state.generatorRunning=true; state.generatorResult=null;
  renderStudio();
  try {
    const res = await api('/api/ai/generate', { method:'POST', body: JSON.stringify({ model, prompt, negativePrompt, imageUrl }) });
    state.generatorResult = res;
    state.generatorRunning = false;
    // start polling immediately — server runs generation async
    clearTimeout(_genPollTimer);
    _genPollTimer = setTimeout(loadGenerations, 5000);
    renderStudio();
  } catch(err) {
    state.generatorResult = { error: err.message };
    state.generatorRunning = false;
    renderStudio();
  }
}

/* ── Faceless Studio (dedicated page) ────────────────────────────── */
const FL_STYLES = [
  {v:'documentary',l:'Documentary'},{v:'motivation',l:'Motivation'},{v:'finance',l:'Finance'},
  {v:'crypto',l:'Crypto'},{v:'education',l:'Education'},{v:'comedy',l:'Comedy'},
  {v:'luxury',l:'Luxury'},{v:'horror',l:'Horror'},{v:'ai',l:'AI & Tech'},
  {v:'history',l:'History'},{v:'crime',l:'True Crime'},{v:'health',l:'Health'},
  {v:'business',l:'Business'},{v:'space',l:'Space'},
  {v:'reddit',l:'Reddit Story'},{v:'kids',l:'Kids Content'},{v:'news',l:'Breaking News'},
  {v:'wellness',l:'Wellness'},{v:'sports',l:'Sports'},{v:'travel',l:'Travel'},
  {v:'relationship',l:'Relationship'},{v:'conspiracy',l:'Mystery/Conspiracy'}
];
const FL_TONES = ['mysterious','energetic','calm','authoritative','conversational','dramatic','inspirational','urgent'];
const FL_PLATFORMS = ['TikTok','YouTube Shorts','Instagram Reels'];
const FL_DURATIONS = [{v:60,l:'1 min'},{v:90,l:'90 s'},{v:120,l:'2 min'},{v:180,l:'3 min'}];
const FL_LANGUAGES = ['English','Spanish','French','Portuguese','German','Arabic','Hindi','Japanese'];
const FL_AUDIENCES = [
  {v:'general',l:'General'},{v:'18-24',l:'18-24 Gen Z'},{v:'25-35',l:'25-35 Millennials'},
  {v:'entrepreneurs',l:'Entrepreneurs'},{v:'students',l:'Students'},{v:'investors',l:'Investors'},
  {v:'fitness',l:'Fitness'},{v:'parents',l:'Parents'}
];
const FL_CTAS = [
  {v:'follow',l:'Follow for more'},{v:'comment',l:'Comment below'},{v:'share',l:'Share this'},
  {v:'link',l:'Link in bio'},{v:'subscribe',l:'Subscribe'},{v:'save',l:'Save for later'}
];
const FL_MODES = [
  {v:'revelation',l:'Revelation'},{v:'countdown',l:'Countdown'},{v:'story',l:'Storytelling'},
  {v:'tutorial',l:'Tutorial'},{v:'debate',l:'Debate'},{v:'mystery',l:'Mystery'}
];

function renderFaceless() {
  const f = state.fl;
  const res = f.result;
  const loading = f.loading;

  $('#faceless').innerHTML = `
    <div class="fl-wrap">
      <div class="fl-form-col">
        <div class="fl-form-head">
          <div class="fl-badge">AI Content Generator</div>
          <p>Type a topic. AI writes a complete viral script, scene directions, prompts, SEO copy, and hashtags — ready to produce.</p>
        </div>
        <form id="flForm" class="fl-form">
          <div class="fl-field">
            <label class="fl-label">Topic <span class="fl-req">*</span></label>
            <input id="flTopic" class="fl-input" type="text" placeholder="e.g. Why Bitcoin will hit $1M this cycle" value="${esc(f.topic)}" required autocomplete="off">
          </div>

          <div class="fl-row2">
            <div class="fl-field">
              <label class="fl-label">Style</label>
              <select id="flStyle" class="fl-select">
                ${FL_STYLES.map(s=>`<option value="${s.v}" ${f.style===s.v?'selected':''}>${s.l}</option>`).join('')}
              </select>
            </div>
            <div class="fl-field">
              <label class="fl-label">Duration</label>
              <select id="flDuration" class="fl-select">
                ${FL_DURATIONS.map(d=>`<option value="${d.v}" ${f.duration==d.v?'selected':''}>${d.l}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="fl-row2">
            <div class="fl-field">
              <label class="fl-label">Platform</label>
              <select id="flPlatform" class="fl-select">
                ${FL_PLATFORMS.map(p=>`<option value="${p}" ${f.platform===p?'selected':''}>${p}</option>`).join('')}
              </select>
            </div>
            <div class="fl-field">
              <label class="fl-label">Tone</label>
              <select id="flTone" class="fl-select">
                ${FL_TONES.map(t=>`<option value="${t}" ${f.tone===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="fl-row2">
            <div class="fl-field">
              <label class="fl-label">Language</label>
              <select id="flLanguage" class="fl-select">
                ${FL_LANGUAGES.map(l=>`<option value="${l}" ${f.language===l?'selected':''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="fl-field">
              <label class="fl-label">Audience</label>
              <select id="flAudience" class="fl-select">
                ${FL_AUDIENCES.map(a=>`<option value="${a.v}" ${f.audienceType===a.v?'selected':''}>${a.l}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="fl-row2">
            <div class="fl-field">
              <label class="fl-label">Storytelling Mode</label>
              <select id="flMode" class="fl-select">
                ${FL_MODES.map(m=>`<option value="${m.v}" ${f.storytellingMode===m.v?'selected':''}>${m.l}</option>`).join('')}
              </select>
            </div>
            <div class="fl-field">
              <label class="fl-label">CTA Type</label>
              <select id="flCta" class="fl-select">
                ${FL_CTAS.map(c=>`<option value="${c.v}" ${f.ctaType===c.v?'selected':''}>${c.l}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="fl-field">
            <label class="fl-label">Hook Strength: <b id="flHookVal">${f.hookStrength}</b>/10</label>
            <input id="flHook" type="range" min="1" max="10" value="${f.hookStrength}" class="fl-range">
            <div class="fl-range-labels"><span>Subtle</span><span>Balanced</span><span>Ultra-viral</span></div>
          </div>

          <button type="submit" class="fl-submit ${loading?'loading':''}" ${loading?'disabled':''}>
            ${loading?'<span class="fl-spinner"></span> Generating script…':'Generate script'}
          </button>
        </form>

        <div class="fl-next-steps">
          <div class="fl-next-title">After generating your script:</div>
          <div class="fl-next-grid">
            <div class="fl-next-item" data-view="studio">
              <div class="fl-next-icon">🎬</div>
              <div><b>AI Video Studio</b><small>Generate AI video from scene prompts</small></div>
              <span class="fl-next-badge">→</span>
            </div>
            <div class="fl-next-item" data-view="studio">
              <div class="fl-next-icon">🎙</div>
              <div><b>AI Voiceover</b><small>ElevenLabs TTS from your script</small></div>
              <span class="fl-next-badge">→</span>
            </div>
            <div class="fl-next-item" data-view="studio">
              <div class="fl-next-icon">🎨</div>
              <div><b>AI Image Studio</b><small>Generate FLUX / Ideogram scene images</small></div>
              <span class="fl-next-badge">→</span>
            </div>
            <div class="fl-next-item" data-view="create">
              <div class="fl-next-icon">✂</div>
              <div><b>Clip &amp; Caption</b><small>Upload your recorded video to clip it</small></div>
              <span class="fl-next-badge">→</span>
            </div>
          </div>
        </div>
      </div>

      <div class="fl-output-col">
        ${loading ? `
          <div class="fl-generating">
            <div class="fl-gen-spinner"></div>
            <p>AI is writing your script…</p>
            <small>Takes 10-30 seconds</small>
          </div>
        ` : res ? renderFacelessOutput(res) : `
          <div class="fl-empty">
            <div class="fl-empty-icon">◈</div>
            <h3>Your script will appear here</h3>
            <p>Fill in your topic and preferences, then click Generate to get a complete viral script package.</p>
          </div>
        `}
      </div>
    </div>`;

  $('#flHook')?.addEventListener('input', e => { $('#flHookVal').textContent = e.target.value; });
  $('#flForm')?.addEventListener('submit', submitFaceless);
  $('#flCopyAll')?.addEventListener('click', () => {
    if (!f.result) return;
    const r = f.result;
    const all = [
      `TITLE: ${r.title||''}`,
      `\nHOOK:\n${r.hook||''}`,
      `\nFULL SCRIPT:\n${r.script||''}`,
      r.scenes?.length ? `\nSCENES:\n${r.scenes.map(s=>`[${s.timestamp}]\nNarration: ${s.narration}\nVisual: ${s.visualDirection}\nB-roll: ${s.brollQuery}\nImage prompt: ${s.imagePrompt||''}\nVideo prompt: ${s.videoPrompt||''}`).join('\n\n')}` : '',
      r.brollKeywords?.length ? `\nB-ROLL KEYWORDS:\n${r.brollKeywords.join(', ')}` : '',
      r.thumbnailTitle ? `\nTHUMBNAIL TITLE:\n${r.thumbnailTitle}` : '',
      r.thumbnailPrompt ? `\nTHUMBNAIL PROMPT:\n${r.thumbnailPrompt}` : '',
      r.seoTitle ? `\nSEO TITLE:\n${r.seoTitle}` : '',
      r.description ? `\nDESCRIPTION:\n${r.description}` : '',
      r.hashtags?.length ? `\nHASHTAGS:\n${r.hashtags.join(' ')}` : '',
      r.cta ? `\nCTA:\n${r.cta}` : '',
      r.captions?.length ? `\nCAPTIONS:\n${r.captions.join('\n')}` : '',
    ].filter(Boolean).join('\n');
    navigator.clipboard?.writeText(all).then(() => {
      const btn = $('#flCopyAll'); const orig = btn.textContent; btn.textContent = 'Copied all!';
      setTimeout(() => { btn.textContent = orig; }, 1800);
    });
  });
}

function renderFacelessOutput(res) {
  if (!res.ok) return `<div class="fl-error"><div class="fl-err-icon">⚠</div><p>${esc(res.error || 'Generation failed. The AI service may not be configured yet.')}</p><small style="color:var(--muted)">If this persists, contact support.</small></div>`;

  const copyBtn = (text, label='Copy') =>
    `<button class="fl-copy-btn ghost" data-copy="${encodeURIComponent(text||'')}">${label}</button>`;

  const section = (title, content, extraBtn='') => `
    <div class="fl-section">
      <div class="fl-section-head">
        <span class="fl-section-title">${title}</span>
        <div class="fl-section-actions">${extraBtn}${copyBtn(content)}</div>
      </div>
      <div class="fl-section-body">${content}</div>
    </div>`;

  const blockSection = (title, textContent) =>
    section(title, textContent, '');

  const scenes = (res.scenes||[]).map((s,i) => `
    <div class="fl-scene">
      <div class="fl-scene-ts">${esc(s.timestamp||`Scene ${i+1}`)}</div>
      <div class="fl-scene-narr">${esc(s.narration||'')}</div>
      <div class="fl-scene-details">
        <div class="fl-scene-row"><span class="fl-scene-label">Visual</span><span>${esc(s.visualDirection||'')}</span></div>
        <div class="fl-scene-row"><span class="fl-scene-label">B-roll</span><span>${esc(s.brollQuery||'')}</span></div>
        ${s.imagePrompt?`<div class="fl-scene-row"><span class="fl-scene-label">Image prompt</span><span>${esc(s.imagePrompt)}</span>${copyBtn(s.imagePrompt,'Copy')}</div>`:''}
        ${s.videoPrompt?`<div class="fl-scene-row"><span class="fl-scene-label">Video prompt</span><span>${esc(s.videoPrompt)}</span>${copyBtn(s.videoPrompt,'Copy')}</div>`:''}
      </div>
    </div>`).join('');

  const hashtagStr = (res.hashtags||[]).join(' ');
  const captionStr = (res.captions||[]).join('\n');
  const brollStr = (res.brollKeywords||[]).join(', ');

  return `<div class="fl-output">
    <div class="fl-output-header">
      <div>
        <div class="fl-output-title">${esc(res.title||'Generated Script')}</div>
        <div class="fl-output-meta">
          ${res.estimatedSeconds?`<span>${res.estimatedSeconds}s</span>`:''}
          ${res.voiceStyle?`<span>Voice: ${esc(res.voiceStyle)}</span>`:''}
          ${res.wordCount?`<span>${res.wordCount} words</span>`:''}
        </div>
      </div>
      <button id="flCopyAll" class="fl-copy-all-btn">Copy all</button>
    </div>

    <div class="fl-section fl-hook-section">
      <div class="fl-section-head">
        <span class="fl-section-title">Hook — First 3 seconds</span>
        ${copyBtn(res.hook||'')}
      </div>
      <div class="fl-hook-text">"${esc(res.hook||'')}"</div>
    </div>

    ${blockSection('Full Script', res.script||'')}

    <div class="fl-section">
      <div class="fl-section-head">
        <span class="fl-section-title">Scene Breakdown (${(res.scenes||[]).length} scenes)</span>
        ${copyBtn((res.scenes||[]).map(s=>`[${s.timestamp}] ${s.narration} | Visual: ${s.visualDirection} | B-roll: ${s.brollQuery}`).join('\n'))}
      </div>
      <div class="fl-scenes">${scenes||'<p class="muted">No scenes generated.</p>'}</div>
    </div>

    ${res.brollKeywords?.length ? `
    <div class="fl-section">
      <div class="fl-section-head">
        <span class="fl-section-title">B-roll Keywords</span>
        ${copyBtn(brollStr)}
      </div>
      <div class="fl-chips">${(res.brollKeywords||[]).map(k=>`<span class="fl-chip" data-copy="${encodeURIComponent(k)}">${esc(k)}</span>`).join('')}</div>
    </div>` : ''}

    ${res.thumbnailTitle ? blockSection('Thumbnail Title', res.thumbnailTitle) : ''}
    ${res.thumbnailPrompt ? blockSection('Thumbnail Image Prompt', res.thumbnailPrompt) : ''}
    ${res.seoTitle ? blockSection('SEO Title', res.seoTitle) : ''}
    ${res.description ? blockSection('Video Description', res.description) : ''}

    ${res.hashtags?.length ? `
    <div class="fl-section">
      <div class="fl-section-head">
        <span class="fl-section-title">Hashtags (${(res.hashtags||[]).length})</span>
        ${copyBtn(hashtagStr)}
      </div>
      <div class="fl-chips">${(res.hashtags||[]).map(h=>`<span class="fl-chip tag" data-copy="${encodeURIComponent(h)}">${esc(h)}</span>`).join('')}</div>
    </div>` : ''}

    ${res.cta ? blockSection('Call to Action', res.cta) : ''}

    ${res.captions?.length ? `
    <div class="fl-section">
      <div class="fl-section-head">
        <span class="fl-section-title">Caption Lines</span>
        ${copyBtn(captionStr)}
      </div>
      <div class="fl-caption-list">${(res.captions||[]).map(c=>`<div class="fl-caption-line">${esc(c)}</div>`).join('')}</div>
    </div>` : ''}

    ${res.backgroundMusic ? `
    <div class="fl-section fl-music">
      <span class="fl-section-title">Background Music</span>
      <span class="fl-music-val">${esc(res.backgroundMusic)}</span>
    </div>` : ''}
  </div>`;
}

async function submitFaceless(e) {
  e.preventDefault();
  const f = state.fl;
  f.topic = $('#flTopic')?.value?.trim() || '';
  f.style = $('#flStyle')?.value || 'documentary';
  f.duration = Number($('#flDuration')?.value || 45);
  f.platform = $('#flPlatform')?.value || 'TikTok';
  f.tone = $('#flTone')?.value || 'mysterious';
  f.language = $('#flLanguage')?.value || 'English';
  f.audienceType = $('#flAudience')?.value || 'general';
  f.storytellingMode = $('#flMode')?.value || 'revelation';
  f.ctaType = $('#flCta')?.value || 'follow';
  f.hookStrength = Number($('#flHook')?.value || 8);
  if (!f.topic) return;
  f.result = null;
  f.loading = true;
  renderFaceless();
  try {
    const res = await api('/api/faceless/generate', { method:'POST', body: JSON.stringify({
      topic: f.topic, style: f.style, duration: f.duration,
      tone: f.tone, language: f.language, platform: f.platform,
      hookStrength: f.hookStrength, audienceType: f.audienceType,
      ctaType: f.ctaType, storytellingMode: f.storytellingMode
    })});
    f.result = res;
  } catch(err) {
    f.result = { ok: false, error: err.message };
  } finally {
    f.loading = false;
    renderFaceless();
  }
}

function renderVoicePanel(f) {
  const r = state.ttsResult;
  const voices = state.ttsVoices;
  return `<div class="studio-panel">
    <div class="feature-header">
      <div class="feature-badge ${f.available?'on':'off'}">${f.available?'Available':'Needs Setup'}</div>
      <h2>AI Voiceover (TTS)</h2>
      <p>${esc(f.description)}</p>
    </div>
    ${f.available ? `
      <form id="ttsForm" class="stack" style="max-width:620px">
        <div>
          <label>Script / Text</label>
          <textarea id="ttsText" rows="6" placeholder="Type or paste your voiceover script here…" style="width:100%;resize:vertical">${esc(state.ttsText)}</textarea>
          <small class="muted" id="ttsCharCount">${state.ttsText.length}/5000 characters</small>
        </div>
        <div class="option-row">
          <label>Voice</label>
          <select id="ttsVoice">
            ${voices.length
              ? voices.map(v=>`<option value="${esc(v.id)}" ${state.ttsVoiceId===v.id?'selected':''}>${esc(v.name)}</option>`).join('')
              : `<option value="">Loading voices…</option>`}
          </select>
          ${voices.length && voices[0].preview ? `<a class="muted" style="font-size:12px;cursor:pointer" id="ttsPreviewVoice">▶ Preview voice</a>` : ''}
        </div>
        <div class="form-actions">
          <button type="submit" class="primary" ${state.ttsLoading?'disabled':''}>
            ${state.ttsLoading?'Generating…':'Generate Voiceover'}
          </button>
        </div>
      </form>
      ${r ? `
        <div class="tts-result" style="margin-top:24px;padding:20px;background:var(--bg2);border-radius:16px;border:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div style="font-weight:700;font-size:15px">Voiceover ready</div>
            <div class="feature-badge on" style="font-size:11px">${r.chars} chars</div>
          </div>
          <audio controls src="${esc(r.url)}" style="width:100%;border-radius:10px;accent-color:var(--accent)"></audio>
          <div style="margin-top:12px;display:flex;gap:10px">
            <a href="${esc(r.url)}" download="${esc(r.filename)}" class="btn-sm">Download MP3</a>
          </div>
        </div>
      ` : ''}
    ` : `
      <div class="setup-required">
        <h3>API Key Required</h3>
        <p>Add your <b>ElevenLabs</b> key in Admin Settings to unlock TTS.<br>
        Or if you already have <b>OpenAI</b> configured as your LLM provider, TTS is available automatically.</p>
        ${state.session?.user?.role==='admin'
          ? `<button data-view-jump="admin">Configure in Admin →</button>`
          : `<small class="muted">Contact your administrator to enable this feature.</small>`}
      </div>
    `}
  </div>`;
}

async function runTts(e) {
  e.preventDefault();
  const text = $('#ttsText')?.value?.trim() || '';
  const voiceId = $('#ttsVoice')?.value || '';
  if (!text) return toast('Enter some text first.');
  state.ttsText = text;
  state.ttsVoiceId = voiceId;
  state.ttsLoading = true;
  state.ttsResult = null;
  renderStudio();
  try {
    const result = await api('/api/tts/generate', { method:'POST', body: JSON.stringify({ text, voiceId }) });
    state.ttsResult = result;
    toast('Voiceover generated!');
  } catch(err) {
    toast(err.message || 'TTS failed');
  } finally {
    state.ttsLoading = false;
    renderStudio();
  }
}

function renderDHStudioPanel(f) {
  return `<div class="studio-panel">
    <div class="feature-header">
      <div class="feature-badge on">Available</div>
      <h2>AI Digital Human Studio</h2>
      <p>Generate talking-head videos with real lip sync, AI voice, and word-level captions — 9:16 portrait format ready for TikTok, Reels, and Shorts.</p>
    </div>
    <div class="feature-ready" style="gap:0;padding:0;background:transparent;border:none">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px">
        ${[
          ['🧑','Talking Head','Type a script, AI speaks it with your face','talking_head'],
          ['📢','Ad Video','Persuasive product ads in 30–60 seconds','ad_video'],
          ['🎤','Presenter','Professional presenting style','presenter'],
          ['⭐','Influencer','Social-media native content','influencer'],
        ].map(([icon,title,desc,mode])=>`
        <div style="background:#1a1a24;border:1px solid #2a2a3a;border-radius:10px;padding:16px;cursor:pointer;transition:all .2s"
          onclick="setView('digitalHuman');_dhState.mode='${mode}';_dhState.view='generate'">
          <div style="font-size:1.4rem;margin-bottom:8px">${icon}</div>
          <div style="font-weight:700;font-size:.85rem;margin-bottom:4px">${title}</div>
          <div style="font-size:.75rem;color:#6b6b8a">${desc}</div>
        </div>`).join('')}
      </div>
      <button class="primary" style="width:100%;padding:14px;font-size:.95rem" onclick="setView('digitalHuman')">
        Open Digital Human Studio →
      </button>
    </div>
  </div>`;
}

function renderFacelessPanel(f) {
  const res=state.facelessResult;
  return `<div class="studio-panel">
    <div class="feature-header">
      <div class="feature-badge ${f.available?'on':'off'}">${f.available?'Available':'Needs Setup'}</div>
      <h2>Faceless Content Mode</h2>
      <p>Type a topic. AI writes a complete script with scene directions, B-roll queries, and caption lines.</p>
    </div>
    ${f.available?`
      <form id="facelessForm" class="stack" style="max-width:520px">
        <input id="facelessTopic" type="text" placeholder="e.g. Why Bitcoin will hit $1M" value="${esc(state.facelessTopic)}" required>
        <div class="option-row">
          <label>Style</label>
          <select id="facelessStyle">
            ${FACELESS_STYLES.map(s=>`<option value="${s}" ${state.facelessStyle===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div class="option-row">
          <label>Duration</label>
          <select id="facelessDur">
            <option value="60" selected>1 minute</option>
            <option value="90">90 seconds</option>
            <option value="120">2 minutes</option>
          </select>
        </div>
        <button type="submit">Generate script</button>
      </form>
      ${res?renderFacelessResult(res):''}
    `:setupRequired(f)}
  </div>`;
}

function renderFacelessResult(res) {
  if (!res.ok) return `<div class="message error">${esc(res.error||'Generation failed.')}</div>`;
  return `<div class="faceless-result">
    <div class="panel-head"><h3>${esc(res.title||'Generated Script')}</h3><button class="ghost" data-copy="${encodeURIComponent(res.script||'')}">Copy script</button></div>
    <div class="hook-text">"${esc(res.hook||'')}"</div>
    <div class="scene-list">
      ${(res.scenes||[]).map(s=>`<div class="scene-card">
        <div class="scene-time">${esc(s.timestamp)}</div>
        <div class="scene-narration">${esc(s.narration)}</div>
        <div class="scene-meta">
          <small>📹 ${esc(s.visualDirection)}</small>
          <small>🔍 Search: "${esc(s.brollQuery)}"</small>
        </div>
      </div>`).join('')}
    </div>
    <div class="content-field"><label>Full script</label><div class="content-val">${esc(res.script||'')}</div></div>
    <div class="meta">
      <span>${res.estimatedSeconds||45}s estimated</span>
      <span>Voice: ${esc(res.voiceStyle||'')}</span>
      <span>Music: ${esc(res.backgroundMusic||'')}</span>
    </div>
  </div>`;
}

function renderBrollPanel(f, transcriptions, videos) {
  return `<div class="studio-panel">
    <div class="feature-header">
      <div class="feature-badge ${f.available?'on':'off'}">${f.available?'Available':'Needs Setup'}</div>
      <h2>B-Roll Keyword Extractor</h2>
      <p>Select a video with a transcript. AI extracts specific B-roll footage keywords for every section.</p>
    </div>
    ${f.available?`
      <form id="brollForm" class="stack" style="max-width:520px">
        <select id="brollVideoId">
          <option value="">Select a video…</option>
          ${videos.map(v=>`<option value="${v.id}">${esc(v.title.slice(0,60))}</option>`).join('')}
        </select>
        <button type="submit">Extract B-roll keywords</button>
      </form>
      <div id="brollResult"></div>
    `:setupRequired(f)}
  </div>`;
}

function setupRequired(f) {
  const isAdmin = state.session?.user?.role === 'admin';
  return `<div class="setup-required">
    <h3>${f.label || 'Feature not available'}</h3>
    <p>This feature requires additional configuration.</p>
    ${isAdmin
      ? `<button data-view-jump="admin">Configure in Admin →</button>`
      : `<small class="muted">Please contact your account administrator to enable this feature.</small>`}
  </div>`;
}

async function runFaceless(e) {
  e.preventDefault();
  const topic=$('#facelessTopic')?.value?.trim();
  const style=$('#facelessStyle')?.value||'documentary';
  const duration=Number($('#facelessDur')?.value||45);
  if (!topic) return;
  state.facelessTopic=topic; state.facelessStyle=style; state.facelessResult=null;
  const btn=e.target.querySelector('button[type=submit]'); btn.disabled=true; btn.textContent='Generating…';
  try {
    const res=await api('/api/faceless/generate',{method:'POST',body:JSON.stringify({topic,style,duration})});
    state.facelessResult=res;
    renderStudio();
  } catch(err) {
    state.facelessResult={ok:false,error:err.message};
    renderStudio();
  }
}

async function runBroll(e) {
  e.preventDefault();
  const videoId=$('#brollVideoId')?.value;
  if (!videoId) return;
  const btn=e.target.querySelector('button[type=submit]'); btn.disabled=true; btn.textContent='Extracting…';
  try {
    const res=await api('/api/broll/suggest',{method:'POST',body:JSON.stringify({videoId})});
    const el=$('#brollResult');
    if (!el) return;
    el.innerHTML=`<div class="broll-results">
      ${(res.suggestions||[]).map(s=>`<div class="broll-card">
        <div class="broll-time">${esc(s.timestamp)}</div>
        <b>${esc(s.topic)}</b>
        <div class="keyword-chips">${(s.brollKeywords||[]).map(k=>`<span class="kw-chip" data-copy="${encodeURIComponent(k)}">${esc(k)}</span>`).join('')}</div>
        <small>Search: "${esc(s.stockQuery)}" · Mood: ${esc(s.mood)}</small>
      </div>`).join('')}
      ${res.recommendedStyle?`<p class="muted">Recommended style: <b>${esc(res.recommendedStyle)}</b></p>`:''}
    </div>`;
    $$('#brollResult .kw-chip[data-copy]').forEach(c=>c.addEventListener('click',()=>navigator.clipboard?.writeText(decodeURIComponent(c.dataset.copy))));
  } catch(err) {
    $('#brollResult').innerHTML=`<div class="message error">${esc(err.message)}</div>`;
  } finally {
    btn.disabled=false; btn.textContent='Extract B-roll keywords';
  }
}

/* ── Digital Human Studio (dedicated page) ─────────────────────────── */
const DHS_URL_BASE = 'http://localhost:4200';
const _dhState = {
  status: null, humans: [], jobs: [], selectedHuman: null,
  generating: false, jobPollTimer: null, view: 'home', // home | create | generate | jobs
  script: '', prompt: '', mode: 'talking_head', tone: 'professional', duration: 30,
  // Advanced mode fields
  scene: '', action: '', product: '', cameraStyle: 'cinematic',
  advancedMode: false, plan: null, planLoading: false,
  consentDone: false, dhName: '', dhType: 'self',
  // Quality level helpers
  qualityLevel: 1, videoProvider: 'static',
};

function dhQualityBadge(level) {
  const meta = {
    1: { cls: 'dh-ql-1', label: 'Level 1: Static Fallback' },
    2: { cls: 'dh-ql-2', label: 'Level 2: Talking Head' },
    3: { cls: 'dh-ql-3', label: 'Level 3: AI Motion' },
    4: { cls: 'dh-ql-4', label: 'Level 4: Full Scene AI' },
    5: { cls: 'dh-ql-5', label: 'Level 5: Custom GPU' },
  }[level] || { cls: 'dh-ql-1', label: 'Static' };
  return `<span class="dh-ql-badge ${meta.cls}">${meta.label}</span>`;
}

function dhStatusBadge(status) {
  const map = {
    ready:                { cls: 'dh-status-ok',   label: '✓ Ready' },
    draft:                { cls: 'dh-status-warn',  label: '⚠ Draft' },
    needs_face:           { cls: 'dh-status-warn',  label: '📷 Needs face' },
    needs_image_provider: { cls: 'dh-status-info',  label: '🖼 Needs image provider' },
    taken_down:           { cls: 'dh-status-err',   label: '✕ Taken down' },
  };
  const s = map[status] || { cls: 'dh-status-warn', label: status };
  return `<span class="dh-status-badge ${s.cls}">${s.label}</span>`;
}

async function dhApi(path, opts = {}) {
  return api('/api/digital-human' + path, opts);
}

async function renderDigitalHuman() {
  const el = $('#digitalHuman');
  if (!el) return;

  // Check DHS connectivity
  if (!_dhState.status) {
    try { _dhState.status = await api('/api/digital-human-status'); } catch { _dhState.status = { connected: false }; }
  }

  if (!_dhState.status?.connected) {
    el.innerHTML = `
    <div class="fl-wrap" style="max-width:700px;margin:0 auto">
      <div class="fl-form-col">
        <div class="fl-form-head">
          <div class="fl-badge" style="background:rgba(239,68,68,.15);color:#ef4444">⚠ Studio Offline</div>
          <h2 style="font-size:1.6rem;font-weight:800;margin:12px 0 8px">Digital Human Studio is not running</h2>
          <p style="color:#888;font-size:.95rem;line-height:1.7">The AI Digital Human Studio runs locally on your Mac. Start it to generate talking-head videos with lip sync, voice cloning, and captions.</p>
        </div>
        <div class="fl-result" style="margin-top:24px">
          <div style="background:#1a1a24;border:1px solid #2a2a3a;border-radius:12px;padding:24px">
            <div style="font-size:.85rem;color:#6b6b8a;margin-bottom:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">How to start</div>
            <div style="font-family:monospace;background:#09090f;border-radius:8px;padding:16px;font-size:.9rem;color:#a78bfa;line-height:2">
              cd ~/digital-human-studio<br>
              npm start
            </div>
            <p style="color:#888;font-size:.82rem;margin-top:12px">Then refresh this page.</p>
          </div>
          <div style="background:linear-gradient(135deg,rgba(124,92,252,.1),rgba(6,182,212,.08));border:1px solid rgba(124,92,252,.25);border-radius:12px;padding:20px;margin-top:16px">
            <div style="font-weight:700;color:#a78bfa;margin-bottom:6px">🎬 What is Digital Human Studio?</div>
            <ul style="color:#888;font-size:.85rem;line-height:2;list-style:none;padding:0">
              <li>🧑 Upload your face photo or video — create your AI avatar</li>
              <li>🎤 AI voice generation (TTS) — type text, get speech</li>
              <li>👄 Real lip sync — your face speaks the words</li>
              <li>📝 Word-by-word captions — styled, animated</li>
              <li>📱 9:16 Portrait export — TikTok, Reels, Shorts ready</li>
              <li>🔗 Fully integrated — generate from right here in ClipForge</li>
            </ul>
          </div>
        </div>
        <button class="primary" style="margin-top:20px" onclick="_dhState.status=null;renderDigitalHuman()">↻ Retry Connection</button>
      </div>
    </div>`;
    return;
  }

  // Load data
  try {
    const [dhRes, jobRes] = await Promise.all([
      dhApi('/digital-humans').catch(() => ({ digitalHumans: [] })),
      dhApi('/jobs').catch(() => ({ jobs: [] })),
    ]);
    _dhState.humans = dhRes.digitalHumans || [];
    _dhState.jobs   = jobRes.jobs || [];
  } catch {}

  if (_dhState.view === 'generate') { renderDHGenerate(el); return; }
  if (_dhState.view === 'jobs')     { renderDHJobs(el); return; }
  if (_dhState.view === 'create')   { renderDHCreate(el); return; }
  renderDHHome(el);
}

function renderDHHome(el) {
  const humans = _dhState.humans;
  const jobs   = _dhState.jobs;
  const active = jobs.filter(j => j.status === 'processing' || j.status === 'queued');
  const done   = jobs.filter(j => j.status === 'complete');
  const ql = _dhState.status?.activeQualityLevel || 1;
  const vp = _dhState.status?.videoProvider || 'static';

  el.innerHTML = `
  <div class="dh-page">

    <!-- Header -->
    <div class="dh-hero">
      <div class="dh-hero-text">
        <div class="dh-online-pill"><span class="dh-pulse"></span>Studio Online</div>
        <h2 class="dh-hero-title">AI Digital Human Studio</h2>
        <p class="dh-hero-desc">AI Twin · Synthetic Human · Scene Prompts · Storyboard planning</p>
        <div class="dh-quality-row">
          ${dhQualityBadge(ql)}
          <span class="dh-provider-label">via ${esc(vp)}</span>
          ${ql === 1 ? `<span class="dh-warn-inline">⚠ Static only — add provider key in settings for real AI</span>` : ''}
        </div>
      </div>
      <button class="primary dh-hero-btn" onclick="_dhState.view='generate';renderDigitalHuman()">🎬 Generate</button>
    </div>

    <!-- Stats grid — 2×2 on mobile, 4 columns on desktop -->
    <div class="dh-stats">
      ${[
        ['🧑', humans.length,      'Digital Humans'],
        ['✅', done.length,        'Videos done'],
        ['⏳', active.length,      'In queue'],
        ['⚙',  ql,                 'Quality level'],
      ].map(([icon,val,label]) => `
      <div class="dh-stat-card">
        <div class="dh-stat-icon">${icon}</div>
        <div class="dh-stat-val">${val}</div>
        <div class="dh-stat-label">${label}</div>
      </div>`).join('')}
    </div>

    <!-- Digital Humans section -->
    <div class="dh-section-head">
      <h3>Your Digital Humans</h3>
      <button class="ghost" onclick="_dhState.view='create';renderDigitalHuman()">+ New</button>
    </div>

    ${humans.length === 0 ? `
    <div class="dh-empty-state">
      <div class="dh-empty-icon">🧑</div>
      <p>No digital humans yet. Create your AI Twin or a synthetic human to start.</p>
      <div class="dh-empty-btns">
        <button class="primary" onclick="_dhState.view='create';_dhState.createType='twin';renderDigitalHuman()">🎥 Create AI Twin</button>
        <button class="ghost" onclick="_dhState.view='create';_dhState.createType='fictional';renderDigitalHuman()">✨ Create Synthetic</button>
      </div>
    </div>` : `
    <div class="dh-humans-grid">
      ${humans.slice(0,6).map(dh => `
      <div class="dh-human-card ${_dhState.selectedHuman===dh.id?'selected':''}" onclick="_dhState.selectedHuman='${dh.id}';renderDigitalHuman()">
        <div class="dh-human-avatar">
          ${{self:'🧑',fictional:'✨',male:'👨',female:'👩',brand:'🏢',presenter:'🎤',teacher:'📚',salesperson:'💼',influencer:'⭐'}[dh.isFictional?'fictional':dh.type]||'🧑'}
        </div>
        <div class="dh-human-info">
          <div class="dh-human-name">${esc(dh.name)}</div>
          <div class="dh-human-type">${dh.isFictional ? 'Synthetic' : 'AI Twin'}</div>
          ${dhStatusBadge(dh.status)}
        </div>
      </div>`).join('')}
      <div class="dh-human-card dh-add-card" onclick="_dhState.view='create';renderDigitalHuman()">
        <div class="dh-add-plus">+</div>
        <div class="dh-add-label">New Human</div>
      </div>
    </div>`}

    <!-- Quick actions -->
    <div class="dh-actions">
      <div class="dh-action-card">
        <div class="dh-action-icon">🎬</div>
        <div class="dh-action-title">Generate Video</div>
        <p class="dh-action-desc">Simple or advanced — scene prompts, storyboard AI, full pipeline</p>
        <button class="primary" onclick="_dhState.view='generate';renderDigitalHuman()">Start →</button>
      </div>
      <div class="dh-action-card">
        <div class="dh-action-icon">📋</div>
        <div class="dh-action-title">Video Jobs</div>
        <p class="dh-action-desc">${jobs.length} job${jobs.length!==1?'s':''} · ${active.length} active · ${done.length} done</p>
        <button class="ghost" onclick="_dhState.view='jobs';renderDigitalHuman()">View →</button>
      </div>
    </div>

    <!-- Recent videos -->
    ${done.length ? `
    <div class="dh-section-head" style="margin-top:24px"><h3>Recent Videos</h3></div>
    <div class="dh-jobs-list">
      ${done.slice(0,3).map(j => `
      <div class="dh-job-row">
        <div class="dh-job-left">
          <div class="dh-job-title">${j.mode?.replace(/_/g,' ')||'video'}</div>
          <div class="dh-job-meta">${dhQualityBadge(j.qualityLevel||1)} · ${new Date(j.createdAt).toLocaleDateString()}</div>
          ${j.staticFallbackWarning ? `<div class="dh-static-warn">⚠ Static fallback — configure a video provider for real AI</div>` : ''}
        </div>
        <div class="dh-job-actions">
          ${j.outputPath ? `<a href="${DHS_URL_BASE}${j.outputPath}" target="_blank" class="ghost dh-dl-btn">⬇</a>` : ''}
          <span class="dh-status-badge dh-status-ok">done</span>
        </div>
      </div>`).join('')}
    </div>` : ''}

    <div class="dh-footer-link">
      <a href="${DHS_URL_BASE}" target="_blank">Open full Digital Human Studio ↗</a>
    </div>
  </div>`;
}

function renderDHGenerate(el) {
  const humans = _dhState.humans;
  const ql = _dhState.status?.activeQualityLevel || 1;
  const MODES = [
    {id:'talking_head',icon:'💬',name:'Talking Head',cost:5},
    {id:'ad_video',    icon:'📢',name:'Ad Video',    cost:10},
    {id:'presenter',   icon:'🎤',name:'Presenter',   cost:8},
    {id:'influencer',  icon:'⭐',name:'Influencer',  cost:8},
    {id:'intro',       icon:'▶',name:'Intro',        cost:3},
    {id:'outro',       icon:'⏹',name:'Outro',        cost:3},
  ];

  el.innerHTML = `
  <div class="dh-page">
    <div class="dh-subpage-head">
      <button class="ghost dh-back-btn" onclick="_dhState.view='home';renderDigitalHuman()">← Back</button>
      <h2>Generate Video</h2>
      <p>Choose a digital human, write a script or scene prompt — AI handles the rest.</p>
    </div>

    <!-- Active quality level -->
    <div class="dh-ql-info">
      <span>Active output:</span> ${dhQualityBadge(ql)}
      ${ql===1?`<button class="ghost dh-settings-link" onclick="setView('settings')">Configure provider →</button>`:''}
    </div>
    ${ql===1?`<div class="dh-static-warn dh-warn-block">⚠ Level 1 Static Fallback active — your video will be a still image + audio, NOT real AI motion. Add a Runway, Kling, or Pika API key in Settings for cinematic AI video.</div>`:''}

    ${humans.length === 0 ? `
    <div class="dh-empty-state">
      <p>You need a Digital Human first.</p>
      <button class="primary" onclick="_dhState.view='create';renderDigitalHuman()">Create One →</button>
    </div>` : `

    <!-- Advanced mode toggle -->
    <div class="dh-adv-toggle-row">
      <button class="dh-adv-toggle ${_dhState.advancedMode?'on':''}" id="dhAdvToggle">
        ${_dhState.advancedMode?'◉':'○'} Advanced / Scene Prompt
      </button>
      <span class="dh-adv-hint">${_dhState.advancedMode?'London · Ferrari · Cinematic AI':'Simple script mode'}</span>
    </div>

    <form id="dhGenForm" class="dh-form">

      <!-- Digital Human picker -->
      <div class="dh-field">
        <label class="dh-label">Digital Human</label>
        <div class="dh-human-picker">
          ${humans.map(dh => `
          <div class="dh-pick-card ${_dhState.selectedHuman===dh.id?'active':''} ${dh.status!=='ready'?'dh-pick-blocked':''}"
            onclick="_dhState.selectedHuman='${dh.id}';renderDHGenerate(document.getElementById('digitalHuman'))">
            <div class="dh-pick-avatar">${dh.isFictional?'✨':'🧑'}</div>
            <div class="dh-pick-name">${esc(dh.name)}</div>
            ${dhStatusBadge(dh.status)}
          </div>`).join('')}
        </div>
      </div>

      <!-- Mode selector -->
      <div class="dh-field">
        <label class="dh-label">Video Mode</label>
        <div class="dh-modes">
          ${MODES.map(m => `
          <div class="dh-mode-card ${_dhState.mode===m.id?'active':''}"
            onclick="_dhState.mode='${m.id}';renderDHGenerate(document.getElementById('digitalHuman'))">
            <div class="dh-mode-icon">${m.icon}</div>
            <div class="dh-mode-name">${m.name}</div>
            <div class="dh-mode-cost">${m.cost} cr</div>
          </div>`).join('')}
        </div>
      </div>

      <!-- Script -->
      <div class="dh-field">
        <label class="dh-label">Script <span class="dh-label-hint">(spoken words)</span></label>
        <textarea id="dhScript" class="fl-input" rows="4" placeholder="Enter the exact words your digital human will speak…">${esc(_dhState.script)}</textarea>
      </div>

      <!-- Prompt / Tone row -->
      <div class="dh-row2">
        <div class="dh-field">
          <label class="dh-label">Topic (AI writes script)</label>
          <input id="dhPrompt" class="fl-input" type="text" placeholder="e.g. Introduce my luxury brand" value="${esc(_dhState.prompt)}">
        </div>
        <div class="dh-field">
          <label class="dh-label">Tone</label>
          <select id="dhTone" class="fl-select">
            ${['professional','casual','energetic','calm','motivational','luxury'].map(t=>`<option value="${t}" ${_dhState.tone===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- Advanced fields -->
      ${_dhState.advancedMode ? `
      <div class="dh-adv-section">
        <div class="dh-adv-label">🎬 Scene Prompt</div>
        <div class="dh-row2">
          <div class="dh-field">
            <label class="dh-label">Scene</label>
            <input id="dhScene" class="fl-input" type="text" placeholder="e.g. London city street" value="${esc(_dhState.scene)}">
          </div>
          <div class="dh-field">
            <label class="dh-label">Action</label>
            <input id="dhAction" class="fl-input" type="text" placeholder="e.g. driving a Ferrari" value="${esc(_dhState.action)}">
          </div>
        </div>
        <div class="dh-row2">
          <div class="dh-field">
            <label class="dh-label">Product / Website</label>
            <input id="dhProduct" class="fl-input" type="text" placeholder="e.g. Digital Human OS" value="${esc(_dhState.product)}">
          </div>
          <div class="dh-field">
            <label class="dh-label">Camera Style</label>
            <select id="dhCamera" class="fl-select">
              ${['cinematic','documentary','studio','social media','vlog','luxury ad'].map(s=>`<option value="${s}" ${_dhState.cameraStyle===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
            </select>
          </div>
        </div>
        <button type="button" id="dhPlanBtn" class="ghost dh-plan-btn" ${_dhState.planLoading?'disabled':''}>
          ${_dhState.planLoading?'⏳ Planning…':'🧠 Plan with AI →'}
        </button>
        ${_dhState.plan ? `
        <div class="dh-plan-card">
          <div class="dh-plan-title">AI Storyboard</div>
          <div class="dh-plan-script">"${esc((_dhState.plan.script||'').slice(0,160))}${(_dhState.plan.script||'').length>160?'…':''}"</div>
          <div class="dh-plan-shots">
            ${(_dhState.plan.shots||[]).map(s=>`
            <div class="dh-plan-shot">
              <span class="dh-plan-shot-num">Shot ${s.shot||'?'} · ${s.duration||'?'}s</span>
              <span class="dh-plan-shot-desc">${esc(s.description||'')}</span>
            </div>`).join('')}
          </div>
          ${(_dhState.plan.qualityLevelNeeded||2) > ql ? `
          <div class="dh-static-warn">⚠ This scene needs Level ${_dhState.plan.qualityLevelNeeded} (${_dhState.status?.qualityLevels?.[_dhState.plan.qualityLevelNeeded]?.label||'Full Scene AI'}) but you're on Level ${ql}. Configure a provider in Settings.</div>` : ''}
        </div>` : ''}
      </div>` : ''}

      <!-- Duration + Format -->
      <div class="dh-row2">
        <div class="dh-field">
          <label class="dh-label">Duration</label>
          <select id="dhDur" class="fl-select">
            ${[15,30,45,60].map(d=>`<option value="${d}" ${_dhState.duration===d?'selected':''}>${d}s</option>`).join('')}
          </select>
        </div>
        <div class="dh-field">
          <label class="dh-label">Format</label>
          <select id="dhFormat" class="fl-select">
            <option value="9:16">9:16 Portrait</option>
            <option value="16:9">16:9 Landscape</option>
            <option value="1:1">1:1 Square</option>
          </select>
        </div>
      </div>

      <button type="submit" class="primary dh-gen-submit" ${_dhState.generating?'disabled':''}>
        ${_dhState.generating ? '⏳ Submitting…' : '🎬 Generate Video'}
      </button>
    </form>`}
  </div>`;

  document.getElementById('dhAdvToggle')?.addEventListener('click', () => {
    _dhState.advancedMode = !_dhState.advancedMode;
    renderDHGenerate(el);
  });

  document.getElementById('dhPlanBtn')?.addEventListener('click', async () => {
    const dhId = document.getElementById('dhSelHuman')?.value || _dhState.selectedHuman;
    _dhState.scene      = document.getElementById('dhScene')?.value.trim() || '';
    _dhState.action     = document.getElementById('dhAction')?.value.trim() || '';
    _dhState.product    = document.getElementById('dhProduct')?.value.trim() || '';
    _dhState.cameraStyle= document.getElementById('dhCamera')?.value || 'cinematic';
    _dhState.prompt     = document.getElementById('dhPrompt')?.value.trim() || '';
    _dhState.planLoading = true; renderDHGenerate(el);
    try {
      const res = await dhApi('/videos/plan', { method:'POST', body: JSON.stringify({
        digitalHumanId: dhId,
        prompt: _dhState.prompt || `${_dhState.action} in ${_dhState.scene} for ${_dhState.product}`,
        scene: _dhState.scene, action: _dhState.action, product: _dhState.product,
        durationSec: Number(document.getElementById('dhDur')?.value || 30),
        cameraStyle: _dhState.cameraStyle,
      })});
      _dhState.plan = res.plan;
      if (res.plan?.script && !document.getElementById('dhScript')?.value.trim()) {
        _dhState.script = res.plan.script;
      }
    } catch(e) { toast(e.message, 'error'); }
    _dhState.planLoading = false; renderDHGenerate(el);
  });

  document.getElementById('dhGenForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    _dhState.script      = document.getElementById('dhScript')?.value.trim() || '';
    _dhState.prompt      = document.getElementById('dhPrompt')?.value.trim() || '';
    _dhState.tone        = document.getElementById('dhTone')?.value || 'professional';
    _dhState.duration    = Number(document.getElementById('dhDur')?.value || 30);
    _dhState.scene       = document.getElementById('dhScene')?.value.trim() || '';
    _dhState.action      = document.getElementById('dhAction')?.value.trim() || '';
    _dhState.product     = document.getElementById('dhProduct')?.value.trim() || '';
    _dhState.cameraStyle = document.getElementById('dhCamera')?.value || 'cinematic';
    const dhId = document.getElementById('dhSelHuman')?.value || _dhState.selectedHuman || humans[0]?.id;
    const fmt  = document.getElementById('dhFormat')?.value || '9:16';
    const dims = {'9:16':[1080,1920],'16:9':[1920,1080],'1:1':[1080,1080]}[fmt];

    if (!_dhState.script && !_dhState.prompt && !_dhState.action) { toast('Enter a script, topic, or scene action.','error'); return; }
    _dhState.generating = true; renderDHGenerate(el);
    try {
      await dhApi('/videos/generate', { method:'POST', body: JSON.stringify({
        digitalHumanId: dhId, mode: _dhState.mode,
        script: _dhState.script, prompt: _dhState.prompt,
        tone: _dhState.tone, durationSec: _dhState.duration,
        scene: _dhState.scene, action: _dhState.action,
        product: _dhState.product, cameraStyle: _dhState.cameraStyle,
        outputW: dims[0], outputH: dims[1],
      })});
      toast('Video job queued!','success');
      _dhState.generating = false; _dhState.view = 'jobs';
      setTimeout(() => renderDigitalHuman(), 800);
    } catch(err) { toast(err.message,'error'); _dhState.generating=false; renderDHGenerate(el); }
  });
}

function renderDHJobs(el) {
  const jobs = _dhState.jobs;
  const active = jobs.some(j => j.status==='processing'||j.status==='queued');

  el.innerHTML = `
  <div class="dh-page">
    <div class="dh-subpage-head">
      <button class="ghost dh-back-btn" onclick="_dhState.view='home';renderDigitalHuman()">← Back</button>
      <h2>Video Jobs</h2>
      <p>${jobs.length} job${jobs.length!==1?'s':''}${active?' · Processing…':''}</p>
    </div>

    ${jobs.length===0 ? `
    <div class="dh-empty-state">
      <div class="dh-empty-icon">📋</div>
      <p>No jobs yet. Generate a video to see it here.</p>
      <button class="primary" onclick="_dhState.view='generate';renderDigitalHuman()">Generate Video</button>
    </div>` : `
    <div class="dh-jobs-list">
      ${jobs.slice(0,20).map(j => `
      <div class="dh-job-row">
        <div class="dh-job-left">
          <div class="dh-job-title">${esc(j.mode?.replace(/_/g,' ')||'video')}</div>
          <div class="dh-job-meta">
            ${dhQualityBadge(j.qualityLevel||1)}
            <span>${j.stage||''}</span>
            <span>${new Date(j.createdAt).toLocaleDateString()}</span>
          </div>
          ${j.staticFallbackWarning ? `<div class="dh-static-warn">⚠ Static fallback — not real AI motion video</div>` : ''}
          ${j.status==='processing'||j.status==='queued' ? `
          <div class="dh-progress-bar"><div class="dh-progress-fill" style="width:${j.progress||8}%"></div></div>` : ''}
          ${j.error ? `<div class="dh-job-error">${esc(j.error.slice(0,240))}</div>` : ''}
        </div>
        <div class="dh-job-actions">
          ${j.outputPath ? `<a href="${DHS_URL_BASE}${j.outputPath}" target="_blank" class="primary dh-dl-btn">⬇</a>` : ''}
          ${j.thumbnailPath ? `<a href="${DHS_URL_BASE}${j.thumbnailPath}" target="_blank" class="ghost dh-dl-btn">🖼</a>` : ''}
          <span class="dh-status-badge ${j.status==='complete'?'dh-status-ok':j.status==='failed'?'dh-status-err':'dh-status-info'}">${j.status}</span>
        </div>
      </div>`).join('')}
    </div>
    ${active ? `<p class="dh-poll-hint">Auto-refreshing every 5s…</p>` : ''}`}
  </div>`;

  if (active) { clearTimeout(_dhState.jobPollTimer); _dhState.jobPollTimer = setTimeout(() => renderDigitalHuman(), 5000); }
}

function renderDHCreate(el) {
  el.innerHTML = `
  <div class="dh-page">
    <div class="dh-subpage-head">
      <button class="ghost dh-back-btn" onclick="_dhState.view='home';renderDigitalHuman()">← Back</button>
      <h2>Create a Digital Human</h2>
      <p>AI Twin (your face) or Synthetic Human (AI-generated). Consent required.</p>
    </div>

    <!-- Type chooser -->
    <div class="dh-create-types">
      <div class="dh-create-type ${(_dhState.createType||'twin')==='twin'?'active':''}" onclick="_dhState.createType='twin';renderDHCreate(el)">
        <div class="dh-create-type-icon">🎥</div>
        <div class="dh-create-type-name">AI Twin</div>
        <div class="dh-create-type-desc">Your real face + voice. Upload a photo &amp; record or upload audio.</div>
      </div>
      <div class="dh-create-type ${_dhState.createType==='fictional'?'active':''}" onclick="_dhState.createType='fictional';renderDHCreate(el)">
        <div class="dh-create-type-icon">✨</div>
        <div class="dh-create-type-name">Synthetic Human</div>
        <div class="dh-create-type-desc">Fully AI-generated fictional person. No upload needed (requires image provider).</div>
      </div>
    </div>

    <div class="dh-consent-notice">
      <div class="dh-consent-title">⚠ Consent &amp; Usage Policy</div>
      <p>You must own or have written permission for any face and voice you upload. No impersonation of real people. Violations result in immediate takedown.</p>
    </div>

    <form id="dhCreateForm" class="dh-form">
      <div class="dh-row2">
        <div class="dh-field">
          <label class="dh-label">Name</label>
          <input id="dhcName" class="fl-input" type="text" placeholder="${(_dhState.createType||'twin')==='fictional'?'e.g. Aria — Luxury Brand Host':'e.g. My Brand Avatar'}" required>
        </div>
        <div class="dh-field">
          <label class="dh-label">Role / Type</label>
          <select id="dhcType" class="fl-select">
            ${(_dhState.createType||'twin')==='fictional' ? `
            <option value="presenter">Presenter</option>
            <option value="influencer">Influencer</option>
            <option value="teacher">Teacher</option>
            <option value="salesperson">Salesperson</option>
            <option value="brand">Brand Ambassador</option>` : `
            <option value="self">My Digital Twin</option>
            <option value="presenter">Presenter</option>
            <option value="influencer">Influencer</option>
            <option value="brand">Brand Ambassador</option>`}
          </select>
        </div>
      </div>

      ${_dhState.createType==='fictional' ? `
      <div class="dh-field">
        <label class="dh-label">Description (for AI face generation)</label>
        <textarea id="dhcDesc" class="fl-input" rows="2" placeholder="e.g. Professional woman, 30s, dark hair, confident smile, studio lighting"></textarea>
        <div class="dh-field-hint">Requires image provider (DALL-E / Stability / FAL) in Settings. Otherwise you can upload a face photo later.</div>
      </div>` : ''}

      <div class="dh-field">
        <label class="dh-label">Consent</label>
        <select id="dhcConsent" class="fl-select">
          ${(_dhState.createType||'twin')==='fictional' ? `
          <option value="synthetic">Fully synthetic / fictional — no real person</option>` : `
          <option value="self">This is me — I appear in these videos</option>
          <option value="licensed">I have written permission for this person's likeness</option>`}
        </select>
      </div>

      <div class="dh-consent-check">
        <input type="checkbox" id="dhcAgree" required>
        <label for="dhcAgree">I confirm I own or have permission for any likeness used. I will not use this for deception, impersonation, or harmful purposes.</label>
      </div>

      <button type="submit" class="primary dh-gen-submit" id="dhcBtn">Create Digital Human</button>
    </form>

    <div class="dh-footer-link">
      <a href="${DHS_URL_BASE}" target="_blank">Open full Digital Human Studio ↗</a>
    </div>
  </div>`;

  document.getElementById('dhCreateForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('dhcBtn');
    btn.disabled=true; btn.textContent='Creating…';
    const isFictional = _dhState.createType === 'fictional';
    try {
      const res = await dhApi(isFictional ? '/digital-humans/create-fictional' : '/digital-humans', {
        method:'POST', body: JSON.stringify({
          name: document.getElementById('dhcName')?.value.trim(),
          type: document.getElementById('dhcType')?.value,
          description: document.getElementById('dhcDesc')?.value?.trim() || '',
          consentType: document.getElementById('dhcConsent')?.value,
          consentConfirmed: true,
          consentNote: 'Confirmed via ClipForge AI integration',
          isFictional,
          defaultVoice: 'en_US-amy-medium',
        })
      });
      toast(`"${res.digitalHuman?.name}" created!`,'success');
      _dhState.humans.unshift(res.digitalHuman);
      _dhState.selectedHuman = res.digitalHuman?.id;
      _dhState.view = 'home';
      renderDigitalHuman();
    } catch(err) { toast(err.message,'error'); btn.disabled=false; btn.textContent='Create Digital Human'; }
  });
}

/* ── Transcript ─────────────────────────────────────────────────────── */
async function renderTranscript() {
  const videos=state.library.videos||[];
  const transcriptions=state.library.transcriptions||[];
  const videoId=state.transcriptVideoId||videos[0]?.id||'';
  let transcript={segments:[],fullText:'',wordCount:0};
  if (videoId) {
    try { transcript=await api(`/api/transcript?videoId=${videoId}`); } catch {}
  }

  $('#transcript').innerHTML = `
    <div class="panel" style="max-width:800px">
      <div class="panel-head">
        <h2>Transcript viewer</h2>
        <select id="transcriptSelect">
          <option value="">Select a video…</option>
          ${videos.map(v=>`<option value="${v.id}" ${v.id===videoId?'selected':''}>${esc(v.title.slice(0,50))}</option>`).join('')}
        </select>
      </div>
      ${transcript.segments.length
        ? `<div class="meta" style="margin-bottom:12px"><span>${transcript.wordCount||0} words</span><span>${transcript.segments.length} segments</span></div>
           <div class="transcript-body">
             ${transcript.segments.map(s=>`<span class="seg" title="${s.start.toFixed(1)}s–${s.end.toFixed(1)}s">${esc(s.text)} </span>`).join('')}
           </div>
           <div style="margin-top:16px"><button class="ghost" data-copy="${encodeURIComponent(transcript.fullText||'')}">Copy full transcript</button></div>`
        : empty(videoId?'No transcript yet. Generate clips to trigger transcription.':'Select a video to view its transcript.')}
    </div>`;

  $('#transcriptSelect')?.addEventListener('change', e => {
    state.transcriptVideoId=e.target.value;
    renderTranscript();
  });
}

/* ── Scheduler ─────────────────────────────────────────────────────── */
function renderScheduler() {
  const scheduled=(state.library.scheduledPosts||[]);
  const clips=(state.library.clips||[]).filter(c=>c.outputPath&&!c.demoMode);

  $('#scheduler').innerHTML = `
    <div class="scheduler-wrap">
      ${scheduled.length ? `
        <div class="panel-head" style="margin-bottom:14px">
          <h2>${scheduled.length} scheduled post${scheduled.length!==1?'s':''}</h2>
        </div>
        <div class="schedule-list">
          ${scheduled.map(p=>{
            const clip=clips.find(c=>c.id===p.clipId);
            return `<div class="schedule-item">
              <div class="schedule-thumb">▶</div>
              <div class="schedule-info">
                <b>${esc(clip?.hook||'Clip')}</b>
                <div class="meta">
                  <span>${pill(p.platform)}</span>
                  <span>${new Date(p.scheduledFor).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
                  ${pill(p.status, p.status==='scheduled'?'warn':p.status==='posted'?'ok':'')}
                </div>
              </div>
            </div>`;
          }).join('')}
        </div>
      ` : `
        <div class="panel empty-state">
          <div class="empty-icon">◷</div>
          <h2>Nothing scheduled yet</h2>
          <p>Generate clips first, then open a clip to schedule it for posting.</p>
          ${clips.length
            ? `<button data-view="clips" style="margin-top:20px">View your ${clips.length} clips</button>`
            : `<button data-view="create" style="margin-top:20px">Create first clips</button>`}
        </div>

        <div class="platform-connect-panel panel" style="margin-top:16px">
          <h3 style="margin-bottom:6px">Platform posting guide</h3>
          <p style="color:var(--muted);font-size:.83rem;margin-bottom:14px">Download your clip, then follow these steps for each platform:</p>
          <div class="platform-connect-list">
            ${[
              {p:'TikTok', steps:['Open TikTok → +', 'Upload your clip', 'Paste caption + hashtags', 'Set "For you" audience', 'Post']},
              {p:'YouTube Shorts', steps:['YouTube Studio → Create', 'Upload → mark as Short', 'Add title & description', 'Set to Public', 'Publish']},
              {p:'Instagram Reels', steps:['Instagram → +', 'Select Reel', 'Upload clip', 'Add cover + caption', 'Share']},
              {p:'X / Twitter', steps:['New Post → Media', 'Attach clip', 'Add hook as tweet text', 'Add hashtags', 'Post']},
              {p:'LinkedIn', steps:['New Post → Video', 'Upload clip', 'Write hook caption', 'Add hashtags', 'Publish']}
            ].map(({p,steps})=>`
              <details class="platform-guide-item">
                <summary><span class="platform-guide-name">${p}</span><span class="platform-guide-steps">${steps.length} steps</span></summary>
                <ol class="platform-guide-ol">${steps.map(s=>`<li>${s}</li>`).join('')}</ol>
              </details>`).join('')}
          </div>
          <div class="scheduler-tip">
            <b>Pro tip:</b> Generate captions and hooks for your clips first — they're already optimized per platform.
            <button data-view="clips" class="ghost" style="margin-top:10px;width:100%">Open my clips →</button>
          </div>
        </div>
      `}
    </div>`;
}

/* ── Billing ─────────────────────────────────────────────────────── */
function renderBilling() {
  const user = state.session?.user || {};
  const plans = state.library.billingPlans || [];
  const allTxns = state.library.creditTransactions || [];
  const txns = allTxns.filter(t => t.userId === user.id).slice(0, 12);
  const credits = user.credits ?? 0;
  const userPlanId = (user.plan || 'free').toLowerCase();
  const currentPlan = plans.find(p => p.id === userPlanId) || plans[0] || {};
  const creditsIncluded = currentPlan.creditsIncluded || 100;
  const creditsUsed = Math.max(0, creditsIncluded - credits);
  const usePct = Math.min(100, Math.round((creditsUsed / creditsIncluded) * 100));
  const barClass = usePct >= 90 ? 'danger' : usePct >= 70 ? 'warn' : '';

  function planCta(p) {
    const isCurrent = p.id === userPlanId;
    const isUpgrade = plans.indexOf(p) > plans.indexOf(currentPlan);
    if (isCurrent) return `<button class="plan-cta current-cta" disabled>Current plan</button>`;
    if (isUpgrade) return `<button class="plan-cta upgrade-cta" data-upgrade="${esc(p.id)}">Upgrade →</button>`;
    return `<button class="plan-cta downgrade-cta ghost" data-upgrade="${esc(p.id)}">Switch</button>`;
  }

  $('#billing').innerHTML = `
    <div class="billing-wrap">

      <!-- Current plan card -->
      <div class="plan-current-card">
        <div class="plan-current-left">
          <div class="plan-current-badge">
            <span class="plan-current-badge-dot"></span>
            Active plan
          </div>
          <div class="plan-current-name">${esc(currentPlan.name||'Free')}</div>
          <div class="plan-current-desc">
            ${currentPlan.monthlyPrice ? `$${currentPlan.monthlyPrice}/month · ` : 'Free · '}
            ${creditsIncluded >= 99999 ? 'Unlimited credits' : `${creditsIncluded.toLocaleString()} credits / month`}
          </div>
          <div class="usage-bar-wrap">
            <div class="usage-bar-row">
              <span>${credits.toLocaleString()} credits remaining</span>
              <span>${creditsIncluded >= 99999 ? '∞' : `${creditsUsed} used`}</span>
            </div>
            <div class="usage-bar">
              <div class="usage-bar-fill ${barClass}" style="width:${creditsIncluded >= 99999 ? 5 : usePct}%"></div>
            </div>
          </div>
        </div>
        <div class="plan-credit-col">
          <div class="plan-credit-num">${credits >= 99999 ? '∞' : credits.toLocaleString()}</div>
          <div class="plan-credit-label">Credits left</div>
        </div>
      </div>

      <!-- Credit cost reference -->
      <div class="billing-info-row">
        <div class="billing-info-card">
          <h4>Credit costs</h4>
          <p style="margin-top:8px;line-height:2">
            Clip generation — <b>5 credits</b><br>
            AI transcript analysis — <b>2 credits</b><br>
            Faceless script generation — <b>3 credits</b><br>
            Thumbnail AI generation — <b>2 credits</b>
          </p>
        </div>
        <div class="billing-info-card">
          <h4>Your limits</h4>
          <p style="margin-top:8px;line-height:2">
            Max video length — <b>${currentPlan.maxVideoLength >= 999 ? 'Unlimited' : (currentPlan.maxVideoLength||15) + ' min'}</b><br>
            Clips per video — <b>${currentPlan.maxClipsPerVideo >= 999 ? 'Unlimited' : (currentPlan.maxClipsPerVideo||3)}</b><br>
            Scheduling — <b>${currentPlan.autoPostAllowed ? 'Included' : 'Not available'}</b><br>
            API access — <b>${(currentPlan.id === 'studio') ? 'Included' : 'Not available'}</b>
          </p>
        </div>
      </div>

      <!-- Plans comparison -->
      <div class="billing-section-head">
        <h2>Plans</h2>
        <small class="muted">Upgrade or switch at any time</small>
      </div>
      <div class="plans-grid">
        ${plans.map(p => {
          const isCurrent = p.id === userPlanId;
          const feats = p.features || [
            `${p.creditsIncluded >= 99999 ? 'Unlimited' : p.creditsIncluded.toLocaleString()} credits/month`,
            `${p.maxVideoLength >= 999 ? 'Unlimited' : p.maxVideoLength+'min'} max video`,
            `${p.maxClipsPerVideo >= 999 ? 'Unlimited' : p.maxClipsPerVideo} clips/video`,
          ];
          return `<div class="plan-card ${p.popular ? 'popular' : ''} ${isCurrent ? 'current-plan' : ''}">
            ${p.popular ? '<span class="plan-popular-badge">Most popular</span>' : ''}
            ${isCurrent ? '<span class="plan-current-label">✓ Active</span>' : ''}
            <h3>${esc(p.name)}</h3>
            <div class="plan-price">
              ${p.monthlyPrice ? `$${p.monthlyPrice}` : 'Free'}
              ${p.monthlyPrice ? '<small>/mo</small>' : ''}
            </div>
            <div class="plan-credits-tag">
              ${p.creditsIncluded >= 99999 ? '∞ Unlimited credits' : p.creditsIncluded.toLocaleString() + ' credits / mo'}
            </div>
            <ul>${feats.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
            ${planCta(p)}
          </div>`;
        }).join('')}
      </div>

      <!-- Transaction history -->
      <div class="billing-section-head" style="margin-top:4px">
        <h2>Credit history</h2>
      </div>
      <div class="txn-panel">
        ${txns.length ? `
          <div class="txn-list">
            ${txns.map(t => {
              const isIn = t.amount > 0;
              return `<div class="txn-row">
                <div class="txn-icon ${isIn ? 'credit-in' : 'credit-out'}">${isIn ? '＋' : '−'}</div>
                <div class="txn-info">
                  <b>${esc(t.reason || (isIn ? 'Credits added' : 'Credits used'))}</b>
                  <small>${when(t.createdAt)}</small>
                </div>
                <div class="txn-amount ${isIn ? 'credit-pos' : 'credit-neg'}">
                  ${isIn ? '+' : ''}${t.amount}
                </div>
              </div>`;
            }).join('')}
          </div>
        ` : '<div class="txn-empty">No credit transactions yet. Generate your first clip to see usage here.</div>'}
      </div>

    </div>`;

  /* upgrade button handler */
  $('#billing').querySelectorAll('[data-upgrade]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const planId = btn.dataset.upgrade;
      const plan = plans.find(p => p.id === planId);
      if (!plan) return;
      if (plan.monthlyPrice > 0) {
        alert(`To upgrade to ${plan.name} ($${plan.monthlyPrice}/mo), connect your payment method.\n\nStripe billing coming soon — contact support to upgrade manually.`);
        return;
      }
      try {
        btn.disabled = true; btn.textContent = 'Switching…';
        await api('/api/billing/switch', { method: 'POST', body: JSON.stringify({ planId }) });
        await loadAll(); renderBilling();
      } catch(e2) { alert(e2.message); btn.disabled = false; }
    });
  });
}

/* ── Settings ─────────────────────────────────────────────────────── */
function renderSettings() {
  try { _renderSettings(); } catch(e) {
    $('#settings').innerHTML = `<div class="panel" style="margin:20px;border-color:red"><b style="color:red">Settings render error:</b><pre style="font-size:11px;overflow:auto">${esc(String(e))}</pre></div>`;
    console.error('renderSettings error:', e);
  }
}
function _renderSettings() {
  const user=state.session?.user||{};
  const tools=state.session?.tools||{};
  const setup=state.session?.setup||[];
  const kitsHtml = state.brandKits.length === 0
    ? `<div style="border:2px dashed var(--border2);border-radius:10px;padding:24px;text-align:center;margin-top:12px">
         <div style="font-size:36px;margin-bottom:8px">🖼</div>
         <p style="margin:0 0 4px;font-weight:700;font-size:15px">No logo uploaded yet</p>
         <p class="muted" style="font-size:13px;margin:0">Click <b style="color:var(--text)">+ Upload my logo</b> above to get started.</p>
       </div>`
    : state.brandKits.map(bk => `
        <div class="brand-kit-row" data-kit-id="${esc(bk.id)}" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)">
          ${bk.logoUrl
            ? `<img src="${esc(bk.logoUrl)}" style="height:44px;width:auto;max-width:100px;object-fit:contain;border-radius:6px;background:#111;padding:4px;flex-shrink:0">`
            : `<div style="width:100px;height:44px;background:var(--surface2);border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><span class="muted" style="font-size:11px">No logo file</span></div>`}
          <div style="flex:1;min-width:0">
            <b style="font-size:14px">${esc(bk.name)}</b>
            <div class="muted" style="font-size:12px;margin-top:3px">
              ${esc(bk.logoPosition||'top-left')} &middot; ${esc(bk.logoSize||'medium')} size &middot; ${Math.round((bk.logoOpacity??0.9)*100)}% opacity
              &nbsp;
              <span style="color:${bk.watermarkEnabled!==false?'#7be57b':'#888'}">${bk.watermarkEnabled!==false?'● Active':'○ Disabled'}</span>
            </div>
          </div>
          <button class="btn-sm edit-kit-btn" data-kit-id="${esc(bk.id)}" style="flex-shrink:0">Edit</button>
          <button class="btn-sm btn-danger delete-kit-btn" data-kit-id="${esc(bk.id)}" style="flex-shrink:0">Remove</button>
        </div>`).join('');

  $('#settings').innerHTML = `
    <div class="settings-wrap">

      <!-- LOGO SECTION — always first -->
      <section class="panel" id="brandKitSection" style="border:2px solid var(--accent)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div>
            <h2 style="margin:0">🏷 My Logo / Watermark</h2>
            <p class="muted" style="font-size:13px;margin:5px 0 0">Upload your logo once — it will stamp every clip automatically. PNG with transparent background works best.</p>
          </div>
          <button id="newBrandKitBtn" style="padding:10px 20px;font-size:13px;font-weight:700">+ Upload my logo</button>
        </div>
        ${kitsHtml}
        ${state.editingBrandKit ? renderBrandKitForm() : ''}
      </section>

      <!-- Profile -->
      <section class="panel">
        <h2>Profile</h2>
        <form id="profileForm" class="stack" style="max-width:420px">
          <input id="profileName" type="text" value="${esc(user.name||'')}" placeholder="Display name">
          <button type="submit">Save profile</button>
        </form>
      </section>

      <!-- System status -->
      <section class="panel">
        <h2>System status</h2>
        <div class="status-list">
          ${setup.map(s=>`<div class="status-row">
            <span class="status-dot ${s.ready?'on':'off'}"></span>
            <b>${esc(s.label)}</b>
            <small class="muted">${esc(s.action)}</small>
          </div>`).join('')}
        </div>
      </section>

      <!-- Caption styles -->
      <section class="panel">
        <h2>Caption style preview</h2>
        <p style="margin-bottom:12px">Caption styles available when generating clips.</p>
        <div class="style-swatches">
          ${CAPTION_STYLES.map(s=>`<div class="swatch ${s}" data-style="${s}" title="${CAPTION_STYLE_LABELS[s]||s}"><small>${CAPTION_STYLE_LABELS[s]||s}</small></div>`).join('')}
        </div>
      </section>

    </div>`;

  $('#profileForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/profile',{method:'PATCH',body:JSON.stringify({name:$('#profileName').value.trim()})});
      await loadAll(); renderSettings();
    } catch(e2) { alert(e2.message); }
  });

  // Brand kit events
  $('#newBrandKitBtn')?.addEventListener('click', () => {
    state.editingBrandKit = {
      id: null, name:'My Brand', logoPosition:'auto', logoSize:'medium',
      logoSizePercent:12, logoOpacity:0.9, logoBg:false, watermarkEnabled:true,
      captionStyle:'bold', exportFormat:'tiktok', primaryColor:'#FFFFFF', highlightColor:'#FFD700'
    };
    renderSettings();
  });

  $$('.edit-kit-btn').forEach(btn => btn.addEventListener('click', () => {
    state.editingBrandKit = { ...state.brandKits.find(bk => bk.id === btn.dataset.kitId) };
    renderSettings();
  }));

  $$('.delete-kit-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this brand kit?')) return;
    try {
      await api('/api/brand-kit',{method:'DELETE',body:JSON.stringify({id:btn.dataset.kitId})});
      state.brandKits = state.brandKits.filter(bk => bk.id !== btn.dataset.kitId);
      state.editingBrandKit = null;
      renderSettings();
    } catch(e2) { alert(e2.message); }
  }));

  $('#brandKitForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const kit = state.editingBrandKit;
    const payload = {
      id: kit.id,
      name: $('#bkName').value.trim() || 'My Brand',
      textWatermark: ($('#bkTextWatermark').value || '').trim().slice(0, 60),
      textStyle: $('#bkTextStyle').value || 'auto',
      logoPosition: $('#bkPosition').value || 'auto',
      logoSize: 'auto',
      logoOpacity: Number($('#bkOpacity').value) / 100,
      logoBg: false,
      watermarkEnabled: $('#bkEnabled').checked,
    };
    try {
      state.brandKitSaving = true;
      let saved;
      if (kit.id) {
        saved = await api('/api/brand-kit', {method:'PUT', body:JSON.stringify(payload)});
        state.brandKits = state.brandKits.map(bk => bk.id === saved.id ? saved : bk);
      } else {
        saved = await api('/api/brand-kit', {method:'POST', body:JSON.stringify(payload)});
        state.brandKits.push(saved);
      }
      // Logo upload if a file was selected
      const logoFile = $('#bkLogo')?.files?.[0];
      if (logoFile) {
        const fd = new FormData();
        fd.append('brandKitId', saved.id);
        fd.append('logo', logoFile);
        const r = await fetch('/api/brand-kit/logo', {method:'POST', headers:{'x-user-id':uid()}, body:fd});
        const rd = await r.text().then(t=>{try{return JSON.parse(t);}catch{throw new Error('Logo upload failed — invalid response');}});
        if (!r.ok) throw new Error(rd.error || 'Logo upload failed');
        state.brandKits = state.brandKits.map(bk => bk.id === rd.kit.id ? rd.kit : bk);
      }
      state.editingBrandKit = null;
      state.brandKitSaving = false;
      renderSettings();
    } catch(e2) { state.brandKitSaving = false; alert(e2.message); }
  });

  $('#cancelBrandKitBtn')?.addEventListener('click', () => {
    state.editingBrandKit = null;
    renderSettings();
  });
}

function getTextWatermarkHint(val) {
  if (!val) return null;
  const v = val.trim();
  if (v.startsWith('@'))
    return '✓ Detected as social handle — will appear bottom-right, clean white style';
  if (/\.(com|net|org|io|co|tv|me|app|ai|gg|xyz)(\b|\/|$)/i.test(v))
    return '✓ Detected as website — will appear bottom-center, subtle minimal style';
  if (v === v.toUpperCase() && /[A-Z]/.test(v) && v.replace(/\s/g,'').length <= 10)
    return '✓ Detected as brand name — will appear top-right, bold prominent style';
  if (v.replace(/\s/g,'').length <= 8)
    return '✓ Short brand name — will appear top-right, clean style, auto-uppercased';
  return '✓ Brand name — will appear top-right in a dark pill for readability';
}

function renderBrandKitForm() {
  const kit = state.editingBrandKit || {};
  const opacityPct = Math.round((kit.logoOpacity ?? 0.9) * 100);
  const wmVal = kit.textWatermark || '';
  const hint  = getTextWatermarkHint(wmVal);
  return `
    <form id="brandKitForm" class="stack" style="margin-top:16px;padding-top:16px;border-top:2px solid var(--accent)">
      <h3 style="margin:0 0 4px">${kit.id ? 'Edit watermark' : 'Set up your watermark'}</h3>
      <p class="muted" style="font-size:12px;margin:0 0 14px">ClipForge auto-styles the watermark based on what you type — no design skills needed.</p>

      <!-- PRIMARY: text watermark -->
      <div style="padding:14px;background:var(--surface2);border-radius:10px;border:1px solid var(--border2)">
        <label style="display:block;font-weight:700;font-size:13px;margin-bottom:8px">Your brand name, handle, or website</label>
        <input id="bkTextWatermark" type="text" value="${esc(wmVal)}"
          placeholder="e.g.  @YourChannel  ·  BrandName  ·  yoursite.com"
          style="width:100%;box-sizing:border-box;font-size:15px;padding:10px 12px"
          oninput="updateWmHint(this.value)">
        <div id="bkWmHint" style="font-size:12px;color:var(--accent);margin-top:6px;min-height:18px">${hint ? esc(hint) : ''}</div>
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:8px">
          <span style="font-size:11px;color:#888">Examples:</span>
          ${['@YourChannel','ClipForge','yoursite.com','MY BRAND'].map(ex=>`
            <button type="button" onclick="document.getElementById('bkTextWatermark').value='${ex}';document.getElementById('bkTextWatermark').dispatchEvent(new Event('input'))"
              style="font-size:11px;padding:3px 8px;background:var(--surface3,var(--surface2));border:1px solid var(--border);border-radius:4px;cursor:pointer;color:var(--text)">${ex}</button>
          `).join('')}
        </div>
      </div>

      <p style="font-size:12px;color:#666;text-align:center;margin:8px 0">— or upload a logo image (optional, replaces text) —</p>

      <!-- SECONDARY: logo image -->
      <div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">
        ${kit.logoUrl ? `<img src="${esc(kit.logoUrl)}" style="height:36px;margin-bottom:8px;border-radius:4px;background:#111;display:block;padding:4px">` : ''}
        <input id="bkLogo" type="file" accept=".png,.jpg,.jpeg,.webp" style="font-size:12px">
        <small class="muted" style="display:block;margin-top:4px">PNG with transparent background recommended. Replaces text if uploaded.</small>
      </div>

      <!-- Kit internal name -->
      <div class="option-row"><label style="font-size:13px">Kit label</label>
        <input id="bkName" type="text" value="${esc(kit.name||'My Brand')}" placeholder="e.g. Main Channel" style="font-size:13px">
      </div>

      <!-- Style override (auto by default) -->
      <div class="option-row"><label style="font-size:13px">Text style</label>
        <select id="bkTextStyle" style="font-size:13px">
          <option value="auto"     ${(kit.textStyle||'auto')==='auto'    ?'selected':''}>Auto (ClipForge decides)</option>
          <option value="clean"    ${kit.textStyle==='clean'   ?'selected':''}>Clean — white bold, thin outline</option>
          <option value="bold"     ${kit.textStyle==='bold'    ?'selected':''}>Bold — heavy outline, max visibility</option>
          <option value="minimal"  ${kit.textStyle==='minimal' ?'selected':''}>Minimal — subtle, semi-transparent</option>
          <option value="pill"     ${kit.textStyle==='pill'    ?'selected':''}>Pill — text in dark rounded box</option>
          <option value="outlined" ${kit.textStyle==='outlined'?'selected':''}>Outlined — dark text, white border</option>
        </select>
      </div>

      <div class="option-row"><label style="font-size:13px">Position</label>
        <select id="bkPosition" style="font-size:13px">
          <option value="auto"         ${(kit.logoPosition||'auto')==='auto'          ?'selected':''}>Smart Auto — avoids faces & captions (Recommended)</option>
          <option value="top-right"   ${kit.logoPosition==='top-right'    ?'selected':''}>Top right</option>
          <option value="top-left"    ${kit.logoPosition==='top-left'     ?'selected':''}>Top left</option>
          <option value="top-center"  ${kit.logoPosition==='top-center'   ?'selected':''}>Top center</option>
          <option value="bottom-left" ${kit.logoPosition==='bottom-left'  ?'selected':''}>Bottom left</option>
          <option value="bottom-center"${kit.logoPosition==='bottom-center'?'selected':''}>Bottom center</option>
          <option value="bottom-right"${kit.logoPosition==='bottom-right' ?'selected':''}>Bottom right</option>
        </select>
      </div>

      <div class="option-row"><label style="font-size:13px">Opacity <span id="bkOpacityVal">${opacityPct}</span>%</label>
        <input id="bkOpacity" type="range" min="10" max="100" value="${opacityPct}"
          oninput="document.getElementById('bkOpacityVal').textContent=this.value" style="width:140px">
      </div>

      <div class="option-row"><label style="font-size:13px">Active</label>
        <label class="toggle-label"><input id="bkEnabled" type="checkbox" ${kit.watermarkEnabled!==false?'checked':''}> Stamp on every exported clip</label>
      </div>

      <div style="display:flex;gap:8px;margin-top:8px">
        <button type="submit" ${state.brandKitSaving?'disabled':''}>
          ${state.brandKitSaving ? 'Saving…' : (kit.id ? 'Save changes' : 'Save watermark')}
        </button>
        <button type="button" id="cancelBrandKitBtn" class="btn-secondary">Cancel</button>
      </div>
    </form>`;
}

/* ── Admin ─────────────────────────────────────────────────────────── */
function renderAdmin() {
  if (state.session?.user?.role !== 'admin') { setView('home'); return; }
  const db=state.library;
  const users=db.users||[];
  const jobs=db.jobs||[];
  const aiLogs=db.aiLogs||[];
  const failed=jobs.filter(j=>j.status==='failed');

  $('#admin').innerHTML = `
    <div class="admin-wrap">
      <div class="admin-stats">
        <div class="stat-card"><div class="stat-num">${users.length}</div><div class="stat-label">Users</div></div>
        <div class="stat-card"><div class="stat-num">${(db.clips||[]).length}</div><div class="stat-label">Clips</div></div>
        <div class="stat-card"><div class="stat-num">${jobs.filter(j=>j.status==='complete'||j.status==='completed').length}</div><div class="stat-label">Completed</div></div>
        <div class="stat-card"><div class="stat-num">${failed.length}</div><div class="stat-label">Failed</div></div>
      </div>

      <!-- ── Gemini AI (Primary Brain) ── -->
      <section class="panel" style="margin-top:16px;border:2px solid var(--accent)">
        <div class="panel-head" style="margin-bottom:16px">
          <div>
            <span class="eyebrow" style="color:var(--accent)">PRIMARY AI BRAIN</span>
            <h2>Google Gemini <span style="font-size:.7em;font-weight:400;color:#7be57b">FREE</span></h2>
            <p class="muted" style="margin:4px 0 0;font-size:.82rem">Powers: viral clip detection · direct video understanding · hooks · titles · hashtags · thumbnail ideas · B-roll · sound effects · QA review · transcription fallback</p>
          </div>
          <div id="geminiStatusBadge" style="flex-shrink:0">${state.session?.tools?.gemini ? '<span style="color:#7be57b;font-size:.85rem">● Connected</span>' : '<span style="color:#f87272;font-size:.85rem">○ Not configured</span>'}</div>
        </div>
        <form id="geminiConfigForm" class="stack" style="max-width:540px">
          <div>
            <label>Gemini API Key <span class="muted">— free at aistudio.google.com/app/apikey</span></label>
            <div style="display:flex;gap:8px">
              <input id="geminiApiKey" name="GEMINI_API_KEY" type="password" placeholder="AIza..." autocomplete="off" style="flex:1">
              <button type="button" id="geminiReveal" class="ghost" style="flex-shrink:0;padding:10px 14px">Show</button>
            </div>
            <p class="muted" style="margin-top:4px;font-size:.78rem">Free tier: 15 req/min · 1,500 req/day · No credit card needed · Gemini 2.0 Flash model</p>
          </div>
          <div class="option-row">
            <label>AI Model</label>
            <select id="geminiModel" name="LLM_MODEL">
              <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (recommended — most available on free tier)</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash (best reasoning, free)</option>
              <option value="gemini-1.5-flash">Gemini 1.5 Flash (stable, free)</option>
              <option value="gemini-1.5-flash-8b">Gemini 1.5 Flash 8B (smallest quota bucket)</option>
              <option value="gemini-2.5-pro">Gemini 2.5 Pro (most capable, paid)</option>
            </select>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" id="geminiTestBtn" class="ghost">Test Gemini connection</button>
            <button type="submit">Save &amp; activate Gemini</button>
          </div>
          <div id="geminiTestResult"></div>
        </form>
        <div style="margin-top:16px;padding:12px 16px;background:var(--bg2);border-radius:8px;font-size:.8rem;color:var(--fg2)">
          <b>Privacy note:</b> When GEMINI_API_KEY is set, uploaded videos are sent to Google's File API for analysis and automatically deleted after processing.
          Sensitive content should use transcript-only mode (set AI_PROVIDER=openai with LLM_API_KEY instead).
        </div>
      </section>

      <!-- ── LLM / Fallback config ── -->
      <section class="panel" style="margin-top:16px">
        <div class="panel-head" style="margin-bottom:16px">
          <div>
            <span class="eyebrow">FALLBACK / WHISPER</span>
            <h2>LLM Configuration</h2>
            <p class="muted" style="margin:4px 0 0;font-size:.82rem">Used for Whisper word-level transcription (better caption timing) and as chat fallback when Gemini is unavailable.</p>
          </div>
          <div id="llmVerifyBadge"></div>
        </div>
        <form id="llmConfigForm" class="stack" style="max-width:540px">
          <div class="option-row">
            <label>Provider</label>
            <select id="llmProvider" name="LLM_PROVIDER">
              <option value="gemini">Google — Gemini (native SDK, free)</option>
              <option value="xai">xAI — Grok</option>
              <option value="openai">OpenAI — GPT-4o-mini (+ Whisper transcription)</option>
              <option value="groq">Groq — Llama 3.3 70B (free tier)</option>
              <option value="together">Together AI — Llama 3.1 70B</option>
            </select>
          </div>
          <div>
            <label>API Key</label>
            <div style="display:flex;gap:8px">
              <input id="llmApiKey" name="LLM_API_KEY" type="password" placeholder="Paste your API key here" autocomplete="off" style="flex:1">
              <button type="button" id="llmReveal" class="ghost" style="flex-shrink:0;padding:10px 14px">Show</button>
            </div>
            <p class="muted" id="llmKeyHint" style="margin-top:6px;font-size:.78rem">OpenAI key enables Whisper word-level timestamps for perfect caption sync</p>
          </div>
          <div>
            <label>Model <span class="muted">(auto-filled per provider)</span></label>
            <input id="llmModel" name="LLM_MODEL" type="text" placeholder="grok-3-mini">
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" id="llmVerifyBtn" class="ghost">Test connection</button>
            <button type="submit">Save &amp; apply</button>
          </div>
          <div id="llmVerifyResult"></div>
        </form>
      </section>

      <!-- ── Other API keys ── -->
      <section class="panel" style="margin-top:16px">
        <span class="eyebrow">Media Generation</span>
        <h2 style="margin-bottom:14px">API Keys</h2>
        <form id="mediaKeyForm" class="stack" style="max-width:540px">
          ${[['MUAPI_API_KEY','Muapi.ai key (Kling, Seedance, FLUX, Wav2Lip)','console.muapi.ai'],
             ['HIGGSFIELD_API_KEY','Higgsfield AI key (cinematic video)','cloud.higgsfield.ai'],
             ['ELEVENLABS_API_KEY','ElevenLabs key (AI voiceover)','elevenlabs.io'],
             ['YOUTUBE_API_KEY','YouTube Data API key (channel imports)','console.developers.google.com']
            ].map(([key,label,url])=>`
            <div>
              <label>${esc(label)} <span class="muted">— ${esc(url)}</span></label>
              <input type="password" name="${key}" placeholder="${key}" autocomplete="off">
            </div>
          `).join('')}
          <button type="submit">Save keys</button>
          <div id="mediaKeyResult"></div>
        </form>
      </section>

      <!-- ── Users + Credit Management ── -->
      <section class="panel" style="margin-top:16px">
        <div class="panel-head" style="margin-bottom:14px">
          <h2>Users</h2>
          <span class="muted">${users.length} accounts</span>
        </div>
        <div class="admin-table" id="adminUsersTable">
          ${users.map(u=>`<div class="admin-row" data-user-id="${u.id}">
            <div>
              <b>${esc(u.name||u.email)}</b>
              <small class="muted" style="display:block;margin-top:2px">${esc(u.email)}</small>
            </div>
            <div class="meta" style="flex-wrap:wrap;gap:8px">
              ${pill(u.plan||'Free')}
              <span class="credits-badge" data-uid="${u.id}" style="font-weight:600;color:var(--primary2)">${u.credits||0} credits</span>
              ${pill(u.role||'user',u.role==='admin'?'ok':'')}
              ${u.suspended?'<span class="pill error">Suspended</span>':''}
            </div>
            <div class="admin-credit-controls" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px">
              <input type="number" class="credit-amount-input" placeholder="Amount" min="1" max="99999"
                style="width:100px;padding:6px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--fg);font-size:.84rem">
              <button class="ghost admin-add-credits" data-uid="${u.id}" style="padding:7px 14px;font-size:.82rem">+ Add</button>
              <button class="ghost admin-remove-credits" data-uid="${u.id}" style="padding:7px 14px;font-size:.82rem;color:#ff6b6b;border-color:#ff6b6b33">− Remove</button>
              <button class="ghost admin-set-credits" data-uid="${u.id}" style="padding:7px 14px;font-size:.82rem">Set</button>
              <select class="admin-plan-select" data-uid="${u.id}"
                style="padding:6px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--fg);font-size:.82rem">
                <option value="">Change plan…</option>
                <option value="free">Free</option>
                <option value="pro">Pro ($19)</option>
                <option value="creator">Creator ($49)</option>
                <option value="agency">Agency ($149)</option>
              </select>
              <span class="admin-user-msg" data-uid="${u.id}" style="font-size:.78rem;color:var(--primary2)"></span>
            </div>
          </div>`).join('')}
        </div>
      </section>

      ${failed.length?`
        <section class="panel" style="margin-top:16px">
          <h2 style="margin-bottom:12px">Failed jobs</h2>
          ${failed.map(j=>`<div class="job-card failed">
            <div class="job-head">
              <b>${esc((db.videos||[]).find(v=>v.id===j.videoId)?.title||'Video')}</b>
              <button data-retry-job="${j.id}">Retry</button>
            </div>
            <p class="error-text">${esc(j.error||'Unknown error')}</p>
          </div>`).join('')}
        </section>
      `:''}

      <!-- ── AI request log ── -->
      <section class="panel" style="margin-top:16px">
        <div class="panel-head" style="margin-bottom:12px">
          <h2>AI request log</h2>
          <span class="muted">${aiLogs.length} entries</span>
        </div>
        <div class="log-list">
          ${aiLogs.slice(0,30).map(l=>`<div class="log-row">
            <span class="status-dot ${l.ok?'on':'off'}"></span>
            <span>${esc(l.purpose)}</span>
            <small class="muted">${esc(l.model||'—')} · ${l.totalTokens||0} tok · ${when(l.createdAt)}</small>
            ${l.error?`<div style="width:100%"><small class="error-text">${esc(String(l.error).slice(0,120))}</small></div>`:''}
          </div>`).join('')}
        </div>
      </section>
    </div>`;

  // Provider → hint + model auto-fill
  const PROVIDER_HINTS = {
    gemini:   { hint:'Get key at <b>aistudio.google.com/app/apikey</b> — free (starts with AIza...)', model:'gemini-2.5-flash-lite', isGemini: true },
    xai:      { hint:'Get key at <b>console.x.ai</b> — free tier available', model:'grok-3-mini' },
    openai:   { hint:'Get key at <b>platform.openai.com</b> — enables Whisper word-level captions', model:'gpt-4o-mini' },
    groq:     { hint:'Get key at <b>console.groq.com</b> — generous free tier', model:'llama-3.3-70b-versatile' },
    together: { hint:'Get key at <b>api.together.xyz</b> — free credits on signup', model:'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' },
  };
  function applyProviderHint() {
    const p = $('#llmProvider')?.value || 'xai';
    const h = PROVIDER_HINTS[p] || PROVIDER_HINTS.xai;
    if ($('#llmKeyHint')) $('#llmKeyHint').innerHTML = h.hint;
    if ($('#llmModel') && !$('#llmModel').value) $('#llmModel').value = h.model;
    // Show/hide model row — for Gemini show model selector, not free-text
    const modelRow = $('#llmModelRow');
    if (modelRow) modelRow.style.display = 'block';
    const llmModelInput = $('#llmModel');
    if (llmModelInput && h.isGemini) {
      // For Gemini: replace free-text with common model names via placeholder
      llmModelInput.placeholder = 'gemini-2.5-flash-lite';
      if (!llmModelInput.value || !llmModelInput.value.startsWith('gemini')) llmModelInput.value = 'gemini-2.5-flash-lite';
    }
  }
  $('#llmProvider')?.addEventListener('change', applyProviderHint);
  applyProviderHint();

  // ── Gemini handlers ───────────────────────────────────────────────────────
  $('#geminiReveal')?.addEventListener('click', () => {
    const inp=$('#geminiApiKey');
    inp.type=inp.type==='password'?'text':'password';
    $('#geminiReveal').textContent=inp.type==='password'?'Show':'Hide';
  });

  $('#geminiTestBtn')?.addEventListener('click', async () => {
    const btn=$('#geminiTestBtn');
    const res=$('#geminiTestResult');
    const badge=$('#geminiStatusBadge');
    btn.disabled=true; btn.textContent='Testing Gemini…';
    res.innerHTML='';
    try {
      const data=await api('/api/admin/gemini-test',{method:'POST',body:JSON.stringify({
        apiKey:$('#geminiApiKey')?.value||undefined
      })});
      if (data.ok) {
        const features=(data.features||[]).join(' · ');
        res.innerHTML=`<div class="verify-ok" style="margin-top:8px">
          <b>Gemini connected</b> — model: ${esc(data.model)}<br>
          <span style="font-size:.78rem;color:var(--fg2)">Features: ${esc(features)}</span>
        </div>`;
        badge.innerHTML='<span style="color:#7be57b;font-size:.85rem">● Connected</span>';
      } else {
        res.innerHTML=`<div class="verify-fail" style="margin-top:8px">✗ ${esc(data.error)}</div>`;
        badge.innerHTML='<span style="color:#f87272;font-size:.85rem">○ Failed</span>';
      }
    } catch(e) {
      res.innerHTML=`<div class="verify-fail" style="margin-top:8px">✗ ${esc(e.message)}</div>`;
      badge.innerHTML='<span style="color:#f87272;font-size:.85rem">○ Error</span>';
    }
    btn.disabled=false; btn.textContent='Test Gemini connection';
  });

  $('#geminiConfigForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const key=$('#geminiApiKey')?.value||'';
    const model=$('#geminiModel')?.value||'gemini-2.5-flash-lite';
    const settings={
      GEMINI_API_KEY:key,
      GEMINI_MODEL:model,
      AI_PROVIDER:key?'gemini':'',
    };
    try {
      await api('/api/admin/settings',{method:'PATCH',body:JSON.stringify({settings})});
      state.studioStatus=null;
      const btn=e.target.querySelector('button[type=submit]');
      btn.textContent='Saved ✓ — Gemini is now the primary AI brain';
      setTimeout(()=>{ btn.textContent='Save & activate Gemini'; renderAdmin(); },2500);
    } catch(err) { alert(err.message); }
  });

  // ── LLM fallback handlers ─────────────────────────────────────────────────
  $('#llmReveal')?.addEventListener('click', () => {
    const inp=$('#llmApiKey');
    inp.type=inp.type==='password'?'text':'password';
  });

  // Verify button
  $('#llmVerifyBtn')?.addEventListener('click', async () => {
    const btn=$('#llmVerifyBtn');
    const resultEl=$('#llmVerifyResult');
    const badgeEl=$('#llmVerifyBadge');
    btn.disabled=true; btn.textContent='Testing…';
    resultEl.innerHTML='';
    try {
      const res=await api('/api/admin/llm/verify',{method:'POST',body:JSON.stringify({
        provider:$('#llmProvider')?.value,
        apiKey:$('#llmApiKey')?.value,
        model:$('#llmModel')?.value
      })});
      if (res.ok) {
        resultEl.innerHTML=`<div class="verify-ok">✓ Connected — model <b>${esc(res.model)}</b> replied in ${res.ms}ms: "<i>${esc(res.reply)}</i>"</div>`;
        if (badgeEl) badgeEl.innerHTML=`<span class="pill ok">✓ Verified</span>`;
      } else {
        const quotaNote = res.isQuota
          ? `<br><span style="font-size:.78rem">Quota issue — all free-tier models exhausted. Wait a minute or check <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>.</span>`
          : '';
        resultEl.innerHTML=`<div class="verify-fail">✗ ${esc(res.error)}${quotaNote}</div>`;
        if (badgeEl) badgeEl.innerHTML=`<span class="pill error">✗ Failed</span>`;
      }
    } catch(e) {
      resultEl.innerHTML=`<div class="verify-fail">✗ ${esc(e.message)}</div>`;
      if (badgeEl) badgeEl.innerHTML=`<span class="pill error">✗ Error</span>`;
    }
    btn.disabled=false; btn.textContent='Test connection';
  });

  // Save LLM config
  $('#llmConfigForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const provider = $('#llmProvider')?.value || 'xai';
    const apiKey   = $('#llmApiKey')?.value   || '';
    const model    = $('#llmModel')?.value     || '';
    const settings = { LLM_PROVIDER: provider, LLM_API_KEY: apiKey, LLM_MODEL: model };
    // When saving Gemini as LLM provider, also persist GEMINI_API_KEY + GEMINI_MODEL
    if (provider === 'gemini') {
      if (apiKey && apiKey.startsWith('AIza')) settings.GEMINI_API_KEY = apiKey;
      if (model && model.startsWith('gemini')) settings.GEMINI_MODEL = model;
      settings.AI_PROVIDER = 'gemini';
    }
    try {
      await api('/api/admin/settings',{method:'PATCH',body:JSON.stringify({settings})});
      state.studioStatus = null;
      const btn = e.target.querySelector('button[type=submit]');
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save & apply'; }, 2000);
    } catch(err) { alert(err.message); }
  });

  // Save media keys
  $('#mediaKeyForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const settings=Object.fromEntries([...new FormData(e.target).entries()].filter(([,v])=>v));
    try {
      await api('/api/admin/settings',{method:'PATCH',body:JSON.stringify({settings})});
      state.studioStatus=null;
      $('#mediaKeyResult').innerHTML='<div class="verify-ok">Saved ✓</div>';
      setTimeout(()=>{ $('#mediaKeyResult').innerHTML=''; },3000);
    } catch(err) { alert(err.message); }
  });

  // ── Admin credit / plan management ────────────────────────────
  async function adminUserPatch(userId, payload, row) {
    const msgEl = row?.querySelector(`.admin-user-msg[data-uid="${userId}"]`);
    const credBadge = row?.querySelector(`.credits-badge[data-uid="${userId}"]`);
    try {
      const res = await api('/api/admin/users', { method:'PATCH', body:JSON.stringify({ userId, ...payload }) });
      const updated = (res.users||[]).find(u => u.id === userId);
      if (updated && credBadge) credBadge.textContent = `${updated.credits||0} credits`;
      if (msgEl) { msgEl.textContent = '✓ Saved'; setTimeout(()=>{ msgEl.textContent=''; }, 2500); }
      // Refresh local library
      if (state.library?.users) {
        const idx = state.library.users.findIndex(u => u.id === userId);
        if (idx !== -1 && updated) state.library.users[idx] = { ...state.library.users[idx], ...updated };
      }
    } catch(err) {
      if (msgEl) { msgEl.style.color='#ff6b6b'; msgEl.textContent = err.message; setTimeout(()=>{ msgEl.style.color=''; msgEl.textContent=''; }, 4000); }
    }
  }

  $('#adminUsersTable')?.addEventListener('click', async e => {
    const row = e.target.closest('[data-user-id]');
    if (!row) return;
    const userId = row.dataset.userId;
    const amountInput = row.querySelector('.credit-amount-input');
    const amount = parseInt(amountInput?.value || '0', 10);

    if (e.target.closest('.admin-add-credits')) {
      if (!amount || amount < 1) { amountInput?.focus(); return; }
      await adminUserPatch(userId, { creditDelta: amount }, row);
      if (amountInput) amountInput.value = '';
    } else if (e.target.closest('.admin-remove-credits')) {
      if (!amount || amount < 1) { amountInput?.focus(); return; }
      await adminUserPatch(userId, { creditDelta: -amount }, row);
      if (amountInput) amountInput.value = '';
    } else if (e.target.closest('.admin-set-credits')) {
      if (isNaN(amount)) { amountInput?.focus(); return; }
      const current = state.library?.users?.find(u=>u.id===userId)?.credits || 0;
      const delta = amount - current;
      await adminUserPatch(userId, { creditDelta: delta }, row);
      if (amountInput) amountInput.value = '';
    }
  });

  $('#adminUsersTable')?.addEventListener('change', async e => {
    const sel = e.target.closest('.admin-plan-select');
    if (!sel || !sel.value) return;
    const row = sel.closest('[data-user-id]');
    const userId = row?.dataset?.userId;
    if (!userId) return;
    await adminUserPatch(userId, { plan: sel.value }, row);
    sel.value = '';
  });
}

/* ── Auth ─────────────────────────────────────────────────────────── */
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn=$('#authSubmit'); btn.disabled=true; btn.textContent='Please wait…';
  try {
    const isSignup=state.authMode==='signup';
    const endpoint=isSignup?'/api/signup':'/api/login';
    const body={email:$('#authEmail').value,password:$('#authPassword').value};
    if (isSignup) {
      const name=$('#authName')?.value?.trim();
      if (name) body.name=name;
    }
    const data=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.text().then(t=>{try{return JSON.parse(t);}catch{throw new Error('Service unavailable. Please try again.');}}));
    if (data.error) throw new Error(data.error);
    localStorage.setItem('clipforge:userId',data.user.id);
    hideAuth();
    await boot();
  } catch(e2) {
    $('#authMessage').textContent=e2.message;
    btn.disabled=false; btn.textContent=state.authMode==='signup'?'Create account':'Sign in';
  }
});

$('#toggleAuth').addEventListener('click', () => {
  state.authMode=state.authMode==='login'?'signup':'login';
  $('#authTitle').textContent=state.authMode==='signup'?'Create account':'Welcome back';
  $('#authSub').textContent=state.authMode==='signup'?'Start creating viral clips today':'Sign in to your account';
  $('#authSubmit').textContent=state.authMode==='signup'?'Create account':'Sign in';
  $('#toggleAuth').textContent=state.authMode==='signup'?'Already have an account?':'Create account';
  $('#authNameRow').classList.toggle('hidden',state.authMode!=='signup');
  $('#authMessage').textContent='';
});

$('#forgotPassword')?.addEventListener('click', () => {
  $('#authMessage').textContent='Contact your admin to reset your password.';
});

// Logout handled inside drawer

/* ── Event delegation ─────────────────────────────────────────────── */
document.addEventListener('click', e => {
  // Landing page auth triggers
  const authTrigger = e.target.closest('[data-auth-mode]');
  if (authTrigger) { e.preventDefault(); showAuth(authTrigger.dataset.authMode); return; }

  // Auth modal overlay close
  if (e.target.id === 'authModalOverlay') { hideAuth(); return; }

  // More / drawer buttons
  if (e.target.closest('#sideMoreBtn') || e.target.closest('#topMoreBtn')) { openMenu(); return; }
  if (e.target.closest('[data-close-drawer]')) closeMenu();

  const jump=e.target.closest('[data-view],[data-view-jump]');
  if (jump) { e.preventDefault(); setView(jump.dataset.view||jump.dataset.viewJump); }

  const openClip = e.target.closest('[data-open-clip]');
  if (openClip) {
    const clip = state.library.clips.find(c=>c.id===openClip.dataset.openClip);
    if (clip) { closeClipModal(); state.clip=clip; state.hookTab='curiosity'; state.platformTab='tiktok'; setView('clipDetail'); }
  }

  const copy=e.target.closest('[data-copy]');
  if (copy) { navigator.clipboard?.writeText(decodeURIComponent(copy.dataset.copy)); showToast('Copied to clipboard', 'ok', 2000); }

  const retryJob=e.target.closest('[data-retry-job]');
  if (retryJob) api('/api/job',{method:'PATCH',body:JSON.stringify({jobId:retryJob.dataset.retryJob,action:'retry'})}).then(loadAll).then(()=>setView('clips'));

  const deleteJob=e.target.closest('[data-delete-job]');
  if (deleteJob) api('/api/job',{method:'PATCH',body:JSON.stringify({jobId:deleteJob.dataset.deleteJob,action:'delete'})}).then(loadAll).then(()=>setView('clips'));

  const cancelJob=e.target.closest('[data-cancel-job]');
  if (cancelJob) api('/api/job',{method:'PATCH',body:JSON.stringify({jobId:cancelJob.dataset.cancelJob,action:'cancel'})}).then(loadAll).then(()=>setView('clips'));

  const deleteVideo=e.target.closest('[data-delete-video]');
  if (deleteVideo&&confirm('Delete this video and all its clips?')) {
    api('/api/video',{method:'DELETE',body:JSON.stringify({videoId:deleteVideo.dataset.deleteVideo})}).then(loadAll).then(renderCreate);
  }

  const deleteClip=e.target.closest('[data-delete-clip]');
  if (deleteClip&&confirm('Delete this clip?')) {
    api('/api/clip',{method:'DELETE',body:JSON.stringify({clipId:deleteClip.dataset.deleteClip})}).then(loadAll).then(renderClips);
  }

  if (e.target.id==='clearAllVideos'&&confirm('Delete ALL videos and clips? This cannot be undone.')) {
    const vids=state.library?.videos||[];
    Promise.all(vids.map(v=>api('/api/video',{method:'DELETE',body:JSON.stringify({videoId:v.id})}))).then(loadAll).then(renderCreate);
  }

  if (e.target.id==='clearAllClips'&&confirm('Delete all clips? This cannot be undone.')) {
    api('/api/clip',{method:'DELETE',body:JSON.stringify({all:true})}).then(loadAll).then(renderClips);
  }

  const deleteGen=e.target.closest('[data-delete-gen]');
  if (deleteGen&&confirm('Delete this generation?')) {
    api(`/api/ai/generation/${deleteGen.dataset.deleteGen}`,{method:'DELETE'}).then(loadGenerations);
  }
});

/* ── Auto-refresh active jobs ─────────────────────────────────────── */
const _refresh = { startedAt: 0, lastProgressAt: 0, timer: null };
function scheduleRefresh() {
  if (_refresh.timer) { clearTimeout(_refresh.timer); _refresh.timer = null; }
  const now = Date.now();
  if (!_refresh.startedAt) _refresh.startedAt = now;

  const activeJobs = (state.library.jobs||[]).filter(j=>['queued','running'].includes(j.status));
  if (activeJobs.length) {
    // Track progress to detect stalls
    _refresh.lastProgressAt = now;
    _refresh.timer = setTimeout(async () => {
      const prevJobIds = new Set((state.library.jobs||[]).filter(j=>['queued','running'].includes(j.status)).map(j=>j.id));
      await loadAll();
      if (['clips','home'].includes(state.view)) setView(state.view);
      // Detect newly-completed jobs and show toast
      const nowActive = new Set((state.library.jobs||[]).filter(j=>['queued','running'].includes(j.status)).map(j=>j.id));
      const completedCount = [...prevJobIds].filter(id=>!nowActive.has(id)).length;
      if (completedCount > 0) {
        showToast(`${completedCount} clip${completedCount!==1?'s':''} finished! Check your library.`, 'ok');
      }
      scheduleRefresh();
    }, 3000);
  } else {
    // No active jobs — poll slowly, but stop after 30 min of no progress
    const elapsed = now - (_refresh.lastProgressAt || _refresh.startedAt);
    if (elapsed > 30 * 60 * 1000) {
      // 30 minutes with no active jobs — stop polling to save battery
      _refresh.startedAt = 0;
      return;
    }
    _refresh.timer = setTimeout(async () => {
      await loadAll();
      scheduleRefresh();
    }, 10000);
  }
}

/* ── Landing / Auth helpers ───────────────────────────────────────── */
function showAuth(mode) {
  state.authMode = mode === 'signup' ? 'signup' : 'login';
  const isSignup = state.authMode === 'signup';
  if ($('#authTitle')) $('#authTitle').textContent = isSignup ? 'Create account' : 'Welcome back';
  if ($('#authSub')) $('#authSub').textContent = isSignup ? 'Start creating viral content today' : 'Sign in to your account';
  if ($('#authSubmit')) $('#authSubmit').textContent = isSignup ? 'Create account' : 'Sign in';
  if ($('#toggleAuth')) $('#toggleAuth').textContent = isSignup ? 'Already have an account?' : 'Create account';
  if ($('#authNameRow')) $('#authNameRow').classList.toggle('hidden', !isSignup);
  if ($('#authMessage')) $('#authMessage').textContent = '';
  $('#authShell').classList.remove('hidden');
  $('#authModalOverlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#authEmail')?.focus(), 80);
}

function hideAuth() {
  $('#authShell').classList.add('hidden');
  $('#authModalOverlay').classList.add('hidden');
  document.body.style.overflow = '';
}

/* ── Boot ─────────────────────────────────────────────────────────── */
async function boot() {
  if (!uid()) {
    $('#landingShell').classList.remove('hidden');
    $('#authShell').classList.add('hidden');
    $('#appShell').classList.add('hidden');
    return;
  }
  await loadAll();
  const user = state.session?.user;
  if (!user) {
    if (state.session !== null) {
      localStorage.removeItem('clipforge:userId');
    }
    $('#landingShell').classList.remove('hidden');
    $('#authShell').classList.add('hidden');
    $('#appShell').classList.add('hidden');
    return;
  }
  try {
    $('#landingShell').classList.add('hidden');
    $('#authShell').classList.add('hidden');
    $('#authModalOverlay').classList.add('hidden');
    document.body.style.overflow = '';
    $('#appShell').classList.remove('hidden');
    renderNav();
    setView('home');
    scheduleRefresh();
  } catch(e) {
    console.error('Boot render error:', e);
  }
}

/* ── Keyboard shortcuts ───────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.key === 'n') { e.preventDefault(); setView('create'); }
  if (e.key === 'h') setView('home');
  if (e.key === 'Escape') {
    const drawer = document.querySelector('.menu-drawer.open');
    if (drawer) { closeMenu(); return; }
    setView('home');
  }
  if (e.key === '/') {
    e.preventDefault();
    if (state.view === 'create') {
      const urlInput = $('#sourceUrl');
      if (urlInput) { urlInput.focus(); urlInput.select(); }
    }
  }
});

boot();
