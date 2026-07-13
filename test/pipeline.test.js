import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  assessCaptionSync,
  buildASSFile,
  buildFullSeriesMoments,
  buildLogoOverlay,
  buildPortraitFilter,
  buildTargetDurations,
  cleanupClipAssets,
  cleanupResult,
  cleanupVideoAssets,
  chooseBestDownloadedMedia,
  chooseNaturalBoundary,
  clipCaptionWordsToRenderWindow,
  deoverlapCaptionSegments,
  estimateWordTimings,
  parseYouTubeJson3,
  isProxyReachable,
  fallbackMomentsForVideo,
  buildTranscriptReference,
  CAPTION_ALIGNMENT_LOW_CONFIDENCE,
  CAPTION_SYNC_OFFSET_DETECTED,
  CAPTION_SYNC_VALID,
  FINAL_AUDIO_MISSING,
  FINAL_AUDIO_SILENT,
  FINAL_AUDIO_VALID,
  isEffectivelySilent,
  minPartDuration,
  momentsAreDiverse,
  momentsFromPersistedSeriesPlan,
  overlapRatio,
  parseFrameRate,
  parseVolumeStats,
  postProcessMoments,
  resolveManagedDeletionPath,
  SOURCE_AUDIO_EXTRACTION_FAILED,
  SOURCE_AUDIO_PRESENT,
  SOURCE_HAS_NO_AUDIO,
  upsertSeriesPlan,
  userCanAccessMedia,
  validateSeriesPlan,
  WORD_TIMESTAMPS_MISSING,
} from '../server.js';

function assTimestampToSeconds(value) {
  const [h, m, s] = String(value).split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function parseAssEvents(ass) {
  return ass.split('\n')
    .filter(line => line.startsWith('Dialogue:'))
    .map(line => {
      const parts = line.split(',');
      return {
        start: assTimestampToSeconds(parts[1]),
        end: assTimestampToSeconds(parts[2]),
        text: parts.slice(9).join(','),
      };
    });
}

test('default long-video targets preserve 60, 90, and 120 second outputs', () => {
  assert.deepEqual(buildTargetDurations(900, 3, 60), [60, 90, 120]);
  assert.deepEqual(buildTargetDurations(900, 5, 90), [90, 90, 90, 90, 90]);
});

test('short sources do not force a fake one-minute clip', () => {
  assert.deepEqual(buildTargetDurations(30, 3, 60), [25, 25, 25]);
});

test('fallback moments use different timeline windows instead of overlapping duplicates', () => {
  const moments = fallbackMomentsForVideo(
    { title: 'Fallback audit', durationSeconds: 130, isShort: false },
    { targetDurations: [60, 90, 120] },
  );
  assert.equal(moments.length, 3);
  assert.ok(moments.every((m, i, arr) => arr.every((other, j) => i === j || overlapRatio(m, other) === 0)));
});

test('transcript reference samples the full timeline instead of only the beginning', () => {
  const segments = Array.from({ length: 120 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 4,
    text: i === 119 ? 'LATE_MARKER this important ending must survive condensation' : `segment ${i} useful words`,
  }));
  const ref = buildTranscriptReference(segments, 1600);
  assert.match(ref, /segment 0/);
  assert.match(ref, /LATE_MARKER/);
});

test('postProcessMoments rejects heavily overlapping AI clips and fills with diverse fallbacks', () => {
  const segments = Array.from({ length: 90 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 8,
    text: `Sentence ${i}.`,
  }));
  const rawItems = [
    { start: 10, end: 80, overallScore: 98, hooks: { curiosity: 'first' } },
    { start: 20, end: 85, overallScore: 97, hooks: { curiosity: 'duplicate overlap' } },
    { start: 260, end: 330, overallScore: 92, hooks: { curiosity: 'second' } },
  ];
  const fallbackMoments = [
    { start: 430, end: 490, score: 80, text: 'fallback third', hook: 'fallback third' },
  ];
  const moments = postProcessMoments(rawItems, {
    desiredCount: 3,
    desiredLength: 60,
    targetDurations: [60, 90, 120],
    framingMode: 'dynamic',
    videoDuration: 900,
    minGap: 90,
    fallbackMoments,
    segments,
    video: { title: 'Audit video' },
    options: {},
  });
  assert.equal(moments.length, 3);
  assert.ok(momentsAreDiverse(moments[0], moments[1], 90));
  assert.ok(moments.every((m, i, arr) => arr.every((other, j) => i === j || overlapRatio(m, other) <= 0.20)));
});

test('parseFrameRate handles ffprobe ratios without eval', () => {
  assert.equal(Math.round(parseFrameRate('30000/1001')), 30);
  assert.equal(parseFrameRate('not-js'), 0);
});

