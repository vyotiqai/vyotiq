import type { AttachedAudio, AttachedFile, AttachedNativeFile } from '@shared/ipc'
import { FileChip, ImageChip } from '@renderer/lib/ui'

export function ComposerAttachments({
  images,
  imageError,
  files = [],
  nativeFiles = [],
  audio = [],
  fileError = null,
  audioError = null,
  extracting = false,
  attachLocked,
  onRemove,
  onRemoveFile,
  onRemoveNativeFile,
  onRemoveAudio
}: {
  images: string[]
  imageError: string | null
  files?: AttachedFile[]
  nativeFiles?: AttachedNativeFile[]
  audio?: AttachedAudio[]
  fileError?: string | null
  audioError?: string | null
  extracting?: boolean
  attachLocked: boolean
  onRemove: (index: number) => void
  onRemoveFile?: (index: number) => void
  onRemoveNativeFile?: (index: number) => void
  onRemoveAudio?: (index: number) => void
}) {
  const notice = [imageError, fileError, audioError].filter(Boolean).join(' · ')
  const hasChips = images.length || files.length || nativeFiles.length || audio.length
  if (!hasChips && !notice && !extracting) return null

  return (
    <div className="col-span-full flex flex-col gap-1.5">
      {hasChips ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {images.map((url, i) => (
            <ImageChip
              key={`${i}-${url.slice(0, 24)}`}
              url={url}
              label={`Image ${i + 1}`}
              variant="compact"
              disabled={attachLocked}
              onRemove={() => onRemove(i)}
            />
          ))}
          {files.map((file, i) => (
            <FileChip
              key={`${i}-${file.name}`}
              name={file.name}
              chars={file.text.length}
              disabled={attachLocked}
              onRemove={onRemoveFile ? () => onRemoveFile(i) : undefined}
            />
          ))}
          {nativeFiles.map((file, i) => (
            <FileChip
              key={`native-${i}-${file.name}`}
              name={file.name}
              chars={Math.ceil((file.data.length * 3) / 4)}
              disabled={attachLocked}
              onRemove={onRemoveNativeFile ? () => onRemoveNativeFile(i) : undefined}
            />
          ))}
          {audio.map((clip, i) => (
            <FileChip
              key={`audio-${i}`}
              name={clip.mime || 'audio'}
              chars={Math.ceil((clip.url.length * 3) / 4)}
              disabled={attachLocked}
              onRemove={onRemoveAudio ? () => onRemoveAudio(i) : undefined}
            />
          ))}
        </div>
      ) : null}
      {extracting ? (
        <p className="m-0 text-xs text-secondary" role="status">
          Reading attachment…
        </p>
      ) : null}
      {notice ? (
        <p className="m-0 text-xs text-danger" role="alert">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
