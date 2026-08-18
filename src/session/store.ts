import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { sessionsDir } from '../config/paths.js';
import { COMPACT_MARKER } from '../agent/compact.js';
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
  /**
   * 归档时间(ISO)。缺省 = 未归档;用时间戳而非布尔,归档视图可按它排序,
   * 旧 meta 文件没有此字段天然兼容。归档会话仍出现在 `list()` 里,由消费端
   * 过滤(GUI 归档视图与任务列表用同一 RPC)。
   */
  archivedAt?: string;
}

/** 消息之外需要跨会话恢复的东西:todos、会话级授权规则、两轴权限。 */
export interface SessionState {
  todos: TodoItem[];
  /** 原始规则串,如 `Bash(npm test:*)`、`Mcp(name)`。 */
  allowBash: string[];
  allowWrite: string[];
  /** 联网规则串(`WebSearch` / `WebFetch(domain:x)`)。可选:旧会话文件没有此字段。 */
  allowNet?: string[];
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
  /**
   * 本会话经 write/edit 落地过的文件(任务视角的变更索引)。可选:空时
   * 整个字段不出现,老会话的状态 JSON 一字不差、脏检查不多写记录。
   * bash 造成的变更不在此列——git 真相仍以 workspaceStatus 为准。
   */
  changedFiles?: ChangedFileEntry[];
}

/** 一条任务级变更索引:文件路径 + 首见形态 + 落地次数。 */
export interface ChangedFileEntry {
  path: string;
  kind: 'created' | 'modified';
  count: number;
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
  /**
   * 回放用的完整展示历史,仅在与 messages 不同时写入(压缩把模型历史换成
   * 摘要,但用户在 `/resume` 里该看到的是原始对话)。缺失时(旧文件)由
   * open() 按快照形状启发式重建,见 reconcileDisplay。
   */
  display?: ModelMessage[];
}

interface StateRecord {
  kind: 'state';
  at: string;
  state: SessionState;
}

/**
 * 一次子任务(task 工具)的完整过程。工具结果只带最终报告,过程从主对话看
 * 是黑箱——这份记录是排查"子任务为什么给了错结论"的唯一入口。
 * open() 的恢复回放不读它(它不属于主对话历史);旧版本读到未知 kind 会
 * 静默跳过,格式向后兼容。
 */
export interface SessionTaskRecord {
  callId: string;
  description: string;
  mode?: string;
  steps: number;
  tokens: number;
  finishReason?: string;
  error?: string;
  messages: ModelMessage[];
}

interface TaskRecord {
  kind: 'task';
  at: string;
  task: SessionTaskRecord;
}

/**
 * 一轮的用量统计。与 task 记录同理:恢复回放不读它(它不属于对话历史),
 * 旧版本读到未知 kind 会静默跳过。存在它是为了事后可查——缓存命中率、
 * 成本核算都需要逐轮的真实数据,而消息流里无从还原。
 */
export interface SessionUsageRecord {
  provider: string;
  model: string;
  /** 本轮各步输入 token 之和(每步都重发全量上下文)。 */
  inputTokens: number;
  outputTokens: number;
  /** inputTokens 中命中前缀缓存的部分;provider 不报缓存时缺省。 */
  cachedInputTokens?: number;
}

interface UsageRecord {
  kind: 'usage';
  at: string;
  usage: SessionUsageRecord;
}

type Record_ =
  | MetaRecord
  | MessagesRecord
  | AppendRecord
  | SnapshotRecord
  | StateRecord
  | TaskRecord
  | UsageRecord;

/**
 * 逐消息记住序列化结果。带 base64 图片的消息单条就有几 MB,而 open() 里
 * 每条缺 display 字段的快照记录都要比一遍两份历史——不记的话
 * `--resume` 会在几十 MB 的重复 stringify 上干等。WeakMap:消息对象被丢弃
 * 时缓存自动跟着走。
 */
const serializedMessages = new WeakMap<object, string>();
function messageKey(message: ModelMessage): string {
  const cached = serializedMessages.get(message);
  if (cached !== undefined) return cached;
  const json = JSON.stringify(message);
  serializedMessages.set(message, json);
  return json;
}

/**
 * 同一条消息的两次出现:save() 里是同一个对象引用(压缩/回退都从原数组
 * 切片);open() 里是同一份 JSON 的两次 parse,序列化后逐字节相同
 * (JSON.parse/stringify 保持键序)。
 */