test('volumedetect parsing rejects digital silence around -91 dB', () => {
  const parsed = parseVolumeStats('mean_volume: -91.0 dB\nmax_volume: -91.0 dB');
  assert.equal(parsed.meanVolumeDb, -91);
  assert.equal(parsed.maxVolumeDb, -91);
  assert.equal(isEffectivelySilent(parsed.maxVolumeDb), true);
  assert.equal(isEffectivelySilent(-18.5), false);
});

test('audio state constants distinguish source and final failures', () => {
  assert.notEqual(SOURCE_AUDIO_EXTRACTION_FAILED, SOURCE_HAS_NO_AUDIO);
  assert.notEqual(SOURCE_AUDIO_PRESENT, SOURCE_HAS_NO_AUDIO);
  assert.notEqual(FINAL_AUDIO_VALID, FINAL_AUDIO_SILENT);
  assert.notEqual(FINAL_AUDIO_MISSING, FINAL_AUDIO_SILENT);
});

test('YouTube download selection prefers muxed media and otherwise pairs video-only with audio-only', () => {
  const muxedChoice = chooseBestDownloadedMedia([
    { path: '/tmp/video-720.mp4', hasVideo: true, hasAudio: true, height: 720, formatBitrate: 2_000_000, size: 20 },
    { path: '/tmp/video-1080.mp4', hasVideo: true, hasAudio: false, height: 1080, formatBitrate: 4_000_000, size: 40 },
    { path: '/tmp/audio.webm', hasVideo: false, hasAudio: true, audioBitrate: 128_000, size: 5 },
  ]);
  assert.equal(muxedChoice.muxed.path, '/tmp/video-720.mp4');

  const splitChoice = chooseBestDownloadedMedia([
    { path: '/tmp/video-720.mp4', hasVideo: true, hasAudio: false, height: 720, formatBitrate: 2_000_000, size: 20 },
    { path: '/tmp/video-1080.mp4', hasVideo: true, hasAudio: false, height: 1080, formatBitrate: 4_000_000, size: 40 },
    { path: '/tmp/audio-low.webm', hasVideo: false, hasAudio: true, audioBitrate: 64_000, size: 3 },
    { path: '/tmp/audio-high.webm', hasVideo: false, hasAudio: true, audioBitrate: 160_000, size: 6 },
  ]);
  assert.equal(splitChoice.muxed, null);
  assert.equal(splitChoice.videoOnly.path, '/tmp/video-1080.mp4');
  assert.equal(splitChoice.audioOnly.path, '/tmp/audio-high.webm');
});

test('full video series covers a 10-minute source with sequential numbered parts and no gaps', () => {
  const transcript = Array.from({ length: 40 }, (_, i) => ({
    start: i * 15,
    end: Math.min(600, i * 15 + 15),
    text: `Sentence ${i}.`,
  }));
  const parts = buildFullSeriesMoments(
    { id: 'video-series', title: 'Complete story', durationSeconds: 600 },
    transcript,
    { seriesId: 'series-1', partDuration: 120, boundaryAdjustmentSeconds: 15 },
  );
  assert.equal(parts.length, 5);
  assert.deepEqual(parts.map(p => p.partNumber), [1, 2, 3, 4, 5]);
  assert.ok(parts.every(p => p.totalParts === 5));
  assert.equal(parts[0].sourceStart, 0);
  assert.equal(parts.at(-1).sourceEnd, 600);
  for (let i = 1; i < parts.length; i += 1) {
    assert.equal(parts[i].sourceStart, parts[i - 1].sourceEnd);
    assert.equal(parts[i].start, parts[i].sourceStart);
  }
});

test('full video series uses natural boundaries within the configured adjustment window', () => {
  const transcript = [
    { start: 0, end: 92, text: 'First complete thought.' },
    { start: 92, end: 181, text: 'Second complete thought.' },
    { start: 181, end: 270, text: 'Third complete thought.' },
  ];
  const parts = buildFullSeriesMoments(
    { id: 'video-boundaries', title: 'Boundary story', durationSeconds: 270 },
    transcript,
    { seriesId: 'series-2', partDuration: 90, boundaryAdjustmentSeconds: 15 },
  );
  assert.equal(parts[0].sourceEnd, 92);
  assert.ok(Math.abs(parts[0].duration - 90) <= 15);
  assert.equal(parts[1].sourceStart, 92);
  assert.equal(parts[1].sourceEnd, 181);
  assert.ok(Math.abs(parts[1].duration - 90) <= 15);
});

