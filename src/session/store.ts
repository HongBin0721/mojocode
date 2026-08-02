import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { sessionsDir } from '../config/paths.js';
import type { ApprovalPolicy, SandboxMode } from '../config/schema.js';
import type { TodoItem } from '../tools/todo.js';

export interface SessionMeta {
  id: string;
  root: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** 第一条用户消息,用作 `mojocode --resume` 中的标签。 */
  title: string;
  messageCount: number;
}

/** 消息之外需要跨会话恢复的东西:todos、会话级授权规则、两轴权限。 */
export interface SessionState {
  todos: TodoItem[];
  /** 原始规则串,如 `Bash(npm test:*)`、`Mcp(name)`。 */
  allowBash: string[];
  allowWrite: string[];
  sandbox?: SandboxMode;
  approval?: ApprovalPolicy;
  /** 旧版单轴字段。只在恢复旧会话文件时读取,转换见 resume.ts,不再写入。 */
  permissionMode?: string;
  /**
   * 未完成的目标(`/goal`)。只存条件本身:轮数、计时与 token 基线都是
   * "这一次监管"的统计,换个时间接着干本来就该从头算。恢复回来的目标是
   * 「已设定但不自动开跑」——打开一个旧会话不该凭空烧掉一轮 token。
   */
  goal?: { condition: string };
}

const EMPTY_STATE: SessionState = { todos: [], allowBash: [], allowWrite: [] };

interface MetaRecord {
  kind: 'meta';
  meta: SessionMeta;
}

/** 旧格式:全量快照。只读兼容——open() 把它当 snapshot 处理,新代码不再写。 */
interface MessagesRecord {
  kind: 'messages';
  at: string;
  messages: ModelMessage[];
}

/** 增量:只包含上次保存之后新增的消息。 */
interface AppendRecord {
  kind: 'append';
  at: string;
  messages: ModelMessage[];
}

/** 全量替换:压缩或 rewind 让历史不再是旧历史的扩展时写入。 */
interface SnapshotRecord {
  kind: 'snapshot';
  at: string;
  messages: ModelMessage[];
}

interface StateRecord {
  kind: 'state';
  at: string;
  state: SessionState;
}

type Record_ = MetaRecord | MessagesRecord | AppendRecord | SnapshotRecord | StateRecord;

/** `open()`/`resolveId()` 找不到会话。消息保持英文(CLI 层负责本地化呈现)。 */
export class SessionNotFoundError extends Error {
  constructor(readonly query: string) {
    super(`No session matches "${query}".`);
    this.name = 'SessionNotFoundError';
  }
}

/** 前缀命中多个会话。`matches` 是完整 id 列表,供调用方展示。 */
export class AmbiguousSessionError extends Error {
  constructor(
    readonly query: string,
    readonly matches: string[],
  ) {
    super(`Session id "${query}" is ambiguous: ${matches.join(', ')}`);
    this.name = 'AmbiguousSessionError';
  }
}

/**
 * 每个会话一个只追加的 JSONL 文件。
 *
 * 这里写入的是完整的、*未压缩的*历史。压缩只缩减发给模型的内容——磁盘上
 * 的记录保持完整,这样 `--resume` 和事后调试能看到实际发生的一切。
 *
 * 写入策略:正常轮次只追加 `append` 增量记录(文件随消息数线性增长);
 * 压缩或 rewind 把历史换成非扩展的新数组时,落一条 `snapshot` 全量记录。
 * 旁车文件 `<id>.meta.json` 存最新 meta,让 `list()` 不必解析整个 JSONL。
 */
export class SessionStore {
  /** 所有磁盘写入串行排队:rewind 的 snapshot 与轮末的 append 不允许交错。 */
  private writeChain: Promise<void> = Promise.resolve();
  private lastStateJson: string;
  /**
   * 上一次写入失败过,下次必须落全量 snapshot。
   *
   * 增量写入不像旧的全量快照那样能自愈:内存里的 fullHistory 已经前进,
   * 下一轮的 delta 只会包含更新的消息,失败那一段就永久缺失了——重开时
   * tool-result 会引用不存在的 tool-call。
   */
  private needsSnapshot = false;

  private constructor(
    private readonly dir: string,
    private meta_: SessionMeta,
    /** 已确认落盘的历史——增量判定的基线,只在写成功后前进。 */
    private persisted: ModelMessage[],
    private state_: SessionState,
  ) {
    this.lastStateJson = JSON.stringify(this.state_);
  }

  get id(): string {
    return this.meta_.id;
  }

  get meta(): SessionMeta {
    return this.meta_;
  }

  /** 已落盘的历史。恢复会话时读它来回放。 */
  get messages(): ModelMessage[] {
    return this.persisted;
  }

  get state(): SessionState {
    return this.state_;
  }

  private get file(): string {
    return path.join(this.dir, `${this.meta_.id}.jsonl`);
  }

