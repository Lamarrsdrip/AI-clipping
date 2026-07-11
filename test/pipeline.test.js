import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTargetDurations,
  fallbackMomentsForVideo,
  buildTranscriptReference,
  momentsAreDiverse,
  overlapRatio,
  parseFrameRate,
  postProcessMoments,
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
