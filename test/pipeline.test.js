import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFullSeriesMoments,
  buildTargetDurations,
  chooseBestDownloadedMedia,
  fallbackMomentsForVideo,
  buildTranscriptReference,
  FINAL_AUDIO_MISSING,
  FINAL_AUDIO_SILENT,
  FINAL_AUDIO_VALID,
  isEffectivelySilent,
  momentsAreDiverse,
  overlapRatio,
  parseFrameRate,
  parseVolumeStats,
  postProcessMoments,
  SOURCE_AUDIO_EXTRACTION_FAILED,
  SOURCE_AUDIO_PRESENT,
  SOURCE_HAS_NO_AUDIO,
  upsertSeriesPlan,
  userCanAccessMedia,
} from '../server.js';

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
