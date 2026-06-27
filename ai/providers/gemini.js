/**
 * ai/providers/gemini.js
 *
 * Google Gemini provider for ClipForge AI.
 *
 * Text tasks  → OpenAI-compatible REST endpoint
 * Video/audio → Native Gemini File API via @google/generative-ai SDK
 *
 * Free-tier model priority (set GEMINI_MODEL env to override):
 *   gemini-2.5-flash-lite  → most available on new API keys (default)
 *   gemini-2.5-flash       → fallback #1
 *   gemini-1.5-flash       → fallback #2
 *   gemini-1.5-flash-8b    → last resort (smallest quota bucket)
 */

// ─── OpenAI-compatible config ─────────────────────────────────────────────────
export const GEMINI_COMPAT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

// Model cascade — tried in order when a 429 quota error is hit
export const GEMINI_MODEL_CASCADE = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];

// Primary export used by server.js (kept for backwards compat)
export const GEMINI_FLASH = GEMINI_MODEL_CASCADE[0];

// Named tiers
export const GEMINI_FLASH_THINK = 'gemini-2.5-flash';
export const GEMINI_PRO         = 'gemini-2.5-pro';

// ─── 429 quota error parsing ──────────────────────────────────────────────────
export function parseGemini429(err) {
  const msg = String(err?.message || err || '');
  if (!msg.includes('429') && !msg.includes('quota')) return null;

  // Extract retry delay — e.g. "retryDelay":"21s" or "Please retry in 21.3s"
  let retryMs = 30_000; // default 30s
  const delayMatch = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ||
                     msg.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (delayMatch) retryMs = Math.ceil(parseFloat(delayMatch[1])) * 1000 + 2000; // +2s buffer

  // Extract which model hit the quota
  const modelMatch = msg.match(/"model"\s*:\s*"([^"]+)"/);
  const model = modelMatch?.[1] || 'unknown';

  return { isQuota: true, retryMs, model, raw: msg.slice(0, 600) };
}

// ─── Gemini generate with automatic model fallback ───────────────────────────
/**
 * Try each model in the cascade until one succeeds or all fail with 429.
 * `startModel` is tried first; remaining cascade models follow if it gets 429.
 */
