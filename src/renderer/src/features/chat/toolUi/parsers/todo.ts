import type { UiToolRow } from '@shared/transcript'

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TodoItem = {
  status: TodoStatus
  content: string
}

export type TodoParsed = {
  done: number
  total: number
  items: TodoItem[]
}

const STATUS_MAP: Record<string, TodoStatus> = {
  '[ ]': 'pending',
  '[~]': 'in_progress',
  '[x]': 'completed',
  '[-]': 'cancelled'
}

export function parseTodoData(tool: UiToolRow): TodoParsed {
  const content = tool.content ?? ''
  const lines = content.split('\n').filter(Boolean)
  const progressMatch = lines[0]?.match(/^(\d+)\/(\d+)\s+complete/)
  const done = progressMatch ? Number(progressMatch[1]) : 0
  const total = progressMatch ? Number(progressMatch[2]) : 0

  const items: TodoItem[] = []
  for (const line of lines.slice(1)) {
    const match = line.match(/^(\[[ x~-]\])\s+(.+)$/)
    if (!match) continue
    const status = STATUS_MAP[match[1]!] ?? 'pending'
    items.push({ status, content: match[2]! })
  }

  return { done, total, items }
}
