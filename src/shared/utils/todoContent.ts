/** True when todo_write tool output still marks a task as in progress. */
export function todoContentHasInProgress(content: string): boolean {
  return content.split('\n').some((line) => line.startsWith('[~] '))
}

/** Demote interrupted in-progress tasks so reload does not keep spinners alive. */
export function finalizeInterruptedTodoContent(content: string): string {
  if (!todoContentHasInProgress(content)) return content
  return content
    .split('\n')
    .map((line) => (line.startsWith('[~] ') ? `[-] ${line.slice(4)}` : line))
    .join('\n')
}
