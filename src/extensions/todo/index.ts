/**
 * `todo` 扩展:模型跟进多步骤工作的草稿板。
 *
 * 这是第一个把**结构化状态**推给客户端的扩展(`api.setState`):清单本身
 * 不只是给模型看的,更是给用户看的——TUI 的 ctrl+t 面板与底栏摘要、GUI 右上角
 * 的进度浮层画的都是这一份当前状态。核心因此不再有 `TodoStore`、
 * `Session.todos`、`StateSnapshot.todos`、`SessionState.todos`;客户端从
 * `extensionState[TODO_STATE_KEY]` 读,渲染组件仍是各自的(它们按 key 或
 * 按工具名认,不需要核心懂 todo)。
 *
 * 持久化走 custom 记录:`/resume` 回来清单还在(面板要能立刻显示 agent 上次
 * 干到哪),分叉也跟着带走。**已知的一次性行为**:本版之前创建的会话,清单
 * 存在旧的 `SessionState.todos` 字段里,恢复时读不回来——面板从空开始,模型
 * 下次规划时重新写满。清单是每轮重写的草稿,不值得为它留一条迁移路径。
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { Extension, ExtensionAPI } from '../../core/extension.js';
import { TODO_STATE_KEY } from '../../core/extension-types.js';
import { parseTodos, type TodoItem } from '../../ui/timeline-data.js';

export type { TodoItem };

/** 客户端按这个 key 从 `extensionState` 取清单。 */
export { TODO_STATE_KEY } from '../../core/extension-types.js';
/** 会话记录里的 custom 记录 type(与 state key 同名,取最后一条)。 */
export const TODO_ENTRY = 'todo';

const TOOL_NAME = 'todo';

export const todoExtension: Extension = {
  id: 'todo',
  setup(api: ExtensionAPI): void {
    /** 最后一次落盘的清单(序列化后比对);未落过盘时为 undefined。 */
    let persisted: string | undefined;
    const publish = (next: TodoItem[], options?: { persist?: boolean }): void => {
      // 空清单也照发:`/new` 之后面板必须立刻空掉,而不是留着上一段对话的进度。
      api.setState(TODO_STATE_KEY, next);
      if (options?.persist === false) {
        // 恢复出来的那份就是盘上的最后一条,记下来,免得第一次真改动之前
        // 先把它原样再追加一遍。
        persisted = JSON.stringify(next);
        return;
      }
      // 清单是**每轮重写**的:模型每次规划都把整份发回来,其中大量是原样
      // 重发或只翻了一个状态位。原来的落点是会话的 `state` 记录,
      // 它对内容相同提前返回;custom 记录没有这道闸,不补上就是每次 todo
      // 调用一条 JSONL 追加 + 一次 flush,而 `/fork` 还要把这些记录逐条重放
      // 进新文件——只为重建一份清单。
      const encoded = JSON.stringify(next);
      if (encoded === persisted) return;
      persisted = encoded;
      void api.appendEntry(TODO_ENTRY, next).catch(() => {});
    };

    api.on('session_start', () => {
      // 记录属于**新**会话,恢复出来的东西不能再写回去(那只是把同一份清单
      // 又追加一遍),所以 persist: false。
      const last = api.entries(TODO_ENTRY).at(-1);
      publish(parseTodos(last?.data) ?? [], { persist: false });
    });

    api.registerTool(TOOL_NAME, (scope) => {
      // 子 agent 不给:它有自己的任务,而这份清单是主对话的进度面板——原来
      // 由 bootstrap 的 subagentTools 显式剔除 todo,规则跟着工具搬了过来。
      if (scope.subagent) return undefined;
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
          publish(todos);
          const done = todos.filter((t) => t.status === 'completed').length;
          return { ok: true, total: todos.length, completed: done };
        },
      });
    });
  },
};