function sameMessage(a: ModelMessage | undefined, b: ModelMessage | undefined): boolean {
  if (a === b) return a !== undefined;
  if (!a || !b) return false;
  return messageKey(a) === messageKey(b);
}

/**
 * 模型历史被整体替换(snapshot)时,推导展示历史该怎么走。按新数组相对
 * 旧模型历史的形状分派:
 * - **扩展**(写失败后的恢复快照):新增部分照常追加;
 * - **压缩型**(`[摘要, ...旧历史的尾巴]`):展示历史不动——被摘要吞掉的
 *   消息正是它存在的意义;
 * - **前缀型**(rewind):用户真的删了尾部,展示历史截掉同样数量;
 * - **认不出**(fork 种子、旧格式、手工修改):以快照为准,别自作聪明。
 */
function reconcileDisplay(
  prevModel: ModelMessage[],
  prevDisplay: ModelMessage[],
  next: ModelMessage[],
): ModelMessage[] {
  if (next.length >= prevModel.length && prevModel.every((m, i) => sameMessage(m, next[i]))) {
    return [...prevDisplay, ...next.slice(prevModel.length)];
  }

  const first = next[0];
  const isCompaction =
    first !== undefined &&
    first.role === 'user' &&
    typeof first.content === 'string' &&
    first.content.startsWith(COMPACT_MARKER) &&
    next.length - 1 <= prevModel.length &&
    next.slice(1).every((m, i) => sameMessage(m, prevModel[prevModel.length - (next.length - 1) + i]));
  if (isCompaction) return prevDisplay;

  if (next.length < prevModel.length && next.every((m, i) => sameMessage(m, prevModel[i]))) {
    const removed = prevModel.length - next.length;
    if (removed <= prevDisplay.length) return prevDisplay.slice(0, prevDisplay.length - removed);
  }

  return [...next];
}

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
 * 两份历史,一份文件:`messages` 是喂给模型的(压缩后是摘要+尾巴),
 * `displayMessages` 是给人看的完整展示历史——压缩绝不缩减它,`/resume`
 * 的时间线回放与事后调试靠它看到实际发生的一切。
 *
 * 写入策略:正常轮次只追加 `append` 增量记录(文件随消息数线性增长);
 * 压缩或 rewind 把历史换成非扩展的新数组时,落一条 `snapshot` 全量记录,
 * 展示历史与之不同时随记录带出(`display` 字段)。旁车文件 `<id>.meta.json`
 * 存最新 meta,让 `list()` 不必解析整个 JSONL。
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
    /** 完整展示历史(压缩不缩减它),与 persisted 同步前进。 */
    private display: ModelMessage[],
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

  /**
   * 记下这个会话当前在用的 provider/model。恢复会话不再切回记录里的模型,
   * meta 的这两个字段因此只剩展示用途(选择器与 `mojocode sessions` 的行),
   * 停在创建时的值会让列表持续显示一个早就换掉的模型。只改内存,由下一次
   * `save` 顺带落盘——它每轮都会重写 meta 记录和旁车文件。
   */
  setModel(provider: string, model: string): void {
    this.meta_.provider = provider;
    this.meta_.model = model;
  }

  /**
   * 活跃会话的归档/改名走实例方法同步内存 meta_:save() 每轮都用内存 meta
   * 重写 meta 记录和旁车,只改磁盘(静态路径)会在下一轮被冲掉。落盘由
   * 调用方随后的静态方法或下一次 save 完成。
   */
  setArchivedFlag(archived: boolean): void {
    if (archived) this.meta_.archivedAt = new Date().toISOString();
    else delete this.meta_.archivedAt;
  }

  setTitle(title: string): void {
    this.meta_.title = title;
  }

  /** 已落盘的模型历史(压缩后是摘要+尾巴)。恢复会话时喂给 agent。 */
  get messages(): ModelMessage[] {
    return this.persisted;
  }

  /** 完整展示历史。恢复会话时时间线回放读它,压缩不缩减它。 */
  get displayMessages(): ModelMessage[] {
    return this.display;
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

    const store = new SessionStore(dir, meta, [], [], structuredClone(EMPTY_STATE));
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
    let display: ModelMessage[] = [];
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
      else if (record.kind === 'messages' || record.kind === 'snapshot') {
        const next = [...record.messages];
        // 快照随带的展示历史优先;旧文件没有该字段,按形状启发式推导
        // (压缩型不缩减、rewind 型同步截尾)。
        display =
          record.kind === 'snapshot' && record.display
            ? [...record.display]
            : reconcileDisplay(messages, display, next);
        messages = next;
      } else if (record.kind === 'append') {
        messages.push(...record.messages);
        display.push(...record.messages);
      } else if (record.kind === 'state') state = record.state;
    }

    if (!meta) throw new Error(`Session ${id} has no metadata record.`);
    return new SessionStore(dir_, meta, messages, display, state ?? structuredClone(EMPTY_STATE));
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
        // 归档会话不清理:归档后不再写 → mtime 停走,按过期删会把用户明确
        // 想留的任务清掉。旁车读不到时按未归档处理(维持旧行为)。
        try {
          const raw = await fs.readFile(path.join(dir, `${id}.meta.json`), 'utf8');
          if ((JSON.parse(raw) as SessionMeta).archivedAt) continue;
        } catch {
          // 无旁车/损坏:视作未归档
        }
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
   * 会话生命周期的静态侧(GUI 的归档/改名/删除走这里)。
   *
   * 写入纪律:JSONL 是权威、旁车是缓存——meta 变更必须「追加 meta 记录 +
   * 原子写旁车」两处都落。只写旁车的话,旁车一旦损坏,list() 慢路径会从
   * JSONL 重建出没有该变更的 meta,归档状态凭空消失。
   */
  private static async updateMeta(
    id: string,
    dir: string | undefined,
    mutate: (meta: SessionMeta) => void,
  ): Promise<SessionMeta> {
    const dir_ = dir ?? sessionsDir();
    const file = path.join(dir_, `${id}.jsonl`);
    // 快路径读旁车拿当前 meta;损坏/缺失时慢路径解析 JSONL。
    let meta: SessionMeta | undefined;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir_, `${id}.meta.json`), 'utf8')) as SessionMeta;
    } catch {
      meta = (await SessionStore.open(id, dir_)).meta_;
    }
    if (!meta) throw new SessionNotFoundError(id);

    mutate(meta);
    // 先确认 JSONL 还在(并发删除的会话不该被"复活"出一个孤儿旁车)。
    try {
      await fs.access(file);
    } catch {
      throw new SessionNotFoundError(id);
    }
    await fs.appendFile(file, `${JSON.stringify({ kind: 'meta', meta })}\n`, 'utf8');
    const tmp = path.join(dir_, `${id}.meta.json.tmp`);
    await fs.writeFile(tmp, JSON.stringify(meta), 'utf8');
    await fs.rename(tmp, path.join(dir_, `${id}.meta.json`));
    return meta;
  }

  /** 归档/取消归档。返回更新后的 meta。 */
  static setArchived(id: string, archived: boolean, dir?: string): Promise<SessionMeta> {
    return SessionStore.updateMeta(id, dir, (meta) => {
      if (archived) meta.archivedAt = new Date().toISOString();
      else delete meta.archivedAt;
    });
  }

  /** 重命名(设 title)。返回更新后的 meta。 */
  static rename(id: string, title: string, dir?: string): Promise<SessionMeta> {
    return SessionStore.updateMeta(id, dir, (meta) => {
      meta.title = title;
    });
  }

  /** 真删磁盘文件(JSONL + 旁车)。幂等:文件不存在也算成功。 */
  static async remove(id: string, dir?: string): Promise<void> {
    const dir_ = dir ?? sessionsDir();
    await fs.rm(path.join(dir_, `${id}.jsonl`), { force: true });
    await fs.rm(path.join(dir_, `${id}.meta.json`), { force: true });
  }

  /**
   * 分叉:新 id 的会话立即带上本会话的全部历史与状态,源文件此后不再被写。
   * eager 拷贝——即使用户什么都不发就退出,分叉文件也完整可恢复。
   */
  async fork(params: { provider: string; model: string }): Promise<SessionStore> {
    // 先把源会话排队中的写入放干:轮末的 save 是 fire-and-forget,而 agent 在
    // 触发它*之前*就已不再 isRunning——`/fork` 的忙碌拦截因此会放行,此刻
    // persisted 可能还停在上一轮。不排干就会把最后一轮既漏出分叉快照,又在
    // 分叉之后补写进源文件(与"源会话从此不再被写"相悖)。
    // 排干失败不阻断分叉:那一轮本就没落盘,persisted 是磁盘上的真相。
    await this.flush().catch(() => {});

    const now = new Date().toISOString();
    const meta: SessionMeta = {
      ...this.meta_,
      id: randomUUID(),
      provider: params.provider,
      model: params.model,
      createdAt: now,
      updatedAt: now,
    };

    const forked = new SessionStore(
      this.dir,
      meta,
      [...this.persisted],
      [...this.display],
      structuredClone(this.state_),
    );
    forked.enqueue(async () => {
      await forked.appendRecord({ kind: 'meta', meta });
      if (forked.persisted.length > 0) {
        // 展示历史随种子快照带过去,分叉的会话恢复时同样能看到压缩前的完整对话。
        const displayDiffers =
          forked.display.length !== forked.persisted.length ||
          !forked.display.every((m, i) => m === forked.persisted[i]);
        await forked.appendRecord({
          kind: 'snapshot',
          at: now,
          messages: forked.persisted,
          ...(displayDiffers ? { display: forked.display } : {}),
        });
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
      // 展示历史与模型历史同步推演(压缩不缩减、rewind 截尾)。快照记录只在
      // 两者真的不同时才带 display 字段——没压缩过的会话不重复写一遍。
      const nextDisplay = reconcileDisplay(this.persisted, this.display, target);
      const displayDiffers =
        nextDisplay.length !== target.length || !nextDisplay.every((m, i) => m === target[i]);
      const payload: Record_ | undefined =
        delta !== undefined
          ? delta.length > 0
            ? { kind: 'append', at, messages: delta }
            : undefined // 无新增消息(如空轮次):只刷新 meta
          : {
              kind: 'snapshot',
              at,
              messages: target,
              ...(displayDiffers ? { display: nextDisplay } : {}),
            };

      try {
        await this.appendRecord({ kind: 'meta', meta });
        if (payload) await this.appendRecord(payload);
      } catch (err) {
        // 消息没写成功:基线不前进,并要求下次改写全量快照。
        this.needsSnapshot = true;
        throw err;
      }
      this.persisted = target;
      this.display = nextDisplay;
      this.needsSnapshot = false;
      await this.writeSidecar(meta);
    });
    await this.flush();
  }

  /**
   * 追加一条附属记录(子任务过程 / 轮末用量这类不属于对话历史的记录)。
   * 尽力而为:失败不打扰用户(与 saveState 同理)。
   */
  private async appendExtra(record: TaskRecord | UsageRecord): Promise<void> {
    this.enqueue(async () => {
      await this.appendRecord(record);
    });
    await this.flush();
  }

  /** 追加一条子任务过程记录。 */
  async saveTask(task: SessionTaskRecord): Promise<void> {
    await this.appendExtra({ kind: 'task', at: new Date().toISOString(), task });
  }

  /** 追加一条轮末用量记录。 */
  async saveUsage(usage: SessionUsageRecord): Promise<void> {
    await this.appendExtra({ kind: 'usage', at: new Date().toISOString(), usage });
  }

  /**
   * 读出一个会话文件里的附属记录(时间顺序),按 pick 返回非 undefined 的
   * 行。ENOENT 映射为 SessionNotFoundError,末尾撕裂的写入照旧忽略——
   * 这套文件读取语义只允许有这一份(readUsage / readTasks 共用)。
   * 回查/测试用,不常驻内存。
   */
  private static async readExtraRecords<T>(
    id: string,
    dir: string | undefined,
    pick: (record: Record_) => T | undefined,
  ): Promise<T[]> {
    const file = path.join(dir ?? sessionsDir(), `${id}.jsonl`);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SessionNotFoundError(id);
      throw err;
    }
    const out: T[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record_;
        const picked = pick(record);
        if (picked !== undefined) out.push(picked);
      } catch {
        // 末尾的不完整写入照旧忽略
      }
    }
    return out;
  }

  /** 读出一个会话文件里的逐轮用量(时间顺序)。事后统计/测试用,不常驻内存。 */
  static readUsage(
    id: string,
    dir?: string,
  ): Promise<Array<SessionUsageRecord & { at: string }>> {
    return SessionStore.readExtraRecords(id, dir, (record) =>
      record.kind === 'usage' ? { ...record.usage, at: record.at } : undefined,
    );
  }

  /** 读出一个会话文件里的全部子任务过程(时间顺序)。回查/测试用,不常驻内存。 */
  static readTasks(id: string, dir?: string): Promise<Array<SessionTaskRecord & { at: string }>> {
    return SessionStore.readExtraRecords(id, dir, (record) =>
      record.kind === 'task' ? { ...record.task, at: record.at } : undefined,
    );
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