test('series plan persists completed parts and retries only failed rows', () => {
  const db = { seriesJobs: [], seriesParts: [] };
  const parts = buildFullSeriesMoments(
    { id: 'video-retry', title: 'Retry story', durationSeconds: 360 },
    Array.from({ length: 12 }, (_, i) => ({ start: i * 30, end: i * 30 + 30, text: `Part text ${i}.` })),
    { seriesId: 'series-retry', partDuration: 120, boundaryAdjustmentSeconds: 10 },
  );
  upsertSeriesPlan(db, { seriesId: 'series-retry', jobId: 'job-1', videoId: 'video-retry', userId: 'u1', parts, targetPartDuration: 120 });
  db.seriesParts[0].status = 'complete';
  db.seriesParts[0].clipId = 'clip-1';
  db.seriesParts[1].status = 'failed';
  db.seriesParts[1].error = 'FINAL_AUDIO_SILENT';
  upsertSeriesPlan(db, { seriesId: 'series-retry', jobId: 'job-2', videoId: 'video-retry', userId: 'u1', parts, targetPartDuration: 120 });
  assert.equal(db.seriesParts.length, 3);
  assert.equal(db.seriesParts[0].status, 'complete');
  assert.equal(db.seriesParts[0].clipId, 'clip-1');
  assert.equal(db.seriesParts[1].status, 'failed');
  assert.equal(db.seriesParts[1].error, 'FINAL_AUDIO_SILENT');
  assert.equal(db.seriesParts[2].status, 'queued');
});

test('media access is scoped to owners and blocks originals by default', () => {
  const user = { id: 'u1', role: 'user' };
  const other = { id: 'u2', role: 'user' };
  const admin = { id: 'admin', role: 'admin' };
  const db = {
    videos: [{ id: 'v1', userId: 'u1', storagePath: '/tmp/upload-one.mp4', thumbnailUrl: '/media/thumbs/upload-one.jpg' }],
    clips: [{ id: 'clip1', userId: 'u1', videoId: 'v1' }],
    brandKits: [{ id: 'bk1', userId: 'u1', logoStoredName: 'logo-one.png' }],
    studioGenerations: [{ id: 'gen1', userId: 'u1', outputPath: '/media/generations/gen_gen1.mp4' }],
    audioGenerations: [{ id: 'aud1', userId: 'u1', outputPath: '/media/audio/tts_aud1.mp3' }],
  };
  assert.equal(userCanAccessMedia(user, 'clips/clip1.mp4', db), true);
  assert.equal(userCanAccessMedia(other, 'clips/clip1.mp4', db), false);
  assert.equal(userCanAccessMedia(user, 'uploads/upload-one.mp4', db), true);
  assert.equal(userCanAccessMedia(other, 'uploads/upload-one.mp4', db), false);
  assert.equal(userCanAccessMedia(user, 'logos/logo-one.png', db), true);
  assert.equal(userCanAccessMedia(other, 'logos/logo-one.png', db), false);
  assert.equal(userCanAccessMedia(user, 'originals/private-source.mp4', db), false);
  assert.equal(userCanAccessMedia(admin, 'originals/private-source.mp4', db), true);
});

test('storage cleanup path validation stays inside managed media roots', () => {
  const safe = resolveManagedDeletionPath('/media/clips/cleanup-safe.mp4');
  assert.ok(safe);
  assert.match(safe, /storage[\\/]clips[\\/]cleanup-safe\.mp4$/);
  assert.equal(resolveManagedDeletionPath('/media/../server.js'), null);
  assert.equal(resolveManagedDeletionPath('/etc/passwd'), null);
  assert.equal(resolveManagedDeletionPath('https://example.com/video.mp4'), null);
});

test('clip cleanup physically removes generated files and frees bytes', () => {
  const clipsDir = new URL('../storage/clips/', import.meta.url);
  const clipFile = new URL('../storage/clips/unit-cleanup-physical.mp4', import.meta.url);
  mkdirSync(clipsDir, { recursive: true });
  writeFileSync(clipFile, Buffer.alloc(4096, 7));
  const db = {
    clips: [{ id: 'unit-cleanup-physical', outputPath: '/media/clips/unit-cleanup-physical.mp4' }],
    scheduledPosts: [],
    seriesParts: [],
    seriesJobs: [],
    usageEvents: [],
  };
  try {
    const result = cleanupClipAssets(db, ['unit-cleanup-physical'], cleanupResult('unit-test', 'clip-delete'));
    assert.equal(existsSync(clipFile), false);
    assert.equal(result.filesDeleted, 1);
    assert.ok(result.bytesFreed >= 4096);
    assert.equal(db.clips.length, 0);
  } finally {
    if (existsSync(clipFile)) unlinkSync(clipFile);
  }
});

