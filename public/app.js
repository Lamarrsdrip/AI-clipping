/* ── ClipForge AI — 2026 Content Repurposing Studio ─────────────── */
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = n => Number(n) >= 1e6 ? (n/1e6).toFixed(1)+'M' : Number(n) >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n||0);
const dur = s => { const n=Number(s||0); if(!n) return '--'; const m=Math.floor(n/60); return m>0?`${m}m ${n%60|0}s`:`${n|0}s`; };
const when = d => { if(!d) return ''; const ms=Date.now()-new Date(d).getTime(); const m=Math.floor(ms/60000); return m<1?'just now':m<60?`${m}m ago`:m<1440?`${Math.floor(m/60)}h ago`:`${Math.floor(m/1440)}d ago`; };
function uid() { return localStorage.getItem('clipforge:userId') || ''; }
function api(path, opts = {}) {
  return fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-user-id': uid(), ...(opts.headers || {}) } })
    .then(r => r.json().then(d => { if (d.error) throw new Error(d.error); return d; }));
}
function empty(msg) { return `<div class="empty-state"><div class="empty-icon">✦</div><p>${esc(msg)}</p></div>`; }
function pill(label, cls='') { return `<span class="pill ${cls}">${esc(label)}</span>`; }
function scoreColor(n) { return n>=85?'ok':n>=70?'warn':''; }

const PLATFORMS = ['TikTok','YouTube Shorts','Instagram Reels','X','LinkedIn','Facebook'];
const CAPTION_STYLES = ['bold','hormozi','luxury','neon','minimal','karaoke'];
const FACELESS_STYLES = ['documentary','motivation','finance','crypto','education','comedy','luxury','horror'];
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
  thumbTab: 0
};

/* ── Nav (4 core items only) ─────────────────────────────────────── */
const NAV = [
  { id:'home',      icon:'⌂', label:'Home'     },
  { id:'create',    icon:'✦', label:'Create'   },
  { id:'clips',     icon:'▶', label:'Clips'    },
  { id:'scheduler', icon:'◷', label:'Schedule' }
];

const MENU_ITEMS = [
  { id:'studio',     icon:'⚡', label:'AI Studio',       desc:'B-roll, faceless, thumbnails' },
  { id:'transcript', icon:'◑', label:'Transcripts',      desc:'Full video transcripts' },
  { id:'billing',    icon:'◇', label:'Credits & Billing',desc:'Plans and usage' },
  { id:'settings',   icon:'⚙', label:'Settings',         desc:'Profile and preferences' }
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
    $('#userPlan').textContent   = `${user.credits ?? 0} credits`;
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
      <a class="drawer-item" href="https://console.x.ai" target="_blank" rel="noopener">
        <span class="drawer-icon">🔑</span>
        <div><b>Get Grok API key</b><small>console.x.ai — free tier</small></div>
      </a>
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
  home:       { eyebrow:'Overview',      title:'Dashboard'      },
  create:     { eyebrow:'New project',   title:'Create clips'   },
  clips:      { eyebrow:'Library',       title:'Your clips'     },
  clipDetail: { eyebrow:'Clip detail',   title:'Clip'           },
  scheduler:  { eyebrow:'Publishing',    title:'Schedule'       },
  studio:     { eyebrow:'AI tools',      title:'AI Studio'      },
  transcript: { eyebrow:'AI tools',      title:'Transcript'     },
  billing:    { eyebrow:'Account',       title:'Credits'        },
  settings:   { eyebrow:'Account',       title:'Settings'       },
  admin:      { eyebrow:'Admin',         title:'Admin panel'    }
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
  $('#pageEyebrow').textContent = meta.eyebrow;
  $('#pageTitle').textContent   = meta.title;
  renderNav();

  if (id === 'home')       renderHome();
  if (id === 'create')     renderCreate();
  if (id === 'clips')      renderClips();
  if (id === 'clipDetail') renderClipDetail();
  if (id === 'studio')     renderStudio();
  if (id === 'transcript') renderTranscript();
  if (id === 'billing')    renderBilling();
  if (id === 'settings')   renderSettings();
  if (id === 'admin')      renderAdmin();
  if (id === 'scheduler')  renderScheduler();
}

