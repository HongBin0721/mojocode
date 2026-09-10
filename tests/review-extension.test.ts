import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

import { reviewExtension } from '../src/extensions/review/index.js';
import type { ExtensionCommandOption, ExtensionRunOptions } from '../src/core/extension.js';
import { setLocale, t } from '../src/i18n/index.js';
import { recordingExtensionApi } from './support/extension-api.js';

/**
 * `/review` 扩展。跑在**真实临时仓库**上——它的取值层与失败原因几乎全部
 * 由 git 的真实回答决定,假掉 git 就等于只测了自己的 if。
 *
 * 分工的验收点也在这里:扩展直接在会话进程里跑 git(不再有 reviewCommits
 * 这类 RPC),成功时走 `followUp` 而不是 await 一整轮(handler 是即时 RPC)。
 */

setLocale('zh-CN');

interface Harness {
  options: (path: string[]) => Promise<ExtensionCommandOption[]>;
  run: (args: string) => Promise<void>;
  notices: Array<{ level: string; message: string }>;
  followUps: Array<{ text: string; options?: ExtensionRunOptions }>;
}

function setup(root: string): Harness {
  const followUps: Harness['followUps'] = [];
  const { api, commands, notices } = recordingExtensionApi({
    root,
    followUp: (text, options) => followUps.push({ text, options }),
  });
  reviewExtension.setup(api);
  const command = commands.get('review')!;
  return {
    options: async (p) => (await command.options?.(p)) ?? [],
    /**
     * handler 是即时 RPC:它同步返回,git 收集与 followUp 在后台跑(不这样
     * 做的话几秒的 git 会堵住客户端的串行 RPC 队列)。所以这里等到有东西
     * 落地为止,而不是 await handler。
     */
    run: async (args) => {
      const before = followUps.length + notices.length;
      await command.handler(args, api.ctx);
      await vi.waitFor(() => expect(followUps.length + notices.length).toBeGreaterThan(before), {
        timeout: 10_000,
      });
    },
    notices,
    followUps,
  };
}

