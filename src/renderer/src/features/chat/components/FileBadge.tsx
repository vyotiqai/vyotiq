import { memo } from 'react'
import { FileTypeIcon } from '@renderer/lib/fileIcons'

/**
 * File-type icon for tool cards / changes panels (Material Icon Theme).
 * Kept as `FileBadge` so existing call sites stay stable.
 */
export const FileBadge = memo(function FileBadge({
  path,
  className
}: {
  path: string
  className?: string
}) {
  return <FileTypeIcon path={path} size={14} className={className} />
})
