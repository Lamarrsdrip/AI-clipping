const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const state = { user: null, session: null, library: {}, selected: new Set(), activeVideoIds: null, clip: null, authMode: 'login', bank: null, importing: false, importStatus: null, importUrl: '', uploadProgress: 0 };
const nav = [['home', '⌂', 'Home'], ['create', '＋', 'Create'], ['clips', '⇩', 'Clips'], ['billing', '◇', 'Billing'], ['settings', '⚙', 'Settings']];
const platforms = ['TikTok', 'Instagram Reels', 'Facebook Reels', 'YouTube Shorts', 'X'];

function uid() { return localStorage.getItem('clipforge:userId') || ''; }
async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json', 'x-user-id': uid() }, ...options });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
  return data;
}
const fmt = n => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const dur = s => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
const when = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'No date';
const empty = text => `<div class="empty">${text}</div>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function renderHome() {
  const clips = state.library.clips || [];
  const jobs = state.library.jobs || [];
  const ready = clips.filter(c => !c.postedAt).length;
  $('#home').innerHTML = `
    <section class="hero-panel clean-hero">
      <div>
        <span class="eyebrow">Manual posting assistant</span>
        <h2>YouTube link in. Ready-to-post shorts out.</h2>
        <p>Paste a video or channel, pick what to process, then download clips with captions, hooks, hashtags, and platform upload steps.</p>
      </div>
      <button data-view-jump="create">Create clips</button>
    </section>
    <div class="metric-grid">
      <article class="metric-card"><span>Credits left</span><b>${state.user.credits}</b></article>
      <article class="metric-card"><span>Clips made</span><b>${clips.length}</b></article>
      <article class="metric-card"><span>Ready to post</span><b>${ready}</b></article>
      <article class="metric-card"><span>Posted</span><b>${clips.filter(c => c.postedAt).length}</b></article>
    </div>
    <section class="panel flow-panel">
      <h2>How it works</h2>
      <div class="flow-steps">
        <article><b>1</b><span>Paste YouTube link</span></article>
        <article><b>2</b><span>Select videos</span></article>
        <article><b>3</b><span>Generate clips</span></article>
        <article><b>4</b><span>Download and post</span></article>
      </div>
    </section>
    <div class="grid-two">
      <section class="panel"><div class="panel-head"><h2>Processing</h2><button class="ghost" data-view-jump="create">New job</button></div>${jobs.length ? jobs.map(jobCard).join('') : empty('No jobs running. Start with Create Clips.')}</section>
      <section class="panel"><div class="panel-head"><h2>Recent clips</h2><button class="ghost" data-view-jump="clips">View all</button></div>${clips.slice(0, 3).map(clipCard).join('') || empty('Your finished clips will appear here with download buttons and posting copy.')}</section>
    </div>`;
}

function renderCreate() {
  $('#create').innerHTML = `
    <div class="create-grid">
      <section class="panel">
        <span class="eyebrow">Step 1</span>
        <h2>Upload video from phone/file</h2>
        <p>This is the main workflow. Upload your mp4, mov, webm, or m4v file, then the app renders vertical 9:16 clips with captions and hook text.</p>
        <div id="importMessage" class="message ${state.importStatus?.type === 'error' ? 'error' : ''}">${state.importStatus?.text || ''}</div>
        <div class="upload-box primary-upload">
          <form id="uploadForm" class="stack"><input id="uploadVideo" type="file" accept="video/mp4,video/quicktime,video/webm,.m4v"><button ${state.importing ? 'disabled' : ''}>${state.importing ? 'Uploading...' : 'Upload video'}</button></form>
          ${state.importing && state.uploadProgress ? `<div class="progress"><span style="width:${state.uploadProgress}%"></span></div><p class="muted">${state.uploadProgress}% uploaded</p>` : ''}
        </div>
        <div class="source-preview">${sourcePreview()}</div>
        <div class="youtube-option">
          <span class="eyebrow">Optional</span>
          <h3>Import YouTube metadata</h3>
          <p>YouTube can block server downloads on Render. If that happens, upload the file above and keep creating clips.</p>
          <form id="importForm" class="source-form"><input id="sourceUrl" type="text" inputmode="url" value="${esc(state.importUrl)}" placeholder="Paste YouTube video, Shorts, channel, or playlist link" ${state.importing ? 'disabled' : ''}><button ${state.importing ? 'disabled' : ''}>Fetch</button></form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><span class="eyebrow">Step 2</span><h2>Select and generate</h2></div><span class="pill">${state.selected.size} selected</span></div>
        <div class="stack">${videoCards()}</div>
        <label class="permission"><input id="rightsBulk" type="checkbox"> I own these videos or have permission to reuse them.</label>
        <div class="stack">
          <select id="clipCount"><option value="3">3 clips per video</option><option value="5">5 clips per video</option><option value="10">10 clips per video</option></select>
          <select id="clipLength"><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="60">60 seconds</option></select>
          <div class="platform-pills">${platforms.map(p => `<label><input type="checkbox" value="${p}" ${p === 'TikTok' ? 'checked' : ''}>${p}</label>`).join('')}</div>
          <button id="processSelected" ${state.selected.size ? '' : 'disabled'}>Generate transformed clips</button>
        </div>
      </section>
    </div>`;
  $('#importForm').addEventListener('submit', importSource);
  $('#uploadForm').addEventListener('submit', uploadSource);
  $$('#create [data-select]').forEach(b => b.addEventListener('click', () => { state.selected.has(b.dataset.select) ? state.selected.delete(b.dataset.select) : state.selected.add(b.dataset.select); renderCreate(); }));
  $('#processSelected').addEventListener('click', processSelected);
}
function sourcePreview() {
  if (state.importing) return `<div class="import-loading"><div class="spinner"></div><b>Working on your video</b><p>${state.uploadProgress ? 'Uploading the file and preparing a thumbnail preview.' : 'Reading YouTube metadata if a link was submitted.'}</p><div class="progress"><span style="width:${state.uploadProgress || 62}%"></span></div></div>`;
  const visible = activeVideos();
  const v = visible[0];
  if (v) return `<article class="project-card import-success"><img class="project-thumb" src="${v.thumbnailUrl || ''}"><span class="pill ok">Ready</span><h3>${v.title || v.channelTitle || 'Uploaded source'}</h3><p>${visible.length} video${visible.length === 1 ? '' : 's'} ready. Select one below, choose clip length, then generate.</p></article>`;
  return empty(state.importStatus?.type === 'error' ? 'Nothing ready yet. Upload the video file from your phone, or try another YouTube link.' : 'Upload a video file to generate a thumbnail preview and start clipping.');
}
function activeVideos() {
  const videos = state.library.videos || [];
  if (!state.activeVideoIds?.length) return videos;
  const active = videos.filter(v => state.activeVideoIds.includes(v.id));
  return active.length ? active : videos;
}
function videoCards() {
  const videos = activeVideos();
  return videos.length ? videos.map(v => `<article class="video-card ${state.selected.has(v.id) ? 'selected' : ''}"><img src="${v.thumbnailUrl || ''}"><div><div class="meta"><span>${dur(v.durationSeconds)}</span><span>${v.sourceKind === 'upload' ? 'Uploaded file' : `${fmt(v.viewCount)} views`}</span><span>${v.isShort ? 'Shorts/direct' : 'Long-form'}</span><span>${when(v.publishedAt)}</span></div><h3>${v.title}</h3><p>${v.channelTitle || 'YouTube'} ${v.importWarning ? `• ${v.importWarning}` : ''}</p><button class="ghost" data-select="${v.id}">${state.selected.has(v.id) ? 'Selected' : 'Select'}</button></div></article>`).join('') : empty('No videos imported yet.');
}
async function importSource(e) {
  e.preventDefault();
  const sourceUrl = $('#sourceUrl').value.trim();
  if (!sourceUrl) {
    state.importStatus = { type: 'error', text: 'Paste a YouTube link first, or upload a video file above.' };
    renderCreate();
    return;
  }
  state.importUrl = sourceUrl;
  state.importing = true;
  state.uploadProgress = 0;
  state.activeVideoIds = null;
  state.selected.clear();
  state.importStatus = { type: 'loading', text: 'Fetching YouTube metadata...' };
  renderCreate();
  try {
    const res = await api('/api/import', { method: 'POST', body: JSON.stringify({ sourceUrl }) });
    state.activeVideoIds = (res.videos || []).map(v => v.id);
    state.importStatus = { type: 'success', text: `Imported ${res.videos.length} video${res.videos.length === 1 ? '' : 's'} using ${res.source || 'metadata'}.` };
    if (res.warnings?.length) state.importStatus.text += ` ${res.warnings[0]}`;
    await loadAll();
    state.importing = false;
    setView('create');
  } catch (err) {
    state.importing = false;
    state.importStatus = { type: 'error', text: err.message || 'Import failed. Try another YouTube link.' };
    renderCreate();
  }
}
async function uploadSource(e) {
  e.preventDefault();
  const file = $('#uploadVideo').files?.[0];
  if (!file) {
    state.importStatus = { type: 'error', text: 'Choose a video file first.' };
    renderCreate();
    return;
  }
  const allowed = ['mp4', 'mov', 'webm', 'm4v'];
  const ext = file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) {
    state.importStatus = { type: 'error', text: 'Unsupported format. Upload mp4, mov, webm, or m4v.' };
    renderCreate();
    return;
  }
  state.importing = true;
  state.uploadProgress = 1;
  state.importUrl = '';
  state.activeVideoIds = [];
  state.selected.clear();
  state.importStatus = { type: 'loading', text: `Uploading ${file.name}...` };
  renderCreate();
  try {
    const form = new FormData();
    form.append('video', file);
    form.append('title', file.name.replace(/\.[^.]+$/, ''));
    const data = await uploadWithProgress(form);
    state.activeVideoIds = (data.videos || []).map(v => v.id);
    state.selected = new Set(state.activeVideoIds);
    state.uploadProgress = 100;
    const removed = data.cleanup?.removedVideos ? ` Removed ${data.cleanup.removedVideos} old source video${data.cleanup.removedVideos === 1 ? '' : 's'}.` : '';
    state.importStatus = { type: 'success', text: `Uploaded ${data.videos.length} video file. Thumbnail ready. Select clip length and generate clips.${removed}` };
    await loadAll();
    state.importing = false;
    state.uploadProgress = 0;
    setView('create');
  } catch (err) {
    state.importing = false;
    state.uploadProgress = 0;
    state.importStatus = { type: 'error', text: err.message || 'Upload failed.' };
    renderCreate();
  }
}
function uploadWithProgress(form) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('x-user-id', uid());
    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      state.uploadProgress = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
      state.importStatus = { type: 'loading', text: `Uploading video... ${state.uploadProgress}%` };
      renderCreate();
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { return reject(new Error('Upload failed. Server returned an invalid response.')); }
      if (xhr.status >= 400 || data.error) reject(new Error(data.error || 'Upload failed.'));
      else resolve(data);
    };
    xhr.send(form);
  });
}
async function processSelected() {
  if (!$('#rightsBulk').checked) return alert('Confirm permission first.');
  const selected = [...state.selected];
  if (!selected.length) return alert('Select at least one video first.');
  const button = $('#processSelected');
  button.disabled = true;
  button.textContent = 'Starting job...';
  const clipCount = Number($('#clipCount')?.value || 3);
  const clipLength = Number($('#clipLength')?.value || 15);
  state.importStatus = { type: 'loading', text: 'Starting clip generation. You will see progress on the Clips page.' };
  renderCreate();
  try {
    await Promise.all(selected.map(videoId => api('/api/process', { method: 'POST', body: JSON.stringify({ videoId, rightsConfirmed: true, clipCount, clipLength }) })));
    state.selected.clear();
    await loadAll();
    setView('clips');
  } catch (err) {
    state.importStatus = { type: 'error', text: err.message || 'Could not start clip generation.' };
    await loadAll();
    setView('create');
  }
}
function jobCard(j) {
  const v = state.library.videos?.find(x => x.id === j.videoId);
  const blocked = /Upload the video file instead/i.test(j.error || '');
  return `<article class="admin-card"><div class="panel-head"><div><b>${v?.title || 'Video'}</b><p>${j.stage}${j.error ? ` • ${esc(j.error)}` : ''}</p></div><span class="pill ${j.status === 'complete' ? 'ok' : j.status === 'failed' ? 'bad' : 'warn'}">${j.status}</span></div><div class="progress"><span style="width:${j.progress || 0}%"></span></div>${j.status === 'failed' ? `<div class="actions"><button data-retry-job="${j.id}">Retry</button><button class="ghost" data-delete-job="${j.id}">Delete</button>${blocked ? '<button data-view-jump="create">Upload file instead</button>' : ''}</div>` : ''}</article>`;
}

function renderClips() {
  const clips = (state.library.clips || []).filter(c => c.outputPath && !c.demoMode);
  const seen = new Set();
  const jobs = (state.library.jobs || []).filter(j => !['complete', 'completed'].includes(j.status)).filter(j => {
    const key = j.status === 'failed' ? `${j.videoId}:${j.status}:${j.error}` : j.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  $('#clips').innerHTML = `${jobs.length ? `<section class="panel"><h2>Processing</h2>${jobs.map(jobCard).join('')}</section>` : ''}${clips.length ? `<div class="panel-head"><div><span class="eyebrow">Library</span><h2>Ready clips</h2></div><button data-view-jump="create">Create more</button></div><div class="card-grid">${clips.map(clipCard).join('')}</div>` : `<section class="panel empty-state"><h2>No clips generated yet</h2><p>Create clips from a YouTube link or upload a video file. Real rendered clips will appear here after FFmpeg finishes.</p><button data-view-jump="create">Create clips</button></section>`}`;
}
function clipCard(c) {
  const assistant = c.postingAssistant || {};
  const intel = c.intelligence || {};
  return `<article class="clip-card"><div class="clip-preview"><video src="${c.outputPath}" muted playsinline></video><span class="pill ok">${c.score}/100</span></div><div class="clip-body"><h3>${assistant.suggestedTitle || c.hook}</h3><div class="meta"><span>${Math.round((c.endSeconds || 0) - (c.startSeconds || 0))}s</span><span>${when(c.createdAt)}</span><span>${assistant.bestPlatform || 'TikTok'}</span><span>${intel.smartEditPlan?.mode || 'Smart cut'}</span></div><p>${c.rationale}</p><div class="actions"><button data-open-clip="${c.id}">Preview</button><a class="button ghost" href="${c.outputPath}" download>Download</a><button class="ghost" data-copy="${encodeURIComponent(assistant.caption || c.postCaption || '')}">Copy caption</button><button class="ghost" data-copy="${encodeURIComponent((assistant.hashtags || c.hashtags || []).join(' '))}">Copy hashtags</button></div></div></article>`;
}

function renderClipDetail() {
  const c = state.clip;
  if (!c) { $('#clipDetail').innerHTML = empty('Choose a clip first.'); return; }
  const a = c.postingAssistant || {};
  const intel = c.intelligence || {};
  $('#clipDetail').innerHTML = `<div class="grid-two">
    <section class="panel stack"><div class="phone">${c.outputPath ? `<video src="${c.outputPath}" controls></video>` : `<div class="demo">${c.hook}</div>`}</div>${downloadButton(c)}${viralRecipePanel(intel)}${smartEditPanel(intel)}</section>
    <section class="panel stack">
      <h2>${a.suggestedTitle || c.title}</h2>
      ${hookBattlePanel(intel)}
      ${transformationPanel(c)}
      <div class="copy-box"><b>Caption</b><p>${a.caption || c.postCaption}</p><button class="ghost" data-copy="${encodeURIComponent(a.caption || c.postCaption || '')}">Copy caption</button></div>
      <div class="copy-box"><b>Hashtags</b><p>${(a.hashtags || c.hashtags || []).join(' ')}</p><button class="ghost" data-copy="${encodeURIComponent((a.hashtags || c.hashtags || []).join(' '))}">Copy hashtags</button></div>
      <p><b>Best platform:</b> ${a.bestPlatform || 'TikTok'}<br><b>Best time:</b> ${a.bestTime || '6-9 PM'}<br><b>First comment:</b> ${a.firstComment || ''}</p>
      <h2>Originality checklist</h2><div class="stack">${originalityChecklist(c)}</div>
      <button id="markPosted">${c.postedAt ? 'Posted' : 'Mark as posted'}</button>
      <button id="saveTransform" class="ghost">Save transformation settings</button>
    </section>
  </div>
  ${viralLabPanel(intel)}
  <section class="panel"><h2>Platform upload instructions</h2><div class="card-grid">${Object.entries(a.instructions || {}).map(([platform, steps]) => `<article class="project-card"><h3>${platform}</h3><ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol></article>`).join('')}</div></section>`;
  $('#markPosted')?.addEventListener('click', markPosted);
  $('#saveTransform')?.addEventListener('click', saveTransformation);
  $$('#clipDetail [data-originality]').forEach(input => input.addEventListener('change', updateDownloadState));
  updateDownloadState();
}

function viralRecipePanel(intel) {
  const recipe = intel.viralRecipe || {};
  const rows = [
    ['Hook', recipe.hookStrength],
    ['Emotion', recipe.emotionalPunch],
    ['Share', recipe.shareability],
    ['Clarity', recipe.clarity]
  ];
  return `<div class="viral-panel"><h2>Viral recipe</h2>${rows.map(([label, value]) => `<div class="score-row"><span>${label}</span><b>${value || 0}/10</b><i style="width:${(value || 0) * 10}%"></i></div>`).join('')}<p>${esc(recipe.retentionRisk || 'Retention analysis will appear here.')}</p></div>`;
}
function smartEditPanel(intel) {
  const plan = intel.smartEditPlan || {};
  return `<div class="viral-panel"><h2>${esc(plan.mode || 'Smart edit')}</h2><p>Removed dead air estimate: <b>${plan.removedDeadAirSeconds || 0}s</b></p><div class="mini-list">${(plan.segments || []).map(s => `<span>${esc(s.label || 'segment')}: ${dur(s.start)}-${dur(s.end)}</span>`).join('')}</div><p>Zoom cuts: ${(plan.zoomCuts || []).map(z => `${z.amount} at ${z.at}s`).join(', ') || 'None'}</p></div>`;
}
function hookBattlePanel(intel) {
  const hooks = (intel.hookBattle || []).slice(0, 5);
  return `<div class="viral-panel"><h2>Hook battle</h2>${hooks.length ? hooks.map(h => `<button class="ghost wide" data-copy="${encodeURIComponent(h.text)}">#${h.rank} ${esc(h.text)} · ${h.score}</button>`).join('') : empty('Hook variants will appear after clip generation.')}</div>`;
}
function viralLabPanel(intel) {
  return `<section class="panel stack"><div class="panel-head"><div><span class="eyebrow">Viral lab</span><h2>Make this clip stronger</h2></div></div><div class="card-grid">
    <article class="project-card"><h3>Retention timeline</h3>${(intel.retentionTimeline || []).map(i => `<p><b>${esc(i.range)} ${esc(i.label)}:</b> ${esc(i.note)}</p>`).join('') || '<p>No retention notes yet.</p>'}</article>
    <article class="project-card"><h3>Platform variants</h3>${(intel.platformVariants || []).map(v => `<p><b>${esc(v.platform)}:</b> ${esc(v.edit)} <span class="pill ok">${esc(v.scoreBoost)}</span></p>`).join('')}</article>
    <article class="project-card"><h3>Originality booster</h3><p>Current score: <b>${intel.originalityBooster?.score || 0}%</b></p>${(intel.originalityBooster?.upgrades || []).map(u => `<p>+${u.boost}% ${esc(u.label)}</p>`).join('')}</article>
    <article class="project-card"><h3>B-roll prompts</h3>${(intel.brollPrompts || []).map(p => `<p>${esc(p)}</p>`).join('')}</article>
    <article class="project-card"><h3>Clip series</h3>${(intel.clipSeries || []).map(p => `<p><b>Part ${p.part}: ${esc(p.title)}</b><br>${esc(p.angle)}</p>`).join('')}</article>
    <article class="project-card"><h3>Creator memory</h3><p>${esc(intel.creatorVoiceMemory?.tone || 'No voice saved yet.')}</p><p>${esc(intel.learningTracker?.note || '')}</p></article>
  </div></section>`;
}
function transformationPanel(c) {
  const t = c.transformation || {};
  return `<div class="transform-box">
    <h2>Transformation tools</h2>
    <label>Custom intro hook text<input id="introHookText" value="${t.introHookText || ''}"></label>
    <label>AI summary overlay<textarea id="summaryOverlay" rows="3">${t.summaryOverlay || ''}</textarea></label>
    <label>Caption style<select id="captionStyle"><option ${t.captionStyle === 'Bold captions' ? 'selected' : ''}>Bold captions</option><option ${t.captionStyle === 'Clean subtitles' ? 'selected' : ''}>Clean subtitles</option><option ${t.captionStyle === 'Podcast style' ? 'selected' : ''}>Podcast style</option></select></label>
    <label>Source credit text<input id="sourceCredit" value="${t.sourceCredit || ''}" placeholder="Source: Channel / Video"></label>
    <label>Watermark / brand text<input id="watermarkText" value="${t.watermarkText || ''}"></label>
    <label>Voiceover/commentary file<input id="voiceoverFilename" type="file" accept="audio/*,video/*"></label>
    <label>Vertical background frame<select id="verticalFrame"><option ${t.verticalFrame === 'Blurred background' ? 'selected' : ''}>Blurred background</option><option ${t.verticalFrame === 'Solid brand frame' ? 'selected' : ''}>Solid brand frame</option><option ${t.verticalFrame === 'Soft gradient frame' ? 'selected' : ''}>Soft gradient frame</option></select></label>
    <label class="permission"><input id="splitScreenCommentary" type="checkbox" ${t.splitScreenCommentary ? 'checked' : ''}> Split-screen commentary layout</label>
    <label class="permission"><input id="zoomCuts" type="checkbox" ${(t.effects || []).includes('Zoom cuts') ? 'checked' : ''}> Add zoom cuts</label>
    <label class="permission"><input id="highlightEffects" type="checkbox" ${(t.effects || []).includes('Highlight keywords') ? 'checked' : ''}> Highlight effects</label>
    <label>B-roll placeholders<textarea id="brollPlaceholders" rows="2">${(t.brollPlaceholders || []).join('\\n')}</textarea></label>
  </div>`;
}
function originalityChecklist(c) {
  const checklist = c.transformation?.originalityChecklist || [];
  return checklist.map(item => `<label class="permission"><input data-originality="${item.id}" type="checkbox" ${item.done ? 'checked' : ''}>${item.label}</label>`).join('');
}
function downloadButton(c) {
  if (!c.outputPath) return '<button class="wide" disabled>Download unavailable until rendering completes</button>';
  return `<a id="downloadClip" class="button wide disabled" href="${c.outputPath}" download title="Complete originality checklist first">Download video</a>`;
}
function updateDownloadState() {
  const link = $('#downloadClip');
  if (!link) return;
  const complete = $$('[data-originality]').every(input => input.checked);
  link.classList.toggle('disabled', !complete);
  link.setAttribute('aria-disabled', String(!complete));
  link.title = complete ? 'Download transformed clip' : 'Complete originality checklist first';
}
async function saveTransformation() {
  const effects = [];
  if ($('#zoomCuts')?.checked) effects.push('Zoom cuts');
  if ($('#highlightEffects')?.checked) effects.push('Highlight keywords');
  const checklist = $$('[data-originality]').map(input => ({ id: input.dataset.originality, label: input.parentElement.textContent.trim(), done: input.checked }));
  const file = $('#voiceoverFilename')?.files?.[0];
  const transformation = {
    introHookText: $('#introHookText').value,
    summaryOverlay: $('#summaryOverlay').value,
    captionStyle: $('#captionStyle').value,
    sourceCredit: $('#sourceCredit').value,
    watermarkText: $('#watermarkText').value,
    splitScreenCommentary: $('#splitScreenCommentary').checked,
    voiceoverFilename: file?.name || state.clip.transformation?.voiceoverFilename || '',
    verticalFrame: $('#verticalFrame').value,
    effects,
    brollPlaceholders: $('#brollPlaceholders').value.split('\\n').map(v => v.trim()).filter(Boolean),
    originalityChecklist: checklist
  };
  await api('/api/clip', { method: 'PATCH', body: JSON.stringify({ id: state.clip.id, transformation }) });
  await loadAll();
  state.clip = state.library.clips.find(c => c.id === state.clip.id);
  renderClipDetail();
}
async function markPosted() {
  await api('/api/clip', { method: 'PATCH', body: JSON.stringify({ id: state.clip.id, posted: true }) });
  await loadAll();
  state.clip = state.library.clips.find(c => c.id === state.clip.id);
  renderClipDetail();
}

function renderSettings() {
  const setup = (state.session.setup || []).filter(item => ['youtube', 'llm', 'postgres', 'ytdlp', 'ffmpeg'].includes(item.id));
  $('#settings').innerHTML = `<div class="settings-grid"><section class="panel"><h2>Profile</h2><form id="profileForm" class="stack"><label>Name<input id="profileName" value="${esc(state.user.name)}"></label><label>Email<input value="${esc(state.user.email)}" disabled></label><button>Save profile</button></form><p class="muted">This MVP creates videos and posting copy. You manually upload them to each platform.</p></section><section class="panel"><h2>System status</h2><p>Only admins can change API keys. This list shows whether the clip pipeline is ready.</p><div class="stack">${setup.map(item => `<div class="setup-item ${item.ready ? 'ready' : ''}"><b>${item.ready ? 'Ready' : 'Needs setup'}: ${item.label}</b><p>${item.ready ? 'Working' : item.action}</p></div>`).join('')}</div></section></div>`;
  $('#profileForm').addEventListener('submit', async e => { e.preventDefault(); await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ name: $('#profileName').value }) }); await loadAll(); });
}
async function renderBilling() {
  state.bank = await api('/api/billing/bank');
  const tx = state.library.creditTransactions || [];
  const mine = (state.library.paymentRequests || []).filter(p => p.userId === state.user.id);
  $('#billing').innerHTML = `<div class="grid-two">
    <section class="panel stack">
      <span class="eyebrow">Local payment</span>
      <h2>Buy credits by bank transfer</h2>
      <p>Credits are intentionally lightweight. One video processing job uses 5 credits, so small packs can still create multiple clips.</p>
      <div class="copy-box"><b>${state.bank.bankAccount.bankName}</b><p>Account name: ${state.bank.bankAccount.accountName}<br>Account number: ${state.bank.bankAccount.accountNumber}</p><p>${state.bank.bankAccount.instructions}</p></div>
      <form id="bankTransferForm" class="stack">
        <select id="creditPackage">${state.bank.creditPackages.map(p => `<option value="${p.credits}" data-amount="${p.amount}" data-currency="${p.currency}">${p.credits} credits - ${p.currency} ${p.amount.toLocaleString()}</option>`).join('')}</select>
        <input id="transferAmount" type="number" placeholder="Amount transferred" required>
        <input id="depositorName" placeholder="Depositor/account name" required>
        <input id="transferReference" placeholder="Transfer reference/session ID" required>
        <textarea id="transferNote" rows="3" placeholder="Optional note"></textarea>
        <button>Submit for verification</button>
      </form>
      <div id="billingMessage" class="message"></div>
    </section>
    <section class="panel"><h2>Requests</h2>${mine.length ? mine.map(p => `<article class="project-card"><span class="pill ${p.status === 'approved' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn'}">${p.status}</span><h3>${p.credits} credits</h3><p>${p.currency} ${p.amount} • ${p.reference}</p></article>`).join('') : empty('No payment requests yet. Submit your transfer reference after paying.')}<h2>Credit history</h2>${tx.length ? tx.map(t => `<p>${t.amount > 0 ? '+' : ''}${t.amount} credits • ${t.reason}</p>`).join('') : empty('No credit history yet.')}</section>
  </div>`;
  $('#bankTransferForm').addEventListener('submit', submitBankTransfer);
  $('#creditPackage').addEventListener('change', e => { $('#transferAmount').value = e.target.selectedOptions[0].dataset.amount; });
  $('#transferAmount').value = $('#creditPackage').selectedOptions[0].dataset.amount;
}
async function submitBankTransfer(e) {
  e.preventDefault();
  const opt = $('#creditPackage').selectedOptions[0];
  try {
    await api('/api/billing/transfer', { method: 'POST', body: JSON.stringify({
      credits: Number($('#creditPackage').value),
      amount: Number($('#transferAmount').value),
      currency: opt.dataset.currency,
      depositorName: $('#depositorName').value,
      reference: $('#transferReference').value,
      note: $('#transferNote').value
    }) });
    $('#billingMessage').textContent = 'Submitted. Admin will verify funds and add credits.';
    await loadAll();
    await renderBilling();
  } catch (err) {
    $('#billingMessage').className = 'message error';
    $('#billingMessage').textContent = err.message;
  }
}

function setView(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === view));
  $$('[data-view]').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  const titles = { home: ['Home', 'AI clipping tool'], create: ['Create', 'Transform YouTube clips'], clips: ['Clips', 'Transformed clips'], clipDetail: ['Transform + Post', 'Originality workspace'], billing: ['Billing', 'Bank transfer credits'], settings: ['Settings', 'Profile and setup'], admin: ['Admin', 'Bank payments and setup'] };
  $('#pageEyebrow').textContent = titles[view]?.[0] || 'ClipForge';
  $('#pageTitle').textContent = titles[view]?.[1] || 'App';
  if (view === 'clipDetail') renderClipDetail();
  if (view === 'billing') renderBilling();
  if (view === 'admin') renderAdmin();
}

setInterval(async () => {
  if (!uid() || !state.library?.jobs?.some(job => !['complete', 'completed', 'failed'].includes(job.status))) return;
  const activeView = $('.view.active')?.id || 'home';
  try {
    await loadAll();
    setView(activeView);
  } catch {}
}, 5000);

function renderNav() {
  const items = [...nav, ...(state.user?.role === 'admin' ? [['admin', '◆', 'Admin']] : [])];
  $('#sideNav').innerHTML = items.map(([id, icon, label]) => `<a href="#${id}" data-view="${id}">${icon} ${label}</a>`).join('');
  $('#bottomNav').innerHTML = nav.map(([id, icon, label]) => `<a href="#${id}" data-view="${id}">${icon}<span>${label}</span></a>`).join('');
}
async function loadAll() {
  state.session = await api('/api/session');
  state.user = state.session.user;
  state.library = await api('/api/library');
  $('#userName').textContent = state.user.name;
  $('#userPlan').textContent = `${state.user.credits} credits`;
  renderNav();
  renderHome(); renderCreate(); renderClips(); renderSettings();
}
async function renderAdmin() {
  if (state.user.role !== 'admin') return setView('home');
  const bank = await api('/api/admin/bank');
  const ai = await api('/api/admin/ai-settings');
  const payments = bank.paymentRequests || [];
  const s = ai.settings || {};
  const logs = ai.logs || [];
  $('#admin').innerHTML = `<div class="grid-two">
    <section class="panel stack">
      <h2>AI settings</h2>
      <p>Server-side provider config for transcript analysis, viral scoring, hooks, captions, hashtags, and posting guides.</p>
      <form id="adminAiForm" class="stack">
        <label>Provider<select id="aiProvider"><option value="emergent" ${s.provider === 'emergent' ? 'selected' : ''}>Emergent Universal Key</option><option value="openai" ${s.provider === 'openai' ? 'selected' : ''}>OpenAI-compatible</option></select></label>
        <label>Model<input id="aiModel" value="${esc(s.model || 'gpt-4o-mini')}" placeholder="gpt-4o-mini"></label>
        <label>Optional base URL<input id="aiBaseUrl" value="${esc(s.baseUrl || '')}" placeholder="Default for Emergent: https://api.emergent.sh/v1"></label>
        <label>API key<input id="aiApiKey" type="password" placeholder="${s.apiKeyConfigured ? 'Key saved. Leave blank to keep it.' : 'Paste API key'}"></label>
        <div class="actions"><button>Save AI settings</button><button type="button" class="ghost" id="testAi">Test AI</button></div>
      </form>
      <div class="copy-box"><b>Effective route</b><p>${esc(s.effectiveBaseUrl || 'Not configured')}</p></div>
      <div id="aiMessage" class="message"></div>
    </section>
    <section class="panel">
      <h2>AI logs</h2>
      ${logs.length ? logs.map(l => `<article class="project-card"><span class="pill ${l.ok ? 'ok' : 'bad'}">${l.ok ? 'ok' : 'failed'}</span><h3>${esc(l.purpose || 'AI request')}</h3><p>${esc(l.provider)} • ${esc(l.model)}<br>Tokens: ${l.totalTokens || 0} ${l.error ? `<br>${esc(l.error)}` : ''}</p></article>`).join('') : empty('No AI requests logged yet. Use Test AI to confirm the provider.')}
    </section>
    <section class="panel stack"><h2>Bank account shown to users</h2><form id="adminBankForm" class="stack"><input id="adminBankName" value="${esc(bank.bankAccount.bankName || '')}" placeholder="Bank name"><input id="adminAccountName" value="${esc(bank.bankAccount.accountName || '')}" placeholder="Account name"><input id="adminAccountNumber" value="${esc(bank.bankAccount.accountNumber || '')}" placeholder="Account number"><textarea id="adminInstructions" rows="3">${esc(bank.bankAccount.instructions || '')}</textarea><button>Save bank account</button></form><div id="adminMessage" class="message"></div></section>
    <section class="panel"><h2>Pending payment verification</h2>${payments.length ? payments.map(p => `<article class="project-card"><span class="pill ${p.status === 'approved' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn'}">${p.status}</span><h3>${p.credits} credits</h3><p>${p.currency} ${p.amount} • ${p.depositorName}<br>Ref: ${p.reference}</p><div class="actions"><button data-approve-payment="${p.id}">Approve</button><button class="ghost" data-reject-payment="${p.id}">Reject</button></div></article>`).join('') : empty('No payment requests yet.')}</section>
  </div>`;
  $('#adminBankForm').addEventListener('submit', saveAdminBank);
  $('#adminAiForm').addEventListener('submit', saveAiSettings);
  $('#testAi').addEventListener('click', testAiConnection);
}
async function saveAdminBank(e) {
  e.preventDefault();
  await api('/api/admin/bank', { method: 'PATCH', body: JSON.stringify({ bankName: $('#adminBankName').value, accountName: $('#adminAccountName').value, accountNumber: $('#adminAccountNumber').value, instructions: $('#adminInstructions').value }) });
  $('#adminMessage').textContent = 'Bank account saved.';
  await renderAdmin();
}
async function saveAiSettings(e) {
  e.preventDefault();
  const body = {
    LLM_PROVIDER: $('#aiProvider').value,
    LLM_MODEL: $('#aiModel').value,
    LLM_BASE_URL: $('#aiBaseUrl').value
  };
  if ($('#aiApiKey').value.trim()) body.LLM_API_KEY = $('#aiApiKey').value.trim();
  await api('/api/admin/ai-settings', { method: 'PATCH', body: JSON.stringify(body) });
  $('#aiMessage').className = 'message';
  $('#aiMessage').textContent = 'AI settings saved.';
  await renderAdmin();
}
async function testAiConnection() {
  const msg = $('#aiMessage');
  msg.className = 'message';
  msg.textContent = 'Testing AI provider...';
  try {
    const res = await api('/api/admin/ai-test', { method: 'POST', body: JSON.stringify({}) });
    msg.textContent = `AI connected: ${res.provider} / ${res.model}. Reply: ${res.reply || 'ok'}`;
    await renderAdmin();
  } catch (err) {
    msg.className = 'message error';
    msg.textContent = err.message;
    await renderAdmin();
  }
}
async function boot() {
  renderNav();
  if (!uid()) return;
  $('#authShell').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  await loadAll();
  setView('home');
}
document.addEventListener('click', e => {
  const jump = e.target.closest('[data-view], [data-view-jump]');
  if (jump) { e.preventDefault(); setView(jump.dataset.view || jump.dataset.viewJump); }
  const open = e.target.closest('[data-open-clip]');
  if (open) { state.clip = state.library.clips.find(c => c.id === open.dataset.openClip); setView('clipDetail'); }
  const copy = e.target.closest('[data-copy]');
  if (copy) navigator.clipboard?.writeText(decodeURIComponent(copy.dataset.copy));
  const approve = e.target.closest('[data-approve-payment]');
  if (approve) api('/api/admin/payments', { method: 'PATCH', body: JSON.stringify({ paymentId: approve.dataset.approvePayment, status: 'approved' }) }).then(loadAll).then(renderAdmin);
  const reject = e.target.closest('[data-reject-payment]');
  if (reject) api('/api/admin/payments', { method: 'PATCH', body: JSON.stringify({ paymentId: reject.dataset.rejectPayment, status: 'rejected' }) }).then(loadAll).then(renderAdmin);
  const retryJob = e.target.closest('[data-retry-job]');
  if (retryJob) api('/api/job', { method: 'PATCH', body: JSON.stringify({ jobId: retryJob.dataset.retryJob, action: 'retry' }) }).then(loadAll).then(() => setView('clips'));
  const deleteJob = e.target.closest('[data-delete-job]');
  if (deleteJob) api('/api/job', { method: 'PATCH', body: JSON.stringify({ jobId: deleteJob.dataset.deleteJob, action: 'delete' }) }).then(loadAll).then(() => setView('clips'));
});
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const path = state.authMode === 'signup' ? '/api/signup' : '/api/login';
    const res = await api(path, { method: 'POST', body: JSON.stringify({ email: $('#authEmail').value, password: $('#authPassword').value }) });
    localStorage.setItem('clipforge:userId', res.user.id);
    $('#authShell').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    await loadAll();
    setView('home');
  } catch (err) { $('#authMessage').className = 'message error'; $('#authMessage').textContent = err.message; }
});
$('#toggleAuth').addEventListener('click', () => {
  state.authMode = state.authMode === 'login' ? 'signup' : 'login';
  $('#authSubmit').textContent = state.authMode === 'login' ? 'Login' : 'Create account';
  $('#toggleAuth').textContent = state.authMode === 'login' ? 'Create account' : 'I already have an account';
});
$('#forgotPassword').addEventListener('click', () => { $('#authMessage').textContent = 'Password reset placeholder for MVP.'; });
boot();