/* ── Data loading ─────────────────────────────────────────────────── */
async function loadAll() {
  try {
    const [lib, sess] = await Promise.all([
      api('/api/library'),
      api('/api/session')
    ]);
    state.library = lib;
    state.session = sess;
    // also refresh generations in background
    api('/api/ai/generations').then(r => { state.generations = r.generations || []; }).catch(() => {});
  } catch (e) {
    console.warn('loadAll error', e.message);
  }
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

  $('#home').innerHTML = `
    <div class="home-wrap">

      ${/* ── Active jobs banner ── */activeJobs.length ? `
        <div class="processing-banner">
          <div class="processing-pulse"></div>
          <div>
            <b>Generating ${activeJobs.length === 1 ? 'clips' : activeJobs.length + ' jobs'}…</b>
            <span class="muted">${esc(activeJobs[0].stage||'Processing')} · ${activeJobs[0].progress||0}%</span>
          </div>
          <button class="ghost" data-view="clips">View →</button>
        </div>` : ''}

      ${/* ── First-time onboarding ── */isNew ? `
        <div class="onboard-hero">
          <div class="onboard-badge">⚡</div>
          <h2>Hey ${esc(name)}, let's make your first clip</h2>
          <p>Upload a video or paste a YouTube link — AI finds the viral moments and cuts them automatically.</p>
          <button data-view="create" style="margin-top:20px;padding:14px 32px;font-size:1rem">Start creating →</button>
        </div>
        <div class="journey-steps">
          ${[['✦','Import video','Upload or paste a YouTube URL'],
             ['◎','AI analysis','Finds the best moments automatically'],
             ['▶','Review clips','Preview, edit hooks, and download'],
             ['◷','Schedule','Plan posts across all platforms']].map(([ic,t,d],i)=>`
            <div class="journey-step">
              <div class="journey-num">${i+1}</div>
              <div class="journey-icon">${ic}</div>
              <b>${t}</b>
              <small>${d}</small>
            </div>`).join('')}
        </div>
      ` : `
        ${/* ── Stats row ── */`
        <div class="stats-row">
          <div class="stat-card"><div class="stat-num">${doneClips.length}</div><div class="stat-label">Clips ready</div></div>
          <div class="stat-card"><div class="stat-num">${videos.length}</div><div class="stat-label">Videos</div></div>
          <div class="stat-card"><div class="stat-num">${doneClips.length?Math.round(doneClips.reduce((s,c)=>s+(c.score||0),0)/doneClips.length):'—'}</div><div class="stat-label">Avg score</div></div>
          <div class="stat-card"><div class="stat-num">${user.credits??0}</div><div class="stat-label">Credits</div></div>
        </div>`}

        ${failedJobs.length ? `
          <div class="alert-banner">
            <span>⚠ ${failedJobs.length} job${failedJobs.length>1?'s':''} failed</span>
            <button class="ghost" data-view="clips">Review →</button>
          </div>` : ''}

        <div class="home-actions">
          <button class="primary-action" data-view="create">
            <span class="pa-icon">✦</span>
            <div><b>New project</b><small>Upload or import a video</small></div>
          </button>
          <button class="primary-action" data-view="clips">
            <span class="pa-icon">▶</span>
            <div><b>View clips</b><small>${doneClips.length} clip${doneClips.length!==1?'s':''} ready</small></div>
          </button>
        </div>

        <div class="panel-head" style="margin:24px 0 12px">
          <h2>Recent clips</h2>
          <button class="ghost" data-view="clips">View all</button>
        </div>
        <div class="card-grid">${doneClips.slice(0,4).map(clipCard).join('')}</div>
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
                <option value="15">15 s</option>
                <option value="30">30 s</option>
                <option value="45">45 s</option>
                <option value="60">60 s</option>
              </select>
            </div>
            <div class="option-row"><label>Captions</label>
              <select id="captionStyle">
                ${CAPTION_STYLES.map(s=>`<option value="${s}">${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
              </select>
            </div>
          </div>

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
  const btn=$('#processSelected'); btn.disabled=true; btn.textContent='Starting…';
  const clipCount=Number($('#clipCount')?.value||3);
  const clipLength=Number($('#clipLength')?.value||15);
  const captionStyle=$('#captionStyle')?.value||'bold';
  state.importStatus={type:'loading',text:'Starting AI analysis. Check Clips page for progress.'};
  renderCreate();
  try {
    await Promise.all(selected.map(videoId=>api('/api/process',{method:'POST',body:JSON.stringify({videoId,rightsConfirmed:true,clipCount,clipLength,captionStyle})})));
    state.selected.clear(); await loadAll(); setView('clips');
  } catch(err) {
    state.importStatus={type:'error',text:err.message||'Could not start generation.'};
    await loadAll(); renderCreate();
  }
}

/* ── Clips ─────────────────────────────────────────────────────────── */
function renderClips() {
  const clips=(state.library.clips||[]).filter(c=>c.outputPath&&!c.demoMode);
  const allJobs=state.library.jobs||[];
  const activeJobs=allJobs.filter(j=>['queued','running'].includes(j.status));
  const failedJobs=allJobs.filter(j=>j.status==='failed');

  $('#clips').innerHTML = `
    ${activeJobs.length ? `
      <section class="panel processing-panel" style="margin-bottom:16px">
        <div class="panel-head" style="margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="processing-pulse"></div>
            <h2>Processing ${activeJobs.length} job${activeJobs.length!==1?'s':''}…</h2>
          </div>
          <small class="muted">Auto-refreshing</small>
        </div>
        ${activeJobs.map(jobCard).join('')}
      </section>` : ''}

    ${failedJobs.length ? `
      <section class="panel" style="margin-bottom:16px;border-color:rgba(248,113,113,.25)">
        <h2 style="margin-bottom:12px;color:var(--danger)">Failed (${failedJobs.length})</h2>
        ${failedJobs.map(jobCard).join('')}
      </section>` : ''}

    ${clips.length ? `
      <div class="panel-head" style="margin-bottom:12px">
        <h2>${clips.length} clip${clips.length!==1?'s':''} ready</h2>
        <div style="display:flex;gap:8px">
          <button data-view="create">+ New</button>
          <button class="ghost danger-btn" id="clearAllClips">Clear all</button>
        </div>
      </div>
      <div class="card-grid">${clips.map(clipCard).join('')}</div>`
    : activeJobs.length ? '' : `
      <section class="panel empty-state">
        <div class="empty-icon">▶</div>
        <h2>No clips yet</h2>
        <p>Create a project to generate your first viral clips.</p>
        <button data-view="create" style="margin-top:20px">Start creating</button>
      </section>`}`;
}

function jobCard(j) {
  const videos=state.library.videos||[];
  const vid=videos.find(v=>v.id===j.videoId);
  const steps=j.steps||[];
  const isFailed=j.status==='failed';
  const isActive=['queued','running'].includes(j.status);
  const actions=isFailed
    ? `<button data-retry-job="${j.id}">Retry</button><button class="ghost" data-delete-job="${j.id}">Delete</button>`
    : isActive?`<button class="ghost" data-cancel-job="${j.id}">Cancel</button>`:'';
  return `<div class="job-card ${isFailed?'failed':isActive?'active':''}">
    <div class="job-head">
      <div>
        <b>${esc(vid?.title||'Video')}</b>
        ${pill(j.stage||j.status, isFailed?'error':isActive?'warn':'ok')}
      </div>
      <div class="action-row">${actions}</div>
    </div>
    ${steps.length?`<div class="steps-row">${steps.map(s=>`<div class="step ${s.status}"><span></span><small>${esc(s.label)}</small></div>`).join('')}</div>`:''}
    ${isActive?`<div class="progress" style="margin-top:8px"><span style="width:${j.progress||0}%"></span></div>`:''}
    ${j.error?`<p class="error-text">${esc(j.error)}</p>`:''}
  </div>`;
}

function clipCard(c) {
  const dur2=Math.round((c.endSeconds||0)-(c.startSeconds||0));
  const preview=c.thumbnailPath
    ?`<img src="${c.thumbnailPath}" alt="Clip thumbnail" loading="lazy">`
    :`<video src="${c.outputPath}" muted playsinline preload="none"></video>`;
  return `<article class="clip-card" data-open-clip="${c.id}">
    <div class="clip-preview">${preview}<span class="pill ${scoreColor(c.score)}">${c.score}/100</span><span class="clip-dur">${dur2}s</span></div>
    <div class="clip-body">
      <h3>${esc(c.hook||c.title)}</h3>
      <div class="meta"><span>${when(c.createdAt)}</span><span>${esc(c.bestPlatform||'TikTok')}</span><span>${esc(c.captionStyle||'bold')}</span></div>
      <div class="score-bars">
        ${c.hookStrength?`<div class="score-bar"><small>Hook</small><div class="bar"><span style="width:${c.hookStrength*10}%"></span></div></div>`:''}
        ${c.shareability?`<div class="score-bar"><small>Share</small><div class="bar"><span style="width:${c.shareability*10}%"></span></div></div>`:''}
      </div>
      <div class="actions">
        <button data-open-clip="${c.id}">View</button>
        <a class="button ghost" href="${c.outputPath}" download="clip-${c.id}.mp4">Download</a>
        <button class="ghost danger-btn" data-delete-clip="${c.id}">Delete</button>
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
          ${c.outputPath?`<video src="${c.outputPath}" controls poster="${c.thumbnailPath||''}" playsinline></video>`:`<div class="demo-frame">${esc(c.hook)}</div>`}
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
        <a class="button" href="${c.outputPath}" download="clip-${c.id}.mp4" style="text-align:center">⬇ Download clip</a>
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
}

function renderStudioPanel(features, videos) {
  const f=features[state.studioTab];
  if (!f) return empty('Select a feature from the left.');

  if (state.studioTab==='facelessContent') return renderFacelessPanel(f);
  if (state.studioTab==='brollSuggestions') return renderBrollPanel(f, [], videos);
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
           <h3>Setup required</h3>
           <p>Configure <code>${f.setupKey||'API key'}</code> in Admin → API Configuration to enable this feature.</p>
           <button data-view-jump="admin">Go to Admin →</button>
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

async function loadGenerations() {
  try {
    const res = await api('/api/ai/generations');
    state.generations = res.generations || [];
    renderStudio();
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
    setTimeout(async () => { await loadGenerations(); }, 4000);
    renderStudio();
  } catch(err) {
    state.generatorResult = { error: err.message };
    state.generatorRunning = false;
    renderStudio();
  }
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
            <option value="30">30 seconds</option>
            <option value="45" selected>45 seconds</option>
            <option value="60">60 seconds</option>
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
  return `<div class="setup-required"><h3>Setup required</h3><p>Configure <code>${f.setupKey||'API key'}</code> in Admin → API Configuration.</p><button data-view-jump="admin">Go to Admin →</button></div>`;
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
          <h3>Connect your accounts</h3>
          <p style="margin-top:4px">Direct posting requires OAuth setup in Admin → API Configuration.</p>
          <div class="platform-connect-list">
            ${['TikTok','YouTube','Instagram','X / Twitter','LinkedIn'].map(p=>`
              <div class="platform-connect-item">
                <span>${p}</span>
                <span class="pill">Coming soon</span>
              </div>`).join('')}
          </div>
        </div>
      `}
    </div>`;
}

/* ── Billing ─────────────────────────────────────────────────────── */
function renderBilling() {
  const user=state.session?.user||{};
  const plans=state.library.billingPlans||[];
  const txns=(state.library.creditTransactions||[]).filter(t=>t.userId===user.id).slice(0,10);
  $('#billing').innerHTML = `
    <div class="billing-wrap">
      <div class="credit-hero">
        <div class="big-score">${user.credits??0}<small>credits</small></div>
        <p class="muted">Credits are used for AI processing. Clip generation costs 5 credits.</p>
      </div>
      <div class="plans-grid">
        ${plans.map(p=>`<div class="plan-card">
          <h3>${esc(p.name)}</h3>
          <div class="plan-price">$${p.monthlyPrice}<small>/mo</small></div>
          <ul>${(p.features||[`${p.creditsIncluded} credits/month`,`Up to ${p.maxVideoLength}min videos`,`${p.maxClipsPerVideo} clips per video`]).map(f=>`<li>${esc(f)}</li>`).join('')}</ul>
          <button class="ghost">Choose plan</button>
        </div>`).join('')}
      </div>
      ${txns.length?`
        <h3 style="margin:24px 0 12px">Transaction history</h3>
        <div class="txn-list">
          ${txns.map(t=>`<div class="txn-row">
            <span>${esc(t.reason||'Credit')}</span>
            <span class="${t.amount>0?'credit-pos':'credit-neg'}">${t.amount>0?'+':''}${t.amount}</span>
            <small class="muted">${when(t.createdAt)}</small>
          </div>`).join('')}
        </div>
      `:''}
    </div>`;
}

/* ── Settings ─────────────────────────────────────────────────────── */
function renderSettings() {
  const user=state.session?.user||{};
  const tools=state.session?.tools||{};
  const setup=state.session?.setup||[];
  $('#settings').innerHTML = `
    <div class="settings-wrap">
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
      <section class="panel" style="margin-top:16px">
        <h2>Profile</h2>
        <form id="profileForm" class="stack" style="max-width:420px">
          <input id="profileName" type="text" value="${esc(user.name||'')}" placeholder="Display name">
          <button type="submit">Save profile</button>
        </form>
      </section>
      <section class="panel" style="margin-top:16px">
        <h2>Caption style default</h2>
        <div class="style-swatches">
          ${CAPTION_STYLES.map(s=>`<div class="swatch ${s}" data-style="${s}"><small>${s}</small></div>`).join('')}
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
}

/* ── Admin ─────────────────────────────────────────────────────────── */
function renderAdmin() {
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

      <!-- ── LLM / Grok config ── -->
      <section class="panel" style="margin-top:16px">
        <div class="panel-head" style="margin-bottom:16px">
          <div>
            <span class="eyebrow">AI Brain</span>
            <h2>Grok / LLM Configuration</h2>
          </div>
          <div id="llmVerifyBadge"></div>
        </div>
        <form id="llmConfigForm" class="stack" style="max-width:540px">
          <div class="option-row">
            <label>Provider</label>
            <select id="llmProvider" name="LLM_PROVIDER">
              <option value="xai">xAI — Grok (recommended)</option>
              <option value="openai">OpenAI — GPT-4o-mini</option>
              <option value="groq">Groq — Llama 3.3 70B (free tier)</option>
              <option value="together">Together AI — Llama 3.1 70B</option>
            </select>
          </div>
          <div>
            <label>API Key</label>
            <div style="display:flex;gap:8px">
              <input id="llmApiKey" name="LLM_API_KEY" type="password" placeholder="Paste your API key here" autocomplete="off" style="flex:1">
              <button type="button" id="llmReveal" class="ghost" style="flex-shrink:0;padding:10px 14px">👁</button>
            </div>
            <p class="muted" id="llmKeyHint" style="margin-top:6px;font-size:.78rem">xAI Grok: get key at <b>console.x.ai</b> → free tier available</p>
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

      <!-- ── Users ── -->
      <section class="panel" style="margin-top:16px">
        <h2 style="margin-bottom:12px">Users</h2>
        <div class="admin-table">
          ${users.map(u=>`<div class="admin-row">
            <div><b>${esc(u.name||u.email)}</b> <small class="muted">${esc(u.email)}</small></div>
            <div class="meta">${pill(u.plan||'Free')}<span>${u.credits||0} credits</span>${pill(u.role||'user',u.role==='admin'?'ok':'')}</div>
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
    xai:      { hint:'Get key at <b>console.x.ai</b> — free tier available', model:'grok-3-mini' },
    openai:   { hint:'Get key at <b>platform.openai.com</b>', model:'gpt-4o-mini' },
    groq:     { hint:'Get key at <b>console.groq.com</b> — generous free tier', model:'llama-3.3-70b-versatile' },
    together: { hint:'Get key at <b>api.together.xyz</b> — free credits on signup', model:'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' }
  };
  function applyProviderHint() {
    const p=$('#llmProvider')?.value||'xai';
    const h=PROVIDER_HINTS[p]||PROVIDER_HINTS.xai;
    if ($('#llmKeyHint')) $('#llmKeyHint').innerHTML=h.hint;
    if ($('#llmModel')&&!$('#llmModel').value) $('#llmModel').value=h.model;
  }
  $('#llmProvider')?.addEventListener('change', applyProviderHint);
  applyProviderHint();

  // Reveal toggle
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
        badgeEl.innerHTML=`<span class="pill ok">✓ Verified</span>`;
      } else {
        resultEl.innerHTML=`<div class="verify-fail">✗ Failed — ${esc(res.error)}</div>`;
        badgeEl.innerHTML=`<span class="pill error">✗ Failed</span>`;
      }
    } catch(e) {
      resultEl.innerHTML=`<div class="verify-fail">✗ ${esc(e.message)}</div>`;
      badgeEl.innerHTML=`<span class="pill error">✗ Error</span>`;
    }
    btn.disabled=false; btn.textContent='Test connection';
  });

  // Save LLM config
  $('#llmConfigForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const settings={
      LLM_PROVIDER:$('#llmProvider')?.value||'xai',
      LLM_API_KEY:$('#llmApiKey')?.value||'',
      LLM_MODEL:$('#llmModel')?.value||'grok-3-mini'
    };
    try {
      await api('/api/admin/settings',{method:'PATCH',body:JSON.stringify({settings})});
      state.studioStatus=null; // force re-fetch
      const btn=e.target.querySelector('button[type=submit]');
      btn.textContent='Saved ✓'; setTimeout(()=>{ btn.textContent='Save & apply'; },2000);
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
    const data=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
    if (data.error) throw new Error(data.error);
    localStorage.setItem('clipforge:userId',data.user.id);
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
  // More / drawer buttons
  if (e.target.closest('#sideMoreBtn') || e.target.closest('#topMoreBtn')) { openMenu(); return; }
  if (e.target.closest('[data-close-drawer]')) closeMenu();

  const jump=e.target.closest('[data-view],[data-view-jump]');
  if (jump) { e.preventDefault(); setView(jump.dataset.view||jump.dataset.viewJump); }

  const openClip=e.target.closest('[data-open-clip]');
  if (openClip) {
    const clip=state.library.clips.find(c=>c.id===openClip.dataset.openClip);
    if (clip) { state.clip=clip; state.hookTab='curiosity'; state.platformTab='tiktok'; setView('clipDetail'); }
  }

  const copy=e.target.closest('[data-copy]');
  if (copy) navigator.clipboard?.writeText(decodeURIComponent(copy.dataset.copy));

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
function scheduleRefresh() {
  const activeJobs=(state.library.jobs||[]).filter(j=>['queued','running'].includes(j.status));
  if (activeJobs.length) {
    setTimeout(async()=>{
      await loadAll();
      if (['clips','home'].includes(state.view)) setView(state.view);
      scheduleRefresh();
    }, 3000);
  } else {
    setTimeout(scheduleRefresh, 8000);
  }
}

/* ── Boot ─────────────────────────────────────────────────────────── */
async function boot() {
  if (!uid()) {
    $('#authShell').classList.remove('hidden');
    $('#appShell').classList.add('hidden');
    return;
  }
  try {
    await loadAll();
    if (!state.session?.user) throw new Error('Session expired.');
    $('#authShell').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    renderNav();
    setView('home');
    scheduleRefresh();
  } catch {
    localStorage.removeItem('clipforge:userId');
    $('#authShell').classList.remove('hidden');
    $('#appShell').classList.add('hidden');
  }
}

boot();
