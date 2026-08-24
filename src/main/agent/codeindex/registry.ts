/**
 * Registry of locally-runnable neural dense ONNX embedders.
 *
 * Shared by the main-process loader (mdenseon.ts) and the embed utility process
 * (embedUtility.ts) so both resolve the same artifacts, dimensions, and load
 * strategy. `loader: 'lighton'` uses transformers.js `AutoModel`
 * (architecture-registered); `loader: 'generic'` loads any self-contained ONNX
 * graph directly via ORT (used for LFM2's custom architecture).
 */
import type { DownloadFileSpec } from './modelDownload'
import { denseOnOnnxFiles, mDenseOnOnnxFiles, lfm2OnnxFiles } from './modelDownload'
import {
  DENSEON_ONNX_MODEL_ID,
  LFM2_EMBEDDING_DIM,
  LFM2_EMBEDDING_MODEL_ID,
  LIGHTON_DENSE_DIM,
  MDENSEON_MODEL_ID
} from './types'

export type NeuralArtifactLoader = 'lighton' | 'generic'

export type NeuralArtifact = {
  artifactId: string
  modelId: string
  dimensions: number
  files: DownloadFileSpec[]
  /** May we auto-download from the hub? LFM2 is user-exported, so false. */
  allowAutoDownload: boolean
  loader: NeuralArtifactLoader
}

export const NEURAL_ARTIFACTS: NeuralArtifact[] = [
  {
    artifactId: 'mDenseOn-onnx-int8',
    modelId: MDENSEON_MODEL_ID,
    dimensions: LIGHTON_DENSE_DIM,
    files: mDenseOnOnnxFiles(),
    allowAutoDownload: false,
    loader: 'lighton'
  },
  {
    artifactId: 'DenseOn-onnx-int8',
    modelId: DENSEON_ONNX_MODEL_ID,
    dimensions: LIGHTON_DENSE_DIM,
    files: denseOnOnnxFiles(),
    allowAutoDownload: true,
    loader: 'lighton'
  },
  {
    artifactId: 'lfm2-embedding-onnx',
    modelId: LFM2_EMBEDDING_MODEL_ID,
    dimensions: LFM2_EMBEDDING_DIM,
    files: lfm2OnnxFiles(),
    // No public ONNX for the embedding variant — the user exports it locally
    // (scripts/export-lfm2-embedding-onnx.py). Never fetched from a hub.
    allowAutoDownload: false,
    loader: 'generic'
  }
]

export function getNeuralArtifact(modelId: string): NeuralArtifact | undefined {
  return NEURAL_ARTIFACTS.find((a) => a.modelId === modelId)
}