test('video cleanup refuses non-video storage roots', () => {
  const logosDir = new URL('../storage/logos/', import.meta.url);
  const logoFile = new URL('../storage/logos/unit-keep-logo.png', import.meta.url);
  mkdirSync(logosDir, { recursive: true });
  writeFileSync(logoFile, Buffer.from('keep-logo'));
  const db = {
    videos: [{
      id: 'video-bad-path-test',
      userId: 'u1',
      storagePath: '/media/logos/unit-keep-logo.png',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
    clips: [],
    jobs: [],
    transcriptions: [],
    scheduledPosts: [],
    seriesJobs: [],
    seriesParts: [],
    projects: [],
    imports: [],
    usageEvents: [],
  };
  try {
    const result = cleanupVideoAssets(db, ['video-bad-path-test'], cleanupResult('unit-test', 'video-delete'));
    assert.equal(result.videosDeleted, 1);
    assert.equal(existsSync(logoFile), true);
    assert.ok(result.skippedUnsafe.includes('/media/logos/unit-keep-logo.png'));
  } finally {
    if (existsSync(logoFile)) unlinkSync(logoFile);
  }
});

test('video asset cleanup removes video metadata without touching accounts or billing data', () => {
  const db = {
    users: [{ id: 'u1', email: 'owner@example.com' }],
    subscriptions: [{ id: 'sub1', userId: 'u1' }],
    paymentRequests: [{ id: 'pay1', userId: 'u1', status: 'approved' }],
    creditTransactions: [{ id: 'tx1', userId: 'u1', amount: 10 }],
    videos: [{
      id: 'video-cleanup-test',
      userId: 'u1',
      importId: 'import1',
      projectId: 'project1',
      youtubeId: 'yt-cleanup-test',
      storagePath: '/media/uploads/source-cleanup-test.mp4',
      thumbnailUrl: '/media/thumbs/source-cleanup-test.jpg',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
    clips: [{
      id: 'clip-cleanup-test',
      userId: 'u1',
      videoId: 'video-cleanup-test',
      outputPath: '/media/clips/clip-cleanup-test.mp4',
      thumbnailPath: '/media/thumbs/clip_clip-cleanup-test.jpg',
      thumbnailOptions: [{ path: '/media/thumbnails/thumb_clip-cleanup-test_viral.jpg' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
    jobs: [{ id: 'job1', videoId: 'video-cleanup-test', status: 'complete' }],
    transcriptions: [{ id: 'tr1', videoId: 'video-cleanup-test', segments: [] }],
    scheduledPosts: [{ id: 'post1', clipId: 'clip-cleanup-test' }],
    seriesJobs: [{ id: 'series1', videoId: 'video-cleanup-test' }],
    seriesParts: [{ id: 'part1', seriesId: 'series1', videoId: 'video-cleanup-test', clipId: 'clip-cleanup-test' }],
    projects: [{ id: 'project1', userId: 'u1' }],
    imports: [{ id: 'import1', userId: 'u1' }],
    usageEvents: [{ id: 'usage-video', videoId: 'video-cleanup-test' }, { id: 'usage-other', kind: 'login' }],
  };
  const result = cleanupVideoAssets(db, ['video-cleanup-test'], cleanupResult('unit-test', 'video-delete'));
  assert.equal(result.videosDeleted, 1);
  assert.equal(result.clipsDeleted, 1);
  assert.equal(db.videos.length, 0);
  assert.equal(db.clips.length, 0);
  assert.equal(db.jobs.length, 0);
  assert.equal(db.transcriptions.length, 0);
  assert.equal(db.scheduledPosts.length, 0);
  assert.equal(db.seriesJobs.length, 0);
  assert.equal(db.seriesParts.length, 0);
  assert.equal(db.projects.length, 0);
  assert.equal(db.imports.length, 0);
  assert.deepEqual(db.users, [{ id: 'u1', email: 'owner@example.com' }]);
  assert.deepEqual(db.subscriptions, [{ id: 'sub1', userId: 'u1' }]);
  assert.deepEqual(db.paymentRequests, [{ id: 'pay1', userId: 'u1', status: 'approved' }]);
  assert.deepEqual(db.creditTransactions, [{ id: 'tx1', userId: 'u1', amount: 10 }]);
  assert.deepEqual(db.usageEvents, [{ id: 'usage-other', kind: 'login' }]);
});

// ─── Caption timing fix: YouTube auto-caption overlap correction ──────────
test('deoverlapCaptionSegments removes YouTube rolling-caption overlap (real bug reproduction)', () => {
  // Actual data pattern captured from a real YouTube auto-caption (json3) export:
  // each event's reported end time bleeds into the next event's start, because
  // YouTube's rolling-caption display keeps the previous line visible while the
  // next one begins rendering. This is not real overlapping speech.
  const raw = [
    { start: 0.00, end: 4.88, text: "The older I get, the more I've realized" },
    { start: 2.48, end: 7.60, text: 'how much time I have to set aside' },
    { start: 4.88, end: 9.20, text: 'just to clean' },
  ];
  const fixed = deoverlapCaptionSegments(raw);
  for (let i = 0; i < fixed.length - 1; i++) {
    assert.ok(fixed[i].end <= fixed[i + 1].start, `segment ${i} must not overlap segment ${i + 1}`);
  }
  assert.equal(fixed[0].end, 2.48);
  assert.equal(fixed[1].end, 4.88);
  // Original start times and text are preserved -- only the inflated end is clipped.
  assert.equal(fixed[0].start, 0);
  assert.equal(fixed[0].text, raw[0].text);
});

test('deoverlapCaptionSegments is a no-op on already-clean, non-overlapping segments', () => {
  const clean = [
    { start: 0, end: 2, text: 'one' },
    { start: 2, end: 4, text: 'two' },
    { start: 4, end: 6, text: 'three' },
  ];
  const result = deoverlapCaptionSegments(clean);
  assert.deepEqual(result.map(s => [s.start, s.end]), clean.map(s => [s.start, s.end]));
});

test('deoverlapCaptionSegments sorts out-of-order input and drops empty/invalid entries', () => {
  const messy = [
    { start: 5, end: 6, text: 'later' },
    { start: 0, end: 3, text: 'first' },
    { start: 1, end: 2, text: '' },
    { start: NaN, end: 2, text: 'bad' },
  ];
  const result = deoverlapCaptionSegments(messy);
  assert.deepEqual(result.map(s => s.text), ['first', 'later']);
});

test('parseYouTubeJson3 preserves YouTube word offsets as source-global word timings', () => {
  const raw = {
    events: [
      { tStartMs: 2480, dDurationMs: 5120, segs: [
        { utf8: 'how' },
        { utf8: ' much', tOffsetMs: 120 },
        { utf8: ' time', tOffsetMs: 360 },
        { utf8: ' I', tOffsetMs: 680 },
        { utf8: ' have', tOffsetMs: 720 },
        { utf8: ' to', tOffsetMs: 840 },
        { utf8: ' set', tOffsetMs: 960 },
        { utf8: ' aside', tOffsetMs: 1120 },
      ] },
      { tStartMs: 4870, dDurationMs: 2730, segs: [{ utf8: '\n' }] },
      { tStartMs: 4880, dDurationMs: 4320, segs: [
        { utf8: 'just' },
        { utf8: ' to', tOffsetMs: 440 },
        { utf8: ' clean.', tOffsetMs: 560 },
      ] },
    ],
  };
  const parsed = parseYouTubeJson3(raw);
  assert.deepEqual(parsed.words.slice(0, 8).map(w => w.word), ['how', 'much', 'time', 'I', 'have', 'to', 'set', 'aside']);
  assert.equal(Number(parsed.words[0].sourceStart.toFixed(2)), 2.48);
  assert.equal(Number(parsed.words[1].sourceStart.toFixed(2)), 2.60);
  assert.equal(Number(parsed.words[2].sourceStart.toFixed(2)), 2.84);
  assert.equal(Number(parsed.words[7].sourceStart.toFixed(2)), 3.60);
  assert.ok(parsed.words[0].sourceEnd <= parsed.words[1].sourceStart);
  assert.ok(parsed.words.every(w => w.sourceEnd > w.sourceStart), 'every parsed word needs a real end time');
  assert.ok(parsed.words.every(w => w.timingSource.startsWith('youtube-json3')), 'word cache must record its timing source');
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].end, 4.88);
});

// ─── Word-level timing bounds (Priority 1 validation subset) ──────────────
test('estimateWordTimings never produces negative or out-of-clip timestamps', () => {
  const segments = [
    { start: -1, end: 3, text: 'hello there world' },
    { start: 3, end: 100, text: 'this segment runs way past the clip end' },
  ];
  const words = estimateWordTimings(segments, 0, 10);
  for (const w of words) {
    assert.ok(w.start >= 0, 'word start must not be negative');
    assert.ok(w.end <= 10, 'word end must not exceed clip duration');
    assert.ok(w.end > w.start, 'word end must be after word start');
  }
});

test('estimateWordTimings keeps words monotonic within a segment', () => {
  const segments = [{ start: 0, end: 4, text: 'one two three four' }];
  const words = estimateWordTimings(segments, 0, 4);
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].start >= words[i - 1].start, 'words must not go backwards in time');
  }
});

// ─── buildASSFile bounds (regression subset of the caption-sync validation spec) ──
test('buildASSFile never emits negative timestamps or timestamps beyond clip duration', () => {
  const words = [
    { word: 'hello', start: -0.5, end: 0.3 },
    { word: 'world', start: 0.3, end: 0.9 },
    { word: 'this',  start: 9.8,  end: 10.5 }, // extends past a 10s clip
  ];
  const ass = buildASSFile(words, 0, 10, 'bold');
  const events = parseAssEvents(ass);
  assert.ok(events.length > 0, 'expected at least one caption event');
  for (const event of events) {
    assert.ok(event.start >= 0, `caption start must not be negative (got ${event.start})`);
    assert.ok(event.end <= 10 + 0.05, `caption end must not exceed clip duration (got ${event.end})`);
    assert.ok(event.end > event.start, 'caption end must be after start');
  }
});

test('buildASSFile keeps caption events monotonic (no unexpected overlap)', () => {
  const words = [
    { word: 'a', start: 0,   end: 0.3 },
    { word: 'b', start: 0.3, end: 0.6 },
    { word: 'c', start: 0.6, end: 0.9 },
    { word: 'd', start: 2.0, end: 2.3 },
  ];
  const ass = buildASSFile(words, 0, 5, 'bold');
  const starts = parseAssEvents(ass).map(event => event.start);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] >= starts[i - 1], 'caption event start times must be monotonic');
  }
});