async function generateWithFallback(genAI, startModel, buildRequest, logPrefix = '') {
  const cascade = startModel
    ? [startModel, ...GEMINI_MODEL_CASCADE.filter(m => m !== startModel)]
    : GEMINI_MODEL_CASCADE;

  let lastErr;
  for (const model of cascade) {
    try {
      const genModel = genAI.getGenerativeModel(buildRequest(model));
      const result = await genModel.generateContent(buildRequest(model).__prompt);
      const meta = result.response.usageMetadata || {};
      return {
        text: result.response.text(),
        model,
        usage: {
          prompt_tokens:     meta.promptTokenCount     || 0,
          completion_tokens: meta.candidatesTokenCount || 0,
          total_tokens:      meta.totalTokenCount      || 0,
        },
      };
    } catch (err) {
      const q429 = parseGemini429(err);
      if (q429) {
        console.warn(`[Gemini] ${logPrefix} quota exceeded on ${model} (retry in ${q429.retryMs}ms) — trying next model`);
        lastErr = err;
        // Short wait before trying next model (avoid hammering the API)
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw err; // Non-quota errors are fatal
    }
  }
  // All models exhausted
  const q = parseGemini429(lastErr);
  const friendly = `Gemini quota exceeded on all models (${cascade.join(', ')}). ` +
    `Retry after ${Math.ceil((q?.retryMs || 30000) / 1000)}s or add LLM_API_KEY as fallback.`;
  throw Object.assign(new Error(friendly), { isGeminiQuota: true, retryMs: q?.retryMs || 30000 });
}

// ─── File API ────────────────────────────────────────────────────────────────
export async function geminiUploadFile(apiKey, filePath, mimeType = 'video/mp4') {
  const { GoogleAIFileManager, FileState } = await import('@google/generative-ai/server');
  const { basename } = await import('path');

  const mgr = new GoogleAIFileManager(apiKey);
  const upload = await mgr.uploadFile(filePath, { mimeType, displayName: basename(filePath) });

  let file = await mgr.getFile(upload.file.name);
  let tries = 0;
  while (file.state === FileState.PROCESSING && tries < 90) {
    await new Promise(r => setTimeout(r, 4000));
    file = await mgr.getFile(upload.file.name);
    tries++;
  }
  if (file.state === 'FAILED') throw new Error(`Gemini File API processing failed: ${file.name}`);
  return { uri: file.uri, mimeType: file.mimeType, name: file.name };
}

export async function geminiDeleteFile(apiKey, fileName) {
  try {
    const { GoogleAIFileManager } = await import('@google/generative-ai/server');
    await new GoogleAIFileManager(apiKey).deleteFile(fileName);
  } catch { /* best effort */ }
}

// ─── Video analysis with model cascade ───────────────────────────────────────
export async function geminiGenerateWithFile({ apiKey, fileUri, mimeType = 'video/mp4', prompt, model, temperature = 0.3 }) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);

  const startModel = model || GEMINI_MODEL_CASCADE[0];
  const cascade = [startModel, ...GEMINI_MODEL_CASCADE.filter(m => m !== startModel)];

  let lastErr;
  for (const m of cascade) {
    try {
      const genModel = genAI.getGenerativeModel({
        model: m,
        generationConfig: { temperature, responseMimeType: 'application/json' },
      });
      const result = await genModel.generateContent([
        { fileData: { mimeType, fileUri } },
        prompt,
      ]);
      const meta = result.response.usageMetadata || {};
      console.log(`[Gemini] video analysis success — model: ${m}`);
      return {
        text: result.response.text(),
        model: m,
        usage: {
          prompt_tokens:     meta.promptTokenCount     || 0,
          completion_tokens: meta.candidatesTokenCount || 0,
          total_tokens:      meta.totalTokenCount      || 0,
        },
      };
    } catch (err) {
      const q429 = parseGemini429(err);
      if (q429) {
        console.warn(`[Gemini] video analysis quota exceeded on ${m} — trying next model`);
        lastErr = err;
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
  const q = parseGemini429(lastErr);
  throw Object.assign(new Error(`Gemini quota exceeded on all models. Retry after ${Math.ceil((q?.retryMs || 30000) / 1000)}s.`), { isGeminiQuota: true, retryMs: q?.retryMs || 30000 });
}

// ─── Text generation with model cascade ──────────────────────────────────────
export async function geminiGenerateText({ apiKey, prompt, systemPrompt = '', model, temperature = 0.4 }) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);

  const startModel = model || GEMINI_MODEL_CASCADE[0];
  const cascade = [startModel, ...GEMINI_MODEL_CASCADE.filter(m => m !== startModel)];

  let lastErr;
  for (const m of cascade) {
    try {
      const genModel = genAI.getGenerativeModel({
        model: m,
        systemInstruction: systemPrompt || undefined,
        generationConfig: { temperature, responseMimeType: 'application/json' },
      });
      const result = await genModel.generateContent(prompt);
      const meta = result.response.usageMetadata || {};
      console.log(`[Gemini] text generation success — model: ${m}`);
      return {
        text: result.response.text(),
        model: m,
        usage: {
          prompt_tokens:     meta.promptTokenCount     || 0,
          completion_tokens: meta.candidatesTokenCount || 0,
          total_tokens:      meta.totalTokenCount      || 0,
        },
      };
    } catch (err) {
      const q429 = parseGemini429(err);
      if (q429) {
        console.warn(`[Gemini] text quota exceeded on ${m} (retry: ${q429.retryMs}ms) — trying next`);
        lastErr = err;
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
  const q = parseGemini429(lastErr);
  throw Object.assign(new Error(`Gemini quota exceeded. Retry after ${Math.ceil((q?.retryMs || 30000) / 1000)}s.`), { isGeminiQuota: true, retryMs: q?.retryMs || 30000 });
}

// ─── Transcription fallback ───────────────────────────────────────────────────
export async function geminiTranscribeFile(apiKey, filePath, mimeType = 'audio/mpeg', model) {
  const { uri, name } = await geminiUploadFile(apiKey, filePath, mimeType);
  try {
    const { text } = await geminiGenerateWithFile({
      apiKey, fileUri: uri, mimeType,
      model: model || GEMINI_MODEL_CASCADE[0],
      temperature: 0,
      prompt: 'Transcribe this audio/video verbatim. Output plain text only, no timestamps, no labels.',
    });
    return text;
  } finally {
    geminiDeleteFile(apiKey, name);
  }
}
