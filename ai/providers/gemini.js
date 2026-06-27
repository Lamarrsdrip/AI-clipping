/**
 * ai/providers/gemini.js
 *
 * Google Gemini provider for ClipForge AI.
 *
 * Text tasks  → OpenAI-compatible REST endpoint (no extra SDK required at runtime,
 *               works with the existing aiChat() fetch machinery in server.js)
 * Video/audio → Native Gemini File API via @google/generative-ai SDK
 *
 * Free tier (as of 2025-06): 15 RPM · 1,500 req/day · 1 M tokens/min
 * Files API:  2 GB storage · 48 h TTL per file
 */

// ─── OpenAI-compatible config ─────────────────────────────────────────────────
// Drop this URL into LLM_BASE_URL to route existing aiChat() calls through Gemini.
export const GEMINI_COMPAT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

// Model tiers
export const GEMINI_FLASH  = 'gemini-2.0-flash';       // fast, free — default for all tasks
export const GEMINI_FLASH_THINK = 'gemini-2.5-flash';  // best free reasoning model
export const GEMINI_PRO    = 'gemini-2.5-pro';          // paid — best overall

// ─── Native SDK helpers (video/audio analysis) ────────────────────────────────

/**
 * Upload a local file to the Gemini File API and wait until it is ACTIVE.
 * Returns { uri, mimeType, name } so the caller can reference it in generateContent().
 * The caller is responsible for deleting the file when done.
 */
export async function geminiUploadFile(apiKey, filePath, mimeType = 'video/mp4') {
  const { GoogleAIFileManager, FileState } = await import('@google/generative-ai/server');
  const { basename } = await import('path');

  const mgr = new GoogleAIFileManager(apiKey);
  const upload = await mgr.uploadFile(filePath, { mimeType, displayName: basename(filePath) });

  // Poll until ACTIVE (processing can take 10-60 s for large videos)
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

/**
 * Delete a file from the Gemini File API (best-effort, for privacy cleanup).
 */
export async function geminiDeleteFile(apiKey, fileName) {
  try {
    const { GoogleAIFileManager } = await import('@google/generative-ai/server');
    await new GoogleAIFileManager(apiKey).deleteFile(fileName);
  } catch { /* best effort */ }
}

/**
 * Send a prompt + an already-uploaded file to Gemini and return the raw text response.
 * Returns a JSON string when the model is configured with responseMimeType='application/json'.
 */
export async function geminiGenerateWithFile({ apiKey, fileUri, mimeType = 'video/mp4', prompt, model = GEMINI_FLASH, temperature = 0.3 }) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);

  const genModel = genAI.getGenerativeModel({
    model,
    generationConfig: { temperature, responseMimeType: 'application/json' },
  });

  const result = await genModel.generateContent([
    { fileData: { mimeType, fileUri } },
    prompt,
  ]);

  const meta = result.response.usageMetadata || {};
  return {
    text: result.response.text(),
    usage: {
      prompt_tokens:      meta.promptTokenCount     || 0,
      completion_tokens:  meta.candidatesTokenCount || 0,
      total_tokens:       meta.totalTokenCount      || 0,
    },
  };
}

/**
 * Plain Gemini text generation via native SDK (no file attachment).
 * Used when the caller wants JSON-mode without going through the OpenAI-compat layer.
 */
export async function geminiGenerateText({ apiKey, prompt, systemPrompt = '', model = GEMINI_FLASH, temperature = 0.4 }) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);

  const genModel = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt || undefined,
    generationConfig: { temperature, responseMimeType: 'application/json' },
  });

  const result = await genModel.generateContent(prompt);
  const meta = result.response.usageMetadata || {};
  return {
    text: result.response.text(),
    usage: {
      prompt_tokens:      meta.promptTokenCount     || 0,
      completion_tokens:  meta.candidatesTokenCount || 0,
      total_tokens:       meta.totalTokenCount      || 0,
    },
  };
}

/**
 * Transcribe an audio/video file via Gemini.
 * Returns plain text transcript — no word-level timestamps.
 * Use Whisper for caption sync; use this only as a last resort.
 */
export async function geminiTranscribeFile(apiKey, filePath, mimeType = 'audio/mpeg') {
  const { uri, name } = await geminiUploadFile(apiKey, filePath, mimeType);

  try {
    const { text } = await geminiGenerateWithFile({
      apiKey, fileUri: uri, mimeType,
      model: GEMINI_FLASH,
      temperature: 0,
      prompt: 'Transcribe this audio/video verbatim. Include every word as spoken. ' +
              'Output format: plain text only, no markdown, no timestamps, no labels.',
    });
    return text;
  } finally {
    await geminiDeleteFile(apiKey, name);
  }
}
