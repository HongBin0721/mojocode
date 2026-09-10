/**
 * 把 tool_call / tool_result 钩子包到每个工具的 execute 外面。
 *
 * 包装发生在 **streamText 边界、每次开流现包**(Agent.stream 调用它),而不是
 * 工具创建时:tools 对象会被就地改键(MCP 连上后并入、skill 工具重建、
 * view_image 随 provider 切换增删),提前包好的副本看不见这些变化。每次
 * 开流只是几十个对象的浅拷贝,可以忽略。**两级快路径**:一个工具钩子都没
 * 有时 Agent 直接把原对象交给 SDK,连包都不包(调用方判定);包了之后每一
 * 侧再各自判一次——调用方只知道"有工具钩子",分不出是哪一侧,而只注册
 * tool_result 才是常态(LSP 就是),不判的话每次工具调用都要为空的
 * tool_call 处理器链走一遍 promise 加两次分配。
 *
 * 否决与错误的呈现和工具内部自己抛 Error 完全一样:抛出的 Error 由 SDK 转成
 * tool-error 部件,loop 发 tool-end(isError)让模型看到原因,整轮不终结。
 *
 * 已知限制:execute 返回 AsyncIterable(流式工具结果)时,钩子拿到的是
 * 迭代器本身而不是聚合结果。内置工具没有这种用法。
 */

import type { ToolSet } from 'ai';
import { errorMessage } from '../core/errors.js';
import type { HookAgentInfo, HookRegistry } from '../core/hooks.js';

type AnyTool = ToolSet[string];
type Execute = NonNullable<AnyTool['execute']>;

export function hookTools(tools: ToolSet, hooks: HookRegistry, info: HookAgentInfo): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = hookTool(name, tool, hooks, info);
  }
  return wrapped;
}

function hookTool(name: string, tool: AnyTool, hooks: HookRegistry, info: HookAgentInfo): AnyTool {
  const original = tool.execute as Execute | undefined;
  if (!original) return tool;

  const execute: Execute = async (input, options) => {
    const callId = options.toolCallId;
    if (hooks.has('tool_call')) {
      const veto = await hooks.toolCall({ callId, toolName: name, input, ...info });
      if (veto) throw new Error(veto.reason);
    }

    let output: unknown;
    let isError = false;
    try {
      output = await original(input, options);
    } catch (err) {
      output = err;
      isError = true;
    }

    if (!hooks.has('tool_result')) {
      if (isError) throw output;
      return output;
    }

    const originalText = isError ? errorMessage(output) : undefined;
    const rewritten = await hooks.toolResult({
      callId,
      toolName: name,
      input,
      output: isError ? originalText : output,
      isError,
      ...info,
    });
    if (isError) {
      // 改写了错误消息才换一个 Error;没改就原样抛,保住工具自己的 Error
      // 子类型(调用方可能 instanceof 它)。
      if (rewritten !== originalText) throw new Error(String(rewritten));
      throw output;
    }
    return rewritten;
  };

  return { ...tool, execute } as AnyTool;
}

