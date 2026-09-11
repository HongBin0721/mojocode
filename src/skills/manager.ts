/**
 * 技能注册表:TTL 惰性缓存 + 变更通知。
 *
 * 没有 watcher 基建,也刻意不引入 fs.watch——file-index.ts 的 15s TTL 模式
 * 已经把"够新"和"不狂扫磁盘"平衡好了。bootstrap 在 turn-start 时触发一次
 * list()(模型看到的 L1 列表在流开始前必须是新的),TUI 的 `/skills` 走
 * refresh() 强制重扫。
 */

import { discoverSkills, toCommandInfos, type SkillCommandInfo, type SkillIndex, type SkillMeta } from './discovery.js';

const EMPTY_INDEX: SkillIndex = { skills: [], failures: [] };

/**
 * 变更通知键,覆盖两个消费面:菜单(user-invocable 投影)与模型列表
 * (digest 同款字段)。failures 不进键——解析失败只在 /skills 与 doctor
 * 里呈现,不值得广播。
 */
function notifyKeyOf(index: SkillIndex): string {
  return JSON.stringify([
    toCommandInfos(index),
    index.skills.filter((s) => !s.disableModelInvocation).map((s) => [s.name, s.description]),
  ]);
}

export class SkillManager {
  private readonly root: string;
  /** 扩展包带来的技能目录(优先级最低),见 discovery.ts;扩展经 resources_discover 还能再加。 */
  private packageDirs: readonly string[];
  /** 包与扩展贡献的提示词模板目录(项目 / 全局的两个约定目录不在这里,discovery 自己知道)。 */
  private promptDirs: readonly string[];
  private readonly ttlMs: number;
  private cached: Promise<SkillIndex> | undefined;
  private fetchedAt = 0;
  private latest: SkillIndex = EMPTY_INDEX;
  // 初始键取自空表:首次扫描结果仍为空时不该触发通知(空 → 空无变化)。
  private notifyKey = notifyKeyOf(EMPTY_INDEX);
  private readonly listeners = new Set<() => void>();

  constructor(options: {
    root: string;
    packageDirs?: readonly string[];
    promptDirs?: readonly string[];
    ttlMs?: number;
  }) {
    this.root = options.root;
    this.packageDirs = options.packageDirs ?? [];
    this.promptDirs = options.promptDirs ?? [];
    this.ttlMs = options.ttlMs ?? 15_000;
  }

  /** 追加技能目录(扩展的 resources_discover);作废缓存,下一次 list 重扫。 */
  addDirs(dirs: readonly string[]): void {
    if (dirs.length === 0) return;
    this.packageDirs = [...this.packageDirs, ...dirs];
    this.cached = undefined;
  }

  /** 追加提示词模板目录(同上)。 */
  addPromptDirs(dirs: readonly string[]): void {
    if (dirs.length === 0) return;
    this.promptDirs = [...this.promptDirs, ...dirs];
    this.cached = undefined;
  }

  /** TTL 内复用同一个 promise;扫描失败不缓存,下次重试(同 createFileLister)。 */
  list(): Promise<SkillIndex> {
    const now = Date.now();
    if (!this.cached || now - this.fetchedAt > this.ttlMs) {
      this.fetchedAt = now;
      this.cached = discoverSkills(this.root, this.packageDirs, this.promptDirs).then(
        (index) => {
          this.applyIndex(index);
          return index;
        },
        (err: unknown) => {
          this.cached = undefined;
          throw err;
        },
      );
    }
    return this.cached;
  }

  /**
   * 最近一次成功扫描的结果,同步读取。bootstrap 初扫之后恒有值;扫描前
   * 读到的是空表——调用方(快照、菜单)把"还没扫完"当"没有技能"呈现即可。
   */
  current(): SkillIndex {
    return this.latest;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  refresh(): Promise<SkillIndex> {
    this.invalidate();
    return this.list();
  }

  /** 结果实质变化(菜单投影或模型可见列表)时通知;返回退订函数。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  find(name: string): SkillMeta | undefined {
    return this.latest.skills.find((skill) => skill.name === name);
  }

  /** user-invocable 投影,命令菜单与 StateSnapshot 用。 */
  commandInfos(): SkillCommandInfo[] {
    return toCommandInfos(this.latest);
  }

  /** 模型可见(model-invocable)技能的摘要,bootstrap 据此决定要不要重建 skill 工具。 */
  digest(): string {
    return JSON.stringify(
      this.latest.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => [skill.name, skill.description]),
    );
  }

  private applyIndex(index: SkillIndex): void {
    this.latest = index;
    const key = notifyKeyOf(index);
    if (key === this.notifyKey) return;
    this.notifyKey = key;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 与 EventBus 同一态度:监听器的异常不打断其他监听器。
      }
    }
  }
}
