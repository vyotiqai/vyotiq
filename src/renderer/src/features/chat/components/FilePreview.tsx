import { MarkdownContent } from '@renderer/lib/ui'
import {
  filePreviewKind,
  previewSourceUrl,
  type FilePreviewKind
} from './filePreviewKind'

export function FilePreview({
  path,
  content,
  binary
}: {
  path: string
  content: string
  binary: boolean
}) {
  const kind = filePreviewKind(path)
  if (!kind) return null

  if (kind === 'markdown') {
    return (
      <div
        className="min-h-0 flex-1 overflow-auto px-4 py-3"
        data-file-preview="markdown"
      >
        <MarkdownContent content={content} readOnlyTasks className="text-sm" />
      </div>
    )
  }

  if (kind === 'html') {
    return (
      <iframe
        title={`Preview ${path}`}
        sandbox=""
        srcDoc={content}
        className="min-h-0 w-full flex-1 border-0 bg-white"
        data-file-preview="html"
      />
    )
  }

  const src = previewSourceUrl(kind, path, content, binary)
  if (!src) return null
  return (
    <div
      className="grid min-h-0 flex-1 place-items-center overflow-auto bg-bg p-4"
      data-file-preview={kind}
    >
      <img src={src} alt={path} className="max-h-full max-w-full object-contain" />
    </div>
  )
}

export type { FilePreviewKind }
