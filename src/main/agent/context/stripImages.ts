import type { ChatMessage, ModelInfo } from '../../../shared/ipc'
import { providerContentParts, type ProviderWireCaps } from '../../../shared/ipc'

const OMIT_IMAGE = '[image omitted: model does not support vision]'

export function wireCapsFromModel(model: ModelInfo): ProviderWireCaps {
  const mods = model.inputModalities ?? []
  return {
    image: Boolean(model.supportsVision || mods.includes('image')),
    audio: mods.includes('audio'),
    fileNative: mods.includes('file')
  }
}

/** Replace unsupported multimodal parts with text markers before send/estimate. */
export function stripUnsupportedModalitiesFromMessages(
  messages: ChatMessage[],
  caps: ProviderWireCaps
): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return m
    const hasRich = m.content.some(
      (p) =>
        p.type === 'image_url' ||
        p.type === 'audio' ||
        p.type === 'file_native' ||
        p.type === 'file'
    )
    if (!hasRich) return m
    const parts = providerContentParts(m.content, caps)
    if (parts.every((p) => p.type === 'text')) {
      return {
        ...m,
        content: parts
          .map((p) => (p.type === 'text' ? p.text : ''))
          .filter(Boolean)
          .join('\n')
      }
    }
    return { ...m, content: parts }
  })
}

/** Replace image parts with a text marker so non-vision models do not reject the request. */
export function stripImagesFromMessages(messages: ChatMessage[]): ChatMessage[] {
  return stripUnsupportedModalitiesFromMessages(messages, {
    image: false,
    audio: true,
    fileNative: true
  }).map((m) => {
    if (typeof m.content !== 'string') return m
    // Preserve legacy omission wording when only images were stripped via image:false
    // and content collapsed to a single string that already includes the new marker.
    if (m.content.includes('[image omitted: model does not support vision]')) return m
    if (m.content === OMIT_IMAGE) return m
    return m
  })
}
