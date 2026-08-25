/**
 * Curated local dictation catalog. Two backends:
 *  - `whisper`: ONNX weights run in-process via @huggingface/transformers.
 *  - `qwen3-asr`: served by an OpenAI-compatible local server (vLLM
 *    `vllm serve Qwen/Qwen3-ASR-…` or `qwen-asr-serve`). The app posts the
 *    recording to `<serverUrl>/audio/transcriptions`; nothing is downloaded
 *    by the app — the model lives on the user's GPU server.
 */

export const DICTATION_LOCAL_MODEL_IDS = [
  'whisper-tiny.en',
  'whisper-small.en',
  'qwen3-asr-0.6b',
  'qwen3-asr-1.7b',
  'qwen3-asr-onnx-0.6b',
  'qwen3-asr-onnx-1.7b'
] as const
export type DictationLocalModelId = (typeof DICTATION_LOCAL_MODEL_IDS)[number]

export type DictationLocalBackend = 'whisper' | 'qwen3-asr' | 'qwen3-asr-onnx'

export type DictationLocalCatalogEntry = {
  id: DictationLocalModelId
  backend: DictationLocalBackend
  hubRepo: string
  label: string
  language: string
  role: 'fast' | 'quality'
  roleLabel: string
  approxDownloadLabel: string
  ramHint: string
}

export const DICTATION_LOCAL_CATALOG: readonly DictationLocalCatalogEntry[] = [
  {
    id: 'whisper-tiny.en',
    backend: 'whisper',
    hubRepo: 'onnx-community/whisper-tiny.en',
    label: 'Whisper Tiny',
    language: 'English',
    role: 'fast',
    roleLabel: 'Fast',
    approxDownloadLabel: '~41 MB',
    ramHint: 'Lower RAM — prefer this under 8 GB'
  },
  {
    id: 'whisper-small.en',
    backend: 'whisper',
    hubRepo: 'onnx-community/whisper-small.en',
    label: 'Whisper Small',
    language: 'English',
    role: 'quality',
    roleLabel: 'Recommended',
    approxDownloadLabel: '~249 MB',
    ramHint: 'Better accuracy when you have 8 GB+ RAM'
  },
  {
    id: 'qwen3-asr-0.6b',
    backend: 'qwen3-asr',
    hubRepo: 'Qwen/Qwen3-ASR-0.6B',
    label: 'Qwen3-ASR 0.6B',
    language: 'Multilingual (52 langs + 22 dialects)',
    role: 'fast',
    roleLabel: 'Fast',
    approxDownloadLabel: 'Server-hosted',
    ramHint:
      'Served by a local vLLM / qwen-asr-serve GPU endpoint. Not downloaded by the app.'
  },
  {
    id: 'qwen3-asr-1.7b',
    backend: 'qwen3-asr',
    hubRepo: 'Qwen/Qwen3-ASR-1.7B',
    label: 'Qwen3-ASR 1.7B',
    language: 'Multilingual (52 langs + 22 dialects)',
    role: 'quality',
    roleLabel: 'Recommended',
    approxDownloadLabel: 'Server-hosted',
    ramHint:
      'Served by a local vLLM / qwen-asr-serve GPU endpoint. Best accuracy, heavier GPU.'
  },
  {
    id: 'qwen3-asr-onnx-0.6b',
    backend: 'qwen3-asr-onnx',
    hubRepo: 'andrewleech/qwen3-asr-0.6b-onnx',
    label: 'Qwen3-ASR 0.6B (on-device)',
    language: 'Multilingual (52 langs + 22 dialects)',
    role: 'fast',
    roleLabel: 'Fast',
    approxDownloadLabel: '~3.7 GB',
    ramHint:
      'Downloads community ONNX weights and runs on-device via ONNX Runtime. CPU works; GPU optional.'
  },
  {
    id: 'qwen3-asr-onnx-1.7b',
    backend: 'qwen3-asr-onnx',
    hubRepo: 'andrewleech/qwen3-asr-1.7b-onnx',
    label: 'Qwen3-ASR 1.7B (on-device)',
    language: 'Multilingual (52 langs + 22 dialects)',
    role: 'quality',
    roleLabel: 'Recommended',
    approxDownloadLabel: '~8.2 GB',
    ramHint:
      'Downloads community ONNX weights and runs on-device via ONNX Runtime. Best accuracy, heavier.'
  }
]

export function isQwen3AsrModelId(id: string): boolean {
  const entry = DICTATION_LOCAL_CATALOG.find((m) => m.id === id)
  return entry?.backend === 'qwen3-asr'
}

export function isQwen3AsrOnnxModelId(id: string): boolean {
  const entry = DICTATION_LOCAL_CATALOG.find((m) => m.id === id)
  return entry?.backend === 'qwen3-asr-onnx'
}

export function dictationCatalogEntry(
  id: DictationLocalModelId
): DictationLocalCatalogEntry {
  const entry = DICTATION_LOCAL_CATALOG.find((m) => m.id === id)
  if (!entry) throw new Error(`Unknown dictation model: ${id}`)
  return entry
}

/** RAM threshold for the Voice card hardware hint (not auto-install). */
export const DICTATION_SMALL_MODEL_MIN_BYTES = 8 * 1024 * 1024 * 1024
