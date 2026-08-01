import { tool } from 'ai';
import { z } from 'zod';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * 模型用来跟进多步骤工作的草稿板。列表保存在内存中,并同步镜像到 UI
 * 底栏——这正是它的主要价值:用户可以看到 agent 自认为正在做什么。
 */
export class TodoStore {
  private items: TodoItem[] = [];
  private listeners = new Set<(items: TodoItem[]) => void>();

  get(): TodoItem[] {
    return this.items;
  }

  set(items: TodoItem[]): void {
    this.items = items;
    for (const listener of this.listeners) listener(items);
  }

  subscribe(listener: (items: TodoItem[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createTodoTool(store: TodoStore) {
  return tool({
    description:
      'Record and update your task list for multi-step work. Call it when you plan the work and ' +
      'again each time a task changes state. Keep exactly one task in_progress at a time. ' +
      'Skip it for single-step requests.',
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().min(1).describe('Imperative description of the task.'),
            status: z.enum(['pending', 'in_progress', 'completed']),
          }),
        )
        .describe('The full list, not a delta — it replaces the previous list.'),
    }),
    execute: async ({ todos }) => {
      store.set(todos);
      const done = todos.filter((t) => t.status === 'completed').length;
      return { ok: true, total: todos.length, completed: done };
    },
  });
}