test('buildASSFile keeps a phrase visible until a long spoken word actually ends', () => {
  const words = [
    { word: 'alpha', start: 0.00, end: 0.30 },
    { word: 'stretch', start: 0.30, end: 1.35 },
    { word: 'omega', start: 1.36, end: 1.70 },
  ];
  const ass = buildASSFile(words, 0, 3, 'bold');
  const stretchEvent = parseAssEvents(ass).find(event => event.start >= 0.29 && event.start <= 0.31);
  assert.ok(stretchEvent, 'expected an event beginning at the real "stretch" word timestamp');
  assert.ok(stretchEvent.end >= 1.34, `caption must not disappear before the long word ends (got ${stretchEvent.end}s)`);
});

test('buildASSFile starts the phrase at the first word and lasts through the final word', () => {
  const words = [
    { word: 'cleaning', start: 5.20, end: 5.55 },
    { word: 'is', start: 5.56, end: 5.68 },
    { word: 'work', start: 5.70, end: 6.05 },
  ];
  const events = parseAssEvents(buildASSFile(words, 0, 8, 'bold'));
  assert.ok(events.length >= 3);
  assert.equal(events[0].start, 5.20);
  assert.ok(Math.max(...events.map(event => event.end)) >= 6.04, 'phrase must remain visible through the final word');
  assert.ok(Math.max(...events.map(event => event.end)) <= 6.14, 'readability tail should stay tiny');
});

