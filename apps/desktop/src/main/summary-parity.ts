/**
 * shared/ipc.ts 里 *Summary 类型与根仓库源类型的编译期 parity 断言。
 *
 * Summary 是手工拷贝(源模块带 node:fs/execa,进不了 renderer/main 两端共用
 * 的 shared),wire 这一侧原本没有任何防漂移机制——server 侧改个字段,GUI
 * 编译照过、运行时静默拿 undefined。本文件不被任何运行时代码 import(vite
 * 构建图看不见它),只靠 tsconfig.json include 的 src/main 进 typecheck;
 * 因此可以用相对路径直接 import type 根仓库带 node 依赖的模块,不必扩
 * @core 白名单。双向 `{} as` 赋值断言:任一方向字段名/可选性/类型漂移都
 * 当场报红。
 */

import type { SessionMeta } from '../../../../src/session/store.js';
import type { FileContent, FileReadFailure } from '../../../../src/app/workspace-read.js';
import type { GitOpFailure, GitOpResult } from '../../../../src/agent/workspace-write.js';
import type {
  FileDiff,
  FileDiffFailure,
  WorkspaceFileEntry,
  WorkspaceStatus,
} from '../../../../src/agent/workspace.js';
import type { ModelTestResult, ProviderModels } from '../../../../src/model/registry.js';
import type { ModelCapabilities } from '../../../../src/model/catalog.js';
import type {
  FileContentSummary,
  FileDiffFailure as FileDiffFailureSummary,
  FileDiffSummary,
  FileReadFailure as FileReadFailureSummary,
  GitOpFailure as GitOpFailureSummary,
  GitOpSummary,
  ModelCapabilitiesSummary,
  ModelTestSummary,
  ProviderModelsSummary,
  SessionMetaSummary,
  WorkspaceFileEntrySummary,
  WorkspaceStatusSummary,
} from '../shared/ipc.js';

/** 双向可赋值 = 结构等价(多余可选字段除外,见 ProviderModels 特例)。 */
type MutualAssert<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// ---- 严格双向等价的 8 组 ----
true satisfies MutualAssert<SessionMetaSummary, SessionMeta>;
true satisfies MutualAssert<FileContentSummary, FileContent>;
true satisfies MutualAssert<FileReadFailureSummary, FileReadFailure>;
true satisfies MutualAssert<GitOpSummary, GitOpResult>;
true satisfies MutualAssert<GitOpFailureSummary, GitOpFailure>;
true satisfies MutualAssert<WorkspaceFileEntrySummary, WorkspaceFileEntry>;
true satisfies MutualAssert<WorkspaceStatusSummary, WorkspaceStatus>;
true satisfies MutualAssert<FileDiffSummary, FileDiff>;
true satisfies MutualAssert<FileDiffFailureSummary, FileDiffFailure>;
true satisfies MutualAssert<ModelTestSummary, ModelTestResult>;
true satisfies MutualAssert<ModelCapabilitiesSummary, ModelCapabilities>;

// ---- 刻意宽化:ProviderModelsSummary.models[].thinks 是 GUI 侧拼接的展示
// 字段(renderer/utils/model-settings.ts),源头 ModelInfo 无此键。承重方向
// 是 server 值装进 wire 形状,只断言这一个方向。 ----
true satisfies [ProviderModels] extends [ProviderModelsSummary] ? true : never;

export {};
