/**
 * `mojocode/extension`:给扩展作者的类型与少量运行时入口。
 *
 *   import type { ExtensionAPI, ExtensionComponent } from 'mojocode/extension';
 *   import { selectList, textInput, normalizeShortcut } from 'mojocode/extension';
 *
 * 只 re-export 扩展面(core/extension.ts、core/hooks.ts 的类型、core/extension-types.ts
 * 的纯数据类型与 normalizeShortcut、ui-kit 的两个组件工厂),不暴露 Session /
 * Agent 本体——扩展与宿主的接触面就是 ExtensionAPI 那一个对象。
 */

export type * from './core/extension.js';
export type {
  HookMap,
  HookName,
  HookAgentInfo,
  ToolCallHookInput,
  ToolCallHookResult,
  ToolResultHookInput,
  ToolResultHookResult,
  ToolExecutionStartHookInput,
  ToolExecutionUpdateHookInput,
  ToolExecutionEndHookInput,
  BeforeAgentStartHookInput,
  BeforeAgentStartHookResult,
  InputHookInput,
  InputHookResult,
  ContextHookInput,
  ContextHookResult,
  MessageEndHookInput,
  MessageEndHookResult,
  BeforeProviderRequestHookInput,
  BeforeProviderRequestHookResult,
  AfterProviderResponseHookInput,
  ProviderRequestParams,
  SessionBeforeCompactHookInput,
  SessionBeforeCompactHookResult,
  SessionCompactHookInput,
  SessionBeforeSwitchHookInput,
  SessionCancelHookResult,
  ResourcesDiscoverHookResult,
  ModelSelectHookInput,
  ThinkingLevelSelectHookInput,
  TurnStartHookInput,
  TurnEndHookInput,
  TurnOutcome,
  AgentStartHookInput,
  AgentEndHookInput,
  SessionStartHookInput,
  SessionStartReason,
} from './core/hooks.js';
export type {
  ExtensionShortcutInfo,
  UiCustomRequest,
  UiSurfaces,
  UiHost,
} from './core/extension-types.js';
export type { AgentEvent, UsageSnapshot, ContextUsage } from './core/events.js';
export type { Config, ReasoningEffort } from './config/schema.js';
export type { SessionCustomRecord } from './session/store.js';
export type { ImageAttachment } from './app/attachments.js';
export { ExtensionEvents } from './core/extension.js';
export { normalizeShortcut } from './core/extension-types.js';
export { selectList, textInput } from './core/ui-kit.js';