test('buildASSFile readability tail never overlaps the next spoken phrase', () => {
  const words = [
    { word: 'hello', start: 0.00, end: 0.25 },
    { word: 'done.', start: 0.25, end: 1.00 },
    { word: 'next', start: 1.05, end: 1.30 },
    { word: 'thought', start: 1.30, end: 1.60 },
  ];
  const firstPhraseEvents = parseAssEvents(buildASSFile(words, 0, 3, 'bold'))
    .filter(event => event.start < 1.05);
  assert.ok(firstPhraseEvents.length >= 2);
  assert.ok(firstPhraseEvents.every(event => event.end <= 1.061), 'tail must be clipped at the next phrase start');
});

test('assessCaptionSync marks estimated timing as low-confidence instead of valid word alignment', () => {
  const result = assessCaptionSync([
    { word: 'estimated', start: 0.0, end: 0.4, timingSource: 'estimated-segment' },
    { word: 'words', start: 0.4, end: 0.8, timingSource: 'estimated-segment' },
  ], { outputDuration: 1 });
  assert.equal(result.status, CAPTION_ALIGNMENT_LOW_CONFIDENCE);
  assert.equal(result.valid, true);
  assert.equal(result.estimatedWordCount, 2);
});

test('assessCaptionSync accepts real word-level timing and rejects impossible offsets', () => {
  const valid = assessCaptionSync([
    { word: 'real', start: 0.0, end: 0.2, timingSource: 'youtube-json3-word-offset' },
    { word: 'timing', start: 0.2, end: 0.6, timingSource: 'youtube-json3-word-offset' },
  ], { outputDuration: 1 });
  assert.equal(valid.status, CAPTION_SYNC_VALID);
  assert.equal(valid.valid, true);

  const invalid = assessCaptionSync([
    { word: 'bad', start: -0.4, end: 0.2, timingSource: 'youtube-json3-word-offset' },
  ], { outputDuration: 1 });
  assert.equal(invalid.status, CAPTION_SYNC_OFFSET_DETECTED);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.fatal, true);
});

test('caption render-window clipping prevents tiny boundary overlaps from failing a valid 90s render', () => {
  const words = clipCaptionWordsToRenderWindow([
    { word: 'almost', start: 89.50, end: 89.84, timingSource: 'youtube-json3-word-offset' },
    { word: 'but', start: 89.84, end: 90.16, timingSource: 'youtube-json3-word-offset' },
    { word: 'outside', start: 90.20, end: 90.50, timingSource: 'youtube-json3-word-offset' },
  ], 90);
  assert.deepEqual(words.map(w => w.word), ['almost', 'but']);
  assert.equal(words[1].end, 90);
  assert.equal(words[1].originalRenderEnd, 90.16);
  assert.equal(words[1].clippedToRenderWindow, true);

  const result = assessCaptionSync(words, { outputDuration: 90 });
  assert.equal(result.status, CAPTION_SYNC_VALID);
  assert.equal(result.valid, true);
});

