import { memo } from 'react'
import { cn } from '@renderer/lib/ui'
import { fileIconUrl, folderIconUrl } from './urls'

export type FileTypeIconProps = {
  path: string
  kind?: 'file' | 'folder'
  open?: boolean
  size?: number
  className?: string
}

/** Material Icon Theme icon for a file or folder path. */
export const FileTypeIcon = memo(function FileTypeIcon({
  path,
  kind = 'file',
  open = false,
  size = 14,
  className
}: FileTypeIconProps) {
  const src = kind === 'folder' ? folderIconUrl(path, open) : fileIconUrl(path)
  if (!src) return null

  return (
    <img
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={cn('shrink-0 object-contain', className)}
      style={{ width: size, height: size }}
      draggable={false}
    />
  )
})
