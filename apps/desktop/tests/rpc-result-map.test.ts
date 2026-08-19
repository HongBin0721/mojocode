/**
 * RpcResultMap 与 RemoteSession(根仓库)实际返回类型的编译期契约测试。
 * bridge.dispatchRpc 是 Promise<unknown> 的 switch,类型系统关联不到 kind,
 * 所以在这里逐个断言「RemoteSession 方法的 resolve 值可赋给映射声明的响应
 * 类型」——server 侧改返回形状,这个文件在 typecheck(tests/*.ts 属主
 * tsconfig 项目)当场红。运行时部分只有一个平凡断言,让 vitest 收编此文件。
 */

import { describe, expect, it } from 'vitest';
import type { RemoteSession } from '@core/remote';
import type { RpcKind, RpcRequest, RpcResult, RpcResultMap } from '../src/shared/ipc.js';
import type {
  GitOpSummary,
  ModelTestSummary,
  ProviderModelsSummary,
  ReviewTargetsSummary,
  SessionMetaSummary,
  WorkspaceStatusSummary,
} from '../src/shared/ipc.js';

type Resolved<T> = Awaited<T>;
type Assert<A extends B, B> = A;

// ---- 服务端实际返回 → wire 契约声明的响应类型(承重方向) ----
type _workspaceStatus = Assert<
  Resolved<ReturnType<RemoteSession['workspaceStatus']>>,
  RpcResultMap['workspaceStatus']
>;
type _fileDiff = Assert<Resolved<ReturnType<RemoteSession['fileDiff']>>, RpcResultMap['fileDiff']>;
type _archive = Assert<
  Resolved<ReturnType<RemoteSession['archiveSession']>>,
  RpcResultMap['archiveSession']
>;
type _rename = Assert<
  Resolved<ReturnType<RemoteSession['renameSession']>>,
  RpcResultMap['renameSession']
>;
type _listFiles = Assert<
  Resolved<ReturnType<RemoteSession['listFiles']>>,
  RpcResultMap['listFiles']
>;
type _readFile = Assert<Resolved<ReturnType<RemoteSession['readFile']>>, RpcResultMap['readFile']>;
type _switchBranch = Assert<
  Resolved<ReturnType<RemoteSession['switchBranch']>>,
  RpcResultMap['switchBranch']
>;
type _commitAll = Assert<
  Resolved<ReturnType<RemoteSession['commitAll']>>,
  RpcResultMap['commitAll']
>;
type _undoCommit = Assert<
  Resolved<ReturnType<RemoteSession['undoCommit']>>,
  RpcResultMap['undoCommit']
>;
type _discardAll = Assert<
  Resolved<ReturnType<RemoteSession['discardAll']>>,
  RpcResultMap['discardAll']
>;
type _listProviderModels = Assert<
  Resolved<ReturnType<RemoteSession['listProviderModels']>>,
  RpcResultMap['listProviderModels']
>;
type _testModel = Assert<
  Resolved<ReturnType<RemoteSession['testModel']>>,
  RpcResultMap['testModel']
>;
type _modelCapabilities = Assert<
  Resolved<ReturnType<RemoteSession['modelCapabilities']>>,
  RpcResultMap['modelCapabilities']
>;
type _reviewTargets = Assert<
  Resolved<ReturnType<RemoteSession['reviewTargets']>>,
  RpcResultMap['reviewTargets']
>;

// ---- RpcResult<K> 的推导抽查(编译期) ----
type _r1 = Assert<RpcResult<'workspaceStatus'>, WorkspaceStatusSummary>;
type _r2 = Assert<RpcResult<'commitAll'>, GitOpSummary>;
type _r3 = Assert<RpcResult<'archiveSession'>, SessionMetaSummary>;
type _r4 = Assert<RpcResult<'testModel'>, ModelTestSummary>;
type _r5 = Assert<RpcResult<'reviewTargets'>, ReviewTargetsSummary>;
type _r6 = Assert<RpcResult<'listProviderModels'>, ProviderModelsSummary[]>;
type _r7 = Assert<RpcResult<'permission'>, boolean>;

// ---- 完整性:RpcRequest 的每个 kind 都在映射里(漏写在此处红) ----
type _complete = Assert<RpcKind, keyof RpcResultMap>;
type _noExtra = Assert<keyof RpcResultMap, RpcKind>;

// 类型别名要有一个运行时锚点,vitest 才收编此文件(也压住 noUnusedLocals 之外
// 的「仅类型文件」争议)。
describe('RpcResultMap', () => {
  it('契约由编译期断言看护(见上方类型)', () => {
    const probe: RpcRequest = { kind: 'workspaceStatus' };
    expect(probe.kind).toBe('workspaceStatus');
  });
});