test('assessCaptionSync records missing word timestamps without pretending alignment exists', () => {
  const result = assessCaptionSync([], { outputDuration: 1 });
  assert.equal(result.status, WORD_TIMESTAMPS_MISSING);
  assert.equal(result.confidence, 'missing');
});

// ─── Framing: no-face-detected default should not waste ~37% of frame on blur ──
test('buildPortraitFilter keeps the wider safe crop when no face is detected', () => {
  // A tighter 0.42 default was tried here to reduce blur padding on single-character
  // cartoon shots, but a live production re-render showed it cropping real content
  // in scenes this function can't tell apart from that case without actual
  // content-bounds detection: on-screen text/title cards clipped at both edges,
  // and multi-character scenes with one character cut off at the frame edge.
  // Reverted to 0.50 -- losing real content is worse than extra blur padding.
  const srcW = 1920, srcH = 1080, outW = 1080, outH = 1920;
  const result = buildPortraitFilter(srcW, srcH, outW, outH, 'center', 30, null, 'dynamic');
  const expectedCropW = Math.max(2, Math.round(Math.min(srcW, 0.50 * srcW) / 2) * 2);
  assert.equal(result.cropW, expectedCropW);
});

// ─── Watermark position: @handles must not sit in the bottom caption safe zone ──
test('buildLogoOverlay positions @handle text watermarks top-right, not bottom-right', () => {
  const brandKit = { watermarkEnabled: true, textWatermark: '@emriz.eth' };
  const overlay = buildLogoOverlay(brandKit, 1080, 1920, null);
  assert.ok(overlay, 'expected a watermark overlay to be produced');
  assert.equal(overlay.detectedPos, 'top-right');
  assert.ok(!overlay.filterFrag.includes('H-th-380'), 'must not use the bottom safe-zone y-offset');
});

// ─── Residential proxy tunnel fallback ─────────────────────────────────────
test('isProxyReachable resolves false quickly when nothing is listening', async () => {
  // Port 1 is a reserved/privileged port nothing will ever be listening on in a
  // test environment -- a safe, deterministic "definitely not connected" case.
  const start = Date.now();
  const reachable = await isProxyReachable('127.0.0.1', 1, 500);
  const elapsed = Date.now() - start;
  assert.equal(reachable, false);
  assert.ok(elapsed < 2000, `should fail fast, not hang (took ${elapsed}ms)`);
});

test('isProxyReachable resolves true when something is actually listening', async () => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const reachable = await isProxyReachable('127.0.0.1', port, 500);
    assert.equal(reachable, true);
  } finally {
    server.close();
  }
});

/* ── Full Series repair regression tests ─────────────────────────── */

test('minPartDuration never drops below the 30s hard floor regardless of target/adjustment', () => {
  assert.equal(minPartDuration(30, 15), 30);
  assert.equal(minPartDuration(10, 20), 30);
  assert.ok(minPartDuration(60, 15) >= 30 && minPartDuration(60, 15) <= 60);
  assert.ok(minPartDuration(90, 15) >= 30 && minPartDuration(90, 15) <= 60);
});

test('chooseNaturalBoundary never returns a boundary closer than the minimum duration from cursor', () => {
  const boundaries = [40, 300]; // a boundary candidate sits well inside the forbidden zone
  const { time } = chooseNaturalBoundary(0, 90, 600, boundaries, 15, 60);
  assert.ok(time >= 60, `boundary ${time} must respect the 60s floor, not snap to the 40s candidate`);
});

test('full video series never produces a part below the minimum duration except a merged final remainder', () => {
  const transcript = Array.from({ length: 80 }, (_, i) => ({ start: i * 8, end: i * 8 + 8, text: `Beat ${i}.` }));
  const parts = buildFullSeriesMoments(
    { id: 'video-min-dur', title: 'Minimum duration audit', durationSeconds: 605 },
    transcript,
    { seriesId: 'series-min-dur', partDuration: 90, boundaryAdjustmentSeconds: 15 },
  );
  const minDuration = minPartDuration(90, 15);
  parts.forEach((p, i) => {
    if (i === parts.length - 1) return; // only the final part may be short
    assert.ok(p.duration >= minDuration, `part ${p.partNumber} duration ${p.duration} below minimum ${minDuration}`);
  });
});

test('a tiny trailing remainder is merged into the previous part instead of becoming its own sub-minimum part', () => {
  // 601s source at a 120s target leaves a ~1s remainder after 5 full parts — must merge, not spawn Part 6.
  const transcript = [{ start: 0, end: 601, text: 'One long continuous scene.' }];
  const parts = buildFullSeriesMoments(
    { id: 'video-remainder', title: 'Remainder audit', durationSeconds: 601 },
    transcript,
    { seriesId: 'series-remainder', partDuration: 120, boundaryAdjustmentSeconds: 15 },
  );
  assert.equal(parts.at(-1).sourceEnd, 601);
  assert.ok(parts.at(-1).mergedFinal || parts.at(-1).duration >= minPartDuration(120, 15));
  assert.ok(parts.every(p => p.duration >= 30), 'no part should ever be a stray few-second clip');
});