  private get sidecar(): string {
    return path.join(this.dir, `${this.meta_.id}.meta.json`);
  }

  static async create(params: {
    root: string;
    provider: string;
    model: string;
    dir?: string;
  }): Promise<SessionStore> {
    const dir = params.dir ?? sessionsDir();
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();

    const meta: SessionMeta = {
      id: randomUUID(),
      root: params.root,
      provider: params.provider,
      model: params.model,
      createdAt: now,
      updatedAt: now,
      title: '',
      messageCount: 0,
    };

    const store = new SessionStore(dir, meta, [], structuredClone(EMPTY_STATE));
    store.enqueue(async () => {
      await store.appendRecord({ kind: 'meta', meta });
      await store.writeSidecar();
    });
    await store.flush();
    return store;
  }

  /** 精确 id 打开。前缀匹配请先走 `resolveId()`。 */
  static async open(id: string, dir?: string): Promise<SessionStore> {
    const dir_ = dir ?? sessionsDir();
    const file = path.join(dir_, `${id}.jsonl`);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SessionNotFoundError(id);
      throw err;
    }

    let meta: SessionMeta | undefined;
    let messages: ModelMessage[] = [];
    let state: SessionState | undefined;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record: Record_;
      try {
        record = JSON.parse(line) as Record_;
      } catch {
        continue; // 末尾的不完整写入不应导致会话无法打开
      }
      if (record.kind === 'meta') meta = record.meta;
      else if (record.kind === 'messages' || record.kind === 'snapshot') messages = [...record.messages];
      else if (record.kind === 'append') messages.push(...record.messages);
      else if (record.kind === 'state') state = record.state;
    }

    if (!meta) throw new Error(`Session ${id} has no metadata record.`);
    return new SessionStore(dir_, meta, messages, state ?? structuredClone(EMPTY_STATE));
  }

  /**
   * 把(可能是前缀的)id 解析成唯一完整 id。
   * 0 命中抛 SessionNotFoundError,多命中抛 AmbiguousSessionError。
   *
   * 给了 `root` 就只在该工作区的会话里找:恢复别处的会话会让它的 meta.root
   * 继续指向旧项目,于是两个工作区的 `mojocode sessions` 都列不到它,除非记住
   * 完整 id 否则再也找不回来。
   */
  static async resolveId(
    idOrPrefix: string,
    options?: { dir?: string; root?: string },
  ): Promise<string> {
    if (!idOrPrefix) throw new SessionNotFoundError(idOrPrefix);
    const dir = options?.dir ?? sessionsDir();
    const candidates = options?.root
      ? (await SessionStore.list(options.root, dir)).map((m) => m.id)
      : await SessionStore.sessionIds(dir);
    const matches = candidates.filter((id) => id.startsWith(idOrPrefix));
    if (matches.length === 0) throw new SessionNotFoundError(idOrPrefix);
    if (matches.length > 1) throw new AmbiguousSessionError(idOrPrefix, matches.sort());
    return matches[0]!;
  }

  /** 最新的在前。可选按工作区过滤。走旁车快路径,损坏/缺失时回退全量解析。 */
  static async list(root?: string, dir?: string): Promise<SessionMeta[]> {
    const dir_ = dir ?? sessionsDir();
    const ids = await SessionStore.sessionIds(dir_);

    const metas = await Promise.all(
      ids.map(async (id) => {
        try {
          const raw = await fs.readFile(path.join(dir_, `${id}.meta.json`), 'utf8');
          return JSON.parse(raw) as SessionMeta;
        } catch {
          // 老文件没有旁车,或旁车损坏:慢路径解析 JSONL,并顺手补写旁车。
          try {
            const store = await SessionStore.open(id, dir_);
            await store.writeSidecar().catch(() => {}); // 补写失败只是下次继续慢路径
            return store.meta_;
          } catch {
            return undefined;
          }
        }
      }),
    );

    return metas
      .filter((m): m is SessionMeta => m !== undefined)
      .filter((m) => (root ? m.root === root : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  static async latest(root: string, dir?: string): Promise<SessionStore | undefined> {
    const [newest] = await SessionStore.list(root, dir);
    return newest ? SessionStore.open(newest.id, dir) : undefined;
  }

  /**
   * 启动清理:删除 mtime 早于 `days` 天前的会话文件(连同旁车)。
   * save 即 append,mtime ≈ updatedAt,不必为判断新旧解析大文件。
   * 返回删除的会话数。
   */
  static async cleanup(opts: { days: number; keepIds?: string[]; dir?: string }): Promise<number> {
    const dir = opts.dir ?? sessionsDir();
    const keep = new Set(opts.keepIds ?? []);
    const cutoff = Date.now() - opts.days * 24 * 60 * 60 * 1000;
    const ids = await SessionStore.sessionIds(dir);

    let removed = 0;
    for (const id of ids) {
      if (keep.has(id)) continue;
      const file = path.join(dir, `${id}.jsonl`);
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= cutoff) continue;
        await fs.rm(file, { force: true });
        await fs.rm(path.join(dir, `${id}.meta.json`), { force: true });
        removed += 1;
      } catch {
        // 单个文件失败(并发删除等)不影响其他会话的清理。
      }
    }
    return removed;
  }

  /**
   * 分叉:新 id 的会话立即带上本会话的全部历史与状态,源文件此后不再被写。
   * eager 拷贝——即使用户什么都不发就退出,分叉文件也完整可恢复。
   */
  async fork(params: { provider: string; model: string }): Promise<SessionStore> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      ...this.meta_,
      id: randomUUID(),
      provider: params.provider,
      model: params.model,
      createdAt: now,
      updatedAt: now,
    };

    const forked = new SessionStore(this.dir, meta, [...this.persisted], structuredClone(this.state_));
    forked.enqueue(async () => {
      await forked.appendRecord({ kind: 'meta', meta });
      if (forked.persisted.length > 0) {
        await forked.appendRecord({ kind: 'snapshot', at: now, messages: forked.persisted });
      }
      await forked.appendRecord({ kind: 'state', at: now, state: forked.state_ });
      await forked.writeSidecar();
    });
    await forked.flush();
    return forked;
  }

  async save(messages: ModelMessage[]): Promise<void> {
    // 立刻冻结这一刻的内容(元素引用保留,增量判定要靠它们),之后哪怕
    // agent 继续往活数组里 push,排队中的这次写入也只写它该写的部分。
    const target = [...messages];

    if (!this.meta_.title) {
      const firstUser = target.find((m) => m.role === 'user');
      if (firstUser) this.meta_.title = summarizeContent(firstUser.content).slice(0, 80);
    }
    this.meta_.updatedAt = new Date().toISOString();
    this.meta_.messageCount = target.length;

    const at = this.meta_.updatedAt;
    const meta = { ...this.meta_ };

    this.enqueue(async () => {
      // 增量/全量的判定必须在写链*内部*做:两次 save 可能同时在飞
      //(压缩后的 onHistoryChange 与轮末的 onHistoryChange),若在链外
      // 各自提前判定,前一次写失败、后一次写成功就会把缺口永久固化——
      // 后者的 append 接在一个根本没落盘的基线上。
      const isExtension =
        !this.needsSnapshot &&
        target.length >= this.persisted.length &&
        this.persisted.every((m, i) => target[i] === m);
      const delta = isExtension ? target.slice(this.persisted.length) : undefined;
      const payload: Record_ | undefined =
        delta !== undefined
          ? delta.length > 0
            ? { kind: 'append', at, messages: delta }
            : undefined // 无新增消息(如空轮次):只刷新 meta
          : { kind: 'snapshot', at, messages: target };

      try {
        await this.appendRecord({ kind: 'meta', meta });
        if (payload) await this.appendRecord(payload);
      } catch (err) {
        // 消息没写成功:基线不前进,并要求下次改写全量快照。
        this.needsSnapshot = true;
        throw err;
      }
      this.persisted = target;
      this.needsSnapshot = false;
      await this.writeSidecar(meta);
    });
    await this.flush();
  }

  /** 只有状态真的变了才追加记录,避免每轮一条重复 state。 */
  async saveState(state: SessionState): Promise<void> {
    const json = JSON.stringify(state);
    if (json === this.lastStateJson) return;
    const snapshot = JSON.parse(json) as SessionState; // 深拷贝,防调用方后续原地修改

    const record: StateRecord = { kind: 'state', at: new Date().toISOString(), state: snapshot };
    this.enqueue(async () => {
      await this.appendRecord(record);
      // 写成功后才认账:失败时保持旧值,下次同样的状态还会重试而不是被
      // 脏检查跳过。
      this.lastStateJson = json;
      this.state_ = snapshot;
    });
    await this.flush();
  }

  private enqueue(job: () => Promise<void>): void {
    // 前序失败不阻塞后续写入;错误在 flush() 处向调用方冒出一次。
    this.writeChain = this.writeChain.then(job, job);
  }

  private flush(): Promise<void> {
    return this.writeChain;
  }

  private async appendRecord(record: Record_): Promise<void> {
    await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** 旁车原子写:tmp + rename,读到一半的 list() 不会看见撕裂的 JSON。 */
  private async writeSidecar(meta?: SessionMeta): Promise<void> {
    const tmp = `${this.sidecar}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta ?? this.meta_), 'utf8');
    await fs.rename(tmp, this.sidecar);
  }

  private static async sessionIds(dir: string): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => n.replace(/\.jsonl$/, ''));
  }
}

function summarizeContent(content: unknown): string {
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
      )
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}
