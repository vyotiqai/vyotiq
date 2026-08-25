import { totalmem } from 'os'
import {
  DICTATION_LOCAL_CATALOG,
  DICTATION_SMALL_MODEL_MIN_BYTES,
  type DictationLocalModelId
} from '../../shared/dictation'

export {
  DICTATION_LOCAL_CATALOG,
  DICTATION_LOCAL_MODEL_IDS,
  dictationCatalogEntry,
  type DictationLocalCatalogEntry,
  type DictationLocalModelId
} from '../../shared/dictation'

/** Hardware hint only — never auto-install. */
export function recommendedDictationModelId(
  totalBytes: number = totalmem()
): DictationLocalModelId {
  return totalBytes < DICTATION_SMALL_MODEL_MIN_BYTES ? 'whisper-tiny.en' : 'whisper-small.en'
}

export const DICTATION_WHISPER_REQUIRED_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
] as const

export const DICTATION_WHISPER_OPTIONAL_FILES = ['generation_config.json'] as const

/**
 * Community ONNX export files for the in-app Qwen3-ASR engine
 * (e.g. andrewleech/qwen3-asr-0.6b-onnx). The `.onnx` graphs + embeddings +
 * config + tokenizer are required; the external-data sidecars are optional so
 * a differently-packaged export still installs (the loader fails clearly if a
 * needed sidecar is absent at load time).
 */
export const DICTATION_QWEN_ONNX_REQUIRED_FILES = [
  'encoder.onnx',
  'decoder_init.onnx',
  'decoder_step.onnx',
  'embed_tokens.bin',
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json'
] as const

export const DICTATION_QWEN_ONNX_OPTIONAL_FILES = [
  'decoder_init.onnx.data',
  'decoder_step.onnx.data',
  'decoder_weights.data',
  'preprocessor_config.json',
  'generation_config.json'
] as const