test('validateSeriesPlan accepts a chronologically continuous plan that reaches the source end', () => {
  const parts = buildFullSeriesMoments(
    { id: 'video-valid', title: 'Valid plan', durationSeconds: 400 },
    Array.from({ length: 30 }, (_, i) => ({ start: i * 13.3, end: i * 13.3 + 13.3, text: `Line ${i}.` })),
    { seriesId: 'series-valid', partDuration: 100, boundaryAdjustmentSeconds: 15 },
  );
  const result = validateSeriesPlan(parts, 0, 400, minPartDuration(100, 15));
  assert.equal(result.valid, true);
  assert.equal(result.status, 'SERIES_PLAN_VALID');
  assert.equal(result.issues.length, 0);
});

test('validateSeriesPlan rejects a plan with a timeline gap', () => {
  const parts = [
    { partNumber: 1, sourceStart: 0, sourceEnd: 90, duration: 90 },
    { partNumber: 2, sourceStart: 95, sourceEnd: 180, duration: 85 }, // 5s gap
  ];
  const result = validateSeriesPlan(parts, 0, 180, 30);
  assert.equal(result.valid, false);
  assert.equal(result.status, 'SERIES_GAP_DETECTED');
  assert.ok(result.issues.some(i => i.includes('SERIES_GAP_DETECTED')));
});

test('validateSeriesPlan rejects a plan with unintended overlap', () => {
  const parts = [
    { partNumber: 1, sourceStart: 0, sourceEnd: 90, duration: 90 },
    { partNumber: 2, sourceStart: 80, sourceEnd: 180, duration: 100 }, // 10s overlap
  ];
  const result = validateSeriesPlan(parts, 0, 180, 30);
  assert.equal(result.valid, false);
  assert.equal(result.status, 'SERIES_OVERLAP_DETECTED');
});

test('validateSeriesPlan rejects duplicate and out-of-order part numbers', () => {
  const parts = [
    { partNumber: 1, sourceStart: 0, sourceEnd: 90, duration: 90 },
    { partNumber: 1, sourceStart: 90, sourceEnd: 180, duration: 90 },
  ];
  const result = validateSeriesPlan(parts, 0, 180, 30);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.includes('Duplicate partNumber')));
});

test('validateSeriesPlan rejects a plan that does not reach the source end', () => {
  const parts = [
    { partNumber: 1, sourceStart: 0, sourceEnd: 90, duration: 90 },
    { partNumber: 2, sourceStart: 90, sourceEnd: 150, duration: 60 },
  ];
  const result = validateSeriesPlan(parts, 0, 200, 30); // source is 200s but plan stops at 150
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(i => i.includes('not source end')));
});

test('momentsFromPersistedSeriesPlan reproduces the exact committed boundaries — a retry can never drift', () => {
  const originalTranscript = Array.from({ length: 40 }, (_, i) => ({ start: i * 15, end: i * 15 + 15, text: `Original ${i}.` }));
  const originalParts = buildFullSeriesMoments(
    { id: 'video-drift', title: 'Drift audit', durationSeconds: 600 },
    originalTranscript,
    { seriesId: 'series-drift', partDuration: 120, boundaryAdjustmentSeconds: 15 },
  );
  const db = { seriesJobs: [], seriesParts: [] };
  upsertSeriesPlan(db, { seriesId: 'series-drift', jobId: 'job-1', videoId: 'video-drift', userId: 'u1', parts: originalParts, targetPartDuration: 120 });

  // Simulate a re-transcription on retry that would, on its own, produce different natural
  // boundaries (different sentence lengths / different candidate boundary set entirely).
  const differentTranscript = Array.from({ length: 12 }, (_, i) => ({ start: i * 50, end: i * 50 + 50, text: `Reworded ${i}.` }));
  const rebuilt = momentsFromPersistedSeriesPlan(db.seriesParts, { id: 'video-drift', title: 'Drift audit' }, differentTranscript);

  assert.equal(rebuilt.length, originalParts.length);
  rebuilt.forEach((part, i) => {
    assert.equal(part.sourceStart, originalParts[i].sourceStart, `part ${i + 1} sourceStart drifted on retry`);
    assert.equal(part.sourceEnd, originalParts[i].sourceEnd, `part ${i + 1} sourceEnd drifted on retry`);
  });
  // Continuity must still hold on the reconstructed plan.
  for (let i = 1; i < rebuilt.length; i += 1) {
    assert.equal(rebuilt[i].sourceStart, rebuilt[i - 1].sourceEnd);
  }
});
