import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { atomicWriteJson } from '@main/storage/atomicWrite'

export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
export type TodoStatus = z.infer<typeof TodoStatusSchema>

export const TodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: TodoStatusSchema
})
export type TodoItem = z.infer<typeof TodoItemSchema>

const TodoFileSchema = z.object({
  updatedAt: z.string(),
  todos: z.array(TodoItemSchema)
})

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  cancelled: '[-]'
}

function todoPath(runDir: string): string {
  return join(runDir, 'todos.json')
}

export function readTodos(runDir: string): TodoItem[] {
  const path = todoPath(runDir)
  if (!existsSync(path)) return []
  try {
    const parsed = TodoFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data.todos : []
  } catch {
    return []
  }
}

function serializeTodoContent(todos: TodoItem[]): string {
  const done = todos.filter((todo) => todo.status === 'completed').length
  const lines = todos.map((todo) => `${STATUS_MARK[todo.status]} ${todo.content}`)
  return [`${done}/${todos.length} complete`, ...lines].join('\n')
}

/** Cancel in-progress tasks left open when a run is interrupted. */
export function finalizeInterruptedTodos(runDir: string): string | null {
  return finalizeTodosOnRunEnd(runDir, 'cancelled')
}

/**
 * Close in-progress todos when a run reaches a terminal status.
 * - done / error: demote in_progress → pending (work may resume on a follow-up)
 * - cancelled: demote in_progress → cancelled (interrupt / orphan path)
 */
export function finalizeTodosOnRunEnd(
  runDir: string,
  outcome: 'done' | 'error' | 'cancelled'
): string | null {
  const todos = readTodos(runDir)
  if (!todos.some((todo) => todo.status === 'in_progress')) return null
  const nextStatus: TodoStatus = outcome === 'cancelled' ? 'cancelled' : 'pending'
  const next = todos.map((todo) =>
    todo.status === 'in_progress' ? { ...todo, status: nextStatus } : todo
  )
  atomicWriteJson(todoPath(runDir), { updatedAt: new Date().toISOString(), todos: next })
  return serializeTodoContent(next)
}

/**
 * Replace or merge the run's task list.
 *
 * The list lives in the run directory rather than the message history so it
 * stays the same size no matter how many times the model rewrites it, and it
 * survives a reload of the transcript.
 */
export function toolTodoWrite(
  runDir: string,
  todos: TodoItem[],
  merge = false
): { content: string; todos: TodoItem[] } {
  if (!runDir) throw new Error('todo_write is only available inside a run')

  let next: TodoItem[]
  if (merge) {
    const byId = new Map(readTodos(runDir).map((todo) => [todo.id, todo]))
    for (const todo of todos) byId.set(todo.id, { ...byId.get(todo.id), ...todo })
    next = [...byId.values()]
  } else {
    next = todos
  }

  const inProgressIndexes: number[] = []
  for (let i = 0; i < next.length; i++) {
    if (next[i]!.status === 'in_progress') inProgressIndexes.push(i)
  }
  let coerceNotice: string | undefined
  if (inProgressIndexes.length > 1) {
    const keepIdx = inProgressIndexes[inProgressIndexes.length - 1]!
    const demoted: string[] = []
    next = next.map((todo, i) => {
      if (todo.status === 'in_progress' && i !== keepIdx) {
        demoted.push(todo.id)
        return { ...todo, status: 'pending' as const }
      }
      return todo
    })
    coerceNotice = `Note: only one task may be in_progress; demoted ${demoted.join(', ')} to pending (kept ${next[keepIdx]!.id}).`
  }

  atomicWriteJson(todoPath(runDir), { updatedAt: new Date().toISOString(), todos: next })

  const content = serializeTodoContent(next)
  return {
    content: coerceNotice ? `${coerceNotice}\n${content}` : content,
    todos: next
  }
}