describe('/review 扩展', () => {
  let repo: string;
  let clean: string;
  let emptyRepo: string;
  let plain: string;

  const commit = (cwd: string, message: string) =>
    execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message], { cwd });

  beforeAll(async () => {
    // main 上两个提交,feature 停在第一个;工作区有未提交修改。
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-reviewext-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo });
    await commit(repo, 'first');
    await execa('git', ['branch', 'feature'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
    await execa('git', ['add', 'b.txt'], { cwd: repo });
    await commit(repo, 'second: add b');
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\ndirty\n');

    clean = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-reviewext-clean-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: clean });
    await fs.writeFile(path.join(clean, 'c.txt'), 'c\n');
    await execa('git', ['add', 'c.txt'], { cwd: clean });
    await commit(clean, 'clean commit');

    // 空仓:是仓库,但没有提交、没有其他分支。
    emptyRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-reviewext-empty-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: emptyRepo });
    await fs.writeFile(path.join(emptyRepo, 'u.txt'), 'u\n');

    plain = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-reviewext-plain-'));
    await fs.writeFile(path.join(plain, 'a.txt'), 'a\n');
  });

  afterAll(async () => {
    for (const dir of [repo, clean, emptyRepo, plain]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  describe('取值层', () => {
    it('第一层是四个预设:base/commit 再开一层,custom 预填', async () => {
      const opts = await setup(repo).options([]);
      expect(opts.map((o) => o.value)).toEqual(['base', 'uncommitted', 'commit', 'custom']);
      expect(opts.find((o) => o.value === 'base')?.expands).toBe(true);
      expect(opts.find((o) => o.value === 'commit')?.expands).toBe(true);
      expect(opts.find((o) => o.value === 'custom')?.prefill).toBe(true);
      expect(opts.find((o) => o.value === 'uncommitted')?.expands).toBeUndefined();
    });

    it('非 git 目录第一层为空表(客户端据此回退成提交裸命令)', async () => {
      expect(await setup(plain).options([])).toEqual([]);
    });

    it('base 层是本地分支(不含当前分支),单行渲染:值是分支名、说明是它的提交标题', async () => {
      const opts = await setup(repo).options(['base']);
      expect(opts.map((o) => o.value)).toEqual(['feature']);
      expect(opts[0]?.label).toBe('first');
      expect(opts[0]?.title).toBeUndefined();
    });

    it('commit 层是最近提交,新在前,说明带相对时间', async () => {
      const opts = await setup(repo).options(['commit']);
      expect(opts).toHaveLength(2);
      expect(opts[0]?.label).toContain('second: add b');
      expect(opts[0]?.label).toContain('ago');
    });
  });

  describe('执行', () => {
    it('成功:followUp 一轮,提示词带范围块,display 是 /review <范围>', async () => {
      const h = setup(repo);
      await h.run('uncommitted');
      expect(h.notices).toEqual([]);
      expect(h.followUps).toHaveLength(1);
      const [entry] = h.followUps;
      expect(entry?.options?.display).toBe('/review uncommitted');
      // 信封复用技能的 <skill-command>,回放据此还原成命令原文。
      expect(entry?.text).toContain('/review uncommitted');
      expect(entry?.text).toContain('Review the changes described below');
      expect(entry?.text).toContain('Uncommitted changes in the working tree');
    });

    it('base 范围:merge-base 已解析成 SHA 嵌进命令,模型不必自己跑 merge-base', async () => {
      const h = setup(repo);
      await h.run('base feature');
      expect(h.followUps).toHaveLength(1);
      expect(h.followUps[0]?.options?.display).toBe('/review base feature');
      expect(h.followUps[0]?.text).toMatch(/git diff --stat [0-9a-f]{40} HEAD/);
    });


    it('干净树报 clean-tree(info 级,不是错误)', async () => {
      const h = setup(clean);
      await h.run('uncommitted');
      expect(h.followUps).toEqual([]);
      expect(h.notices).toEqual([{ level: 'info', message: t('notice.reviewCleanTree') }]);
    });

    it('不认识的分支报 unknown-branch,消息里带分支名', async () => {
      const h = setup(repo);
      await h.run('base nope');
      expect(h.followUps).toEqual([]);
      expect(h.notices[0]?.level).toBe('warn');
      expect(h.notices[0]?.message).toContain('nope');
    });

    it('参数不成范围报用法', async () => {
      const h = setup(repo);
      await h.run('base ..evil');
      expect(h.notices).toEqual([{ level: 'warn', message: t('notice.reviewUsage') }]);
    });
  });

  describe('半截参数(手打,或某一层为空后客户端的回退)', () => {
    it('非 git 仓库:一律报没有仓库,不报"没有分支"', async () => {
      for (const arg of ['', 'base', 'commit']) {
        const h = setup(plain);
        await h.run(arg);
        expect(h.notices).toEqual([{ level: 'warn', message: t('notice.reviewNoRepo') }]);
      }
    });

    it('空仓:base 报没有分支、commit 报没有提交', async () => {
      const noBranch = setup(emptyRepo);
      await noBranch.run('base');
      expect(noBranch.notices).toEqual([{ level: 'warn', message: t('notice.reviewNoBranches') }]);

      const noCommit = setup(emptyRepo);
      await noCommit.run('commit');
      expect(noCommit.notices).toEqual([{ level: 'warn', message: t('notice.reviewNoCommits') }]);
    });

    it('列表非空时的半截参数是"打了半截命令",报用法', async () => {
      const h = setup(repo);
      await h.run('base');
      expect(h.notices).toEqual([{ level: 'warn', message: t('notice.reviewUsage') }]);

      const c = setup(repo);
      await c.run('commit');
      expect(c.notices).toEqual([{ level: 'warn', message: t('notice.reviewUsage') }]);
    });

    it('裸 /review 在真仓库里报用法', async () => {
      const h = setup(repo);
      await h.run('');
      expect(h.notices).toEqual([{ level: 'warn', message: t('notice.reviewUsage') }]);
    });

    it('裸 custom 报用法(正常路径由 prefill 预填输入框补文本)', async () => {
      const h = setup(repo);
      await h.run('custom');
      expect(h.notices).toEqual([{ level: 'warn', message: t('notice.reviewUsage') }]);
      expect(h.followUps).toEqual([]);
    });
  });

  it('handler 是即时 RPC:git 还没跑完就已经返回,followUp 随后才排上', async () => {
    const followUp = vi.fn();
    const { api, commands } = recordingExtensionApi({ root: repo, followUp });
    reviewExtension.setup(api);
    // 返回时收集还在后台跑——handler 里 await 几秒的 git 会把客户端的串行
    // RPC 队列整个堵住(用户随后的 run/abort/switch 全排在后面),而请求本身
    // 还要冒 HTTP 超时的风险。
    await commands.get('review')!.handler('uncommitted', api.ctx);
    expect(followUp).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(followUp).toHaveBeenCalledOnce(), { timeout: 10_000 });
  });
});
