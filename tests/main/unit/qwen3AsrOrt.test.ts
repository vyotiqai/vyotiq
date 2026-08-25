import { describe, expect, it, vi } from 'vitest'
import {
  buildQwen3AsrPrompt,
  computeQwenLogMel,
  pcm16kBase64ToFloat32,
  parseQwen3AsrOutput,
  transcribeQwen3AsrOnnxCore,
  type Qwen3AsrOnnxConfig,
  type Qwen3AsrRunners
} from '@main/dictation/qwen3AsrOrt'

const config: Qwen3AsrOnnxConfig = {
  encoder: { hidden_size: 4, output_dim: 4, num_mel_bins: 128, downsample_factor: 8 },
  decoder: { hidden_size: 4, vocab_size: 32, num_layers: 2, num_key_value_heads: 2, head_dim: 2, intermediate_size: 8 },
  mel: { sample_rate: 16000, n_fft: 400, hop_length: 160, n_mels: 128, fmin: 0, fmax: 8000 },
  special_tokens: {
    eos_token_ids: [8, 9],
    pad_token_id: 7,
    im_start_token_id: 1,
    im_end_token_id: 2,
    audio_start_token_id: 3,
    audio_end_token_id: 4,
    audio_pad_token_id: 5,
    asr_text_token_id: 6
  }
}

function logitsWithArgmax(vocab: number, id: number): Float32Array {
  const out = new Float32Array(vocab)
  out[id] = 1e9
  return out
}

function makeFakeRunners(asrTokenSequence: number[]): Qwen3AsrRunners {
  let step = 0
  const decodeMap: Record<number, string> = {
    14: 'language ',
    15: 'en',
    16: '<asr_text>',
    17: 'hello'
  }
  return {
    async encodeMel() {
      return new Float32Array(2 * config.encoder.output_dim) // N = 2 audio frames
    },
    async decoderInit(_ids, _audio, _offset) {
      return { logits: logitsWithArgmax(32, 14), pastKeys: { step: 0 }, pastValues: { step: 0 } }
    },
    async decoderStep() {
      const next = asrTokenSequence[step] ?? 8
      step++
      return {
        logits: logitsWithArgmax(32, next),
        pastKeys: { step },
        pastValues: { step }
      }
    },
    embed() {
      return new Float32Array(config.encoder.output_dim)
    },
    encodeText(text: string) {
      const map: Record<string, number[]> = {
        system: [10],
        user: [11],
        assistant: [12],
        '\n': [13]
      }
      return map[text] ?? []
    },
    decodeTokens(ids: number[]) {
      return ids.map((i) => decodeMap[i] ?? '').join('')
    }
  }
}

describe('qwen3AsrOrt core', () => {
  it('decodes base64 int16 PCM to float32 in [-1, 1]', () => {
    const buf = Buffer.alloc(4)
    buf.writeInt16LE(0, 0)
    buf.writeInt16LE(32767, 2)
    const f = pcm16kBase64ToFloat32(buf.toString('base64'))
    expect(f.length).toBe(2)
    expect(f[0]).toBeCloseTo(0, 5)
    expect(f[1]).toBeCloseTo(32767 / 32768, 7)
  })

  it('computes a finite log-mel spectrogram of shape [n_mels, T]', () => {
    const wav = new Float32Array(16000 * 2) // 2s @ 16k
    for (let i = 0; i < wav.length; i++) wav[i] = Math.sin(i / 20) * 0.3
    const mel = computeQwenLogMel(wav, config.mel)
    expect(mel.length).toBeGreaterThan(0)
    expect(mel.length % config.mel.n_mels).toBe(0)
    for (let i = 0; i < mel.length; i++) expect(Number.isFinite(mel[i])).toBe(true)
  })

  it('builds a prompt with N audio-pad slots and correct audio offset', () => {
    const runners = makeFakeRunners([])
    const { ids, audioOffset } = buildQwen3AsrPrompt(runners, config, 2)
    expect(ids[0]).toBe(config.special_tokens.im_start_token_id)
    expect(ids).toContain(config.special_tokens.audio_start_token_id)
    expect(ids).toContain(config.special_tokens.audio_end_token_id)
    const padCount = ids.filter((i) => i === config.special_tokens.audio_pad_token_id).length
    expect(padCount).toBe(2)
    expect(ids[audioOffset]).toBe(config.special_tokens.audio_pad_token_id)
  })

  it('runs the greedy KV-cache loop and strips the language tag', async () => {
    const runners = makeFakeRunners([15, 16, 17, 8])
    const result = await transcribeQwen3AsrOnnxCore({
      runners,
      config,
      pcm16k: Buffer.alloc(4).toString('base64')
    })
    expect(result.text).toBe('hello')
    expect(result.language).toBe('en')
    expect(result.raw).toBe('language en<asr_text>hello')
  })

  it('parses language/text from raw output', () => {
    expect(parseQwen3AsrOutput('language en<asr_text>hello world')).toEqual({
      language: 'en',
      text: 'hello world'
    })
    expect(parseQwen3AsrOutput('plain transcript')).toEqual({
      language: '',
      text: 'plain transcript'
    })
  })

  it('returns the config-missing / empty checks', async () => {
    const runners = makeFakeRunners([])
    await expect(
      transcribeQwen3AsrOnnxCore({ runners, config, pcm16k: '' })
    ).rejects.toThrow()
  })
})
