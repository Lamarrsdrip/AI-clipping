/**
 * ai/providers/index.js
 * Central re-export of all AI provider helpers.
 * Import from here so server.js doesn't need per-file paths.
 */
export {
  GEMINI_COMPAT_BASE,
  GEMINI_FLASH,
  GEMINI_FLASH_THINK,
  GEMINI_PRO,
  geminiUploadFile,
  geminiDeleteFile,
  geminiGenerateWithFile,
  geminiGenerateText,
  geminiTranscribeFile,
} from './gemini.js';
