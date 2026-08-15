import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import {
  parseReviewArg,
  collectReviewTargets,
  collectReviewCommits,
  collectReviewSummary,
  buildReviewPrompt,
  MAX_STATUS_LINES,
  type ReviewSummary,
} from '../src/agent/review.js';

describe('parseReviewArg', () => {
  it('识别四个范围', () => {
    expect(parseReviewArg('uncommitted')).toEqual({ kind: 'uncommitted' });
    expect(parseReviewArg('base main')).toEqual({ kind: 'base', branch: 'main' });
    expect(parseReviewArg('commit abc1234')).toEqual({ kind: 'commit', sha: 'abc1234' });
    expect(parseReviewArg('custom 关注并发问题')).toEqual({
      kind: 'custom',
      instructions: '关注并发问题',
    });
  });

  it('容忍首尾与关键字后的多余空白', () => {
    expect(parseReviewArg('  uncommitted ')).toEqual({ kind: 'uncommitted' });
    expect(parseReviewArg('base  feature/x')).toEqual({ kind: 'base', branch: 'feature/x' });
    expect(parseReviewArg('base v1.2.3')).toEqual({ kind: 'base', branch: 'v1.2.3' });
    expect(parseReviewArg('commit  abc1234')).toEqual({ kind: 'commit', sha: 'abc1234' });
  });

  it('commit 的 sha 大小写归一,7-40 位十六进制才认', () => {
    expect(parseReviewArg('commit ABCDEF1234567')).toEqual({ kind: 'commit', sha: 'abcdef1234567' });
    expect(parseReviewArg('commit abc123')).toBeUndefined(); // 6 位太短
    expect(parseReviewArg('commit xyz')).toBeUndefined(); // 非 hex
    expect(parseReviewArg('commit HEAD')).toBeUndefined(); // 只认字面 sha
  });

  it('恰好叫 base 的分支走 base base', () => {
    expect(parseReviewArg('base base')).toEqual({ kind: 'base', branch: 'base' });
  });

  it('git 合法的分支名都认:@、中文等(收集器列得出来的,解析不能拒)', () => {
    expect(parseReviewArg('base feature@x')).toEqual({ kind: 'base', branch: 'feature@x' });
    expect(parseReviewArg('base 中文分支')).toEqual({ kind: 'base', branch: '中文分支' });
    expect(parseReviewArg('base release/v1.2')).toEqual({ kind: 'base', branch: 'release/v1.2' });
  });

  it('裸 base/commit/custom 不成范围(App 拦去开选择器/预填)', () => {
    expect(parseReviewArg('base')).toBeUndefined();
    expect(parseReviewArg('commit')).toBeUndefined();
    expect(parseReviewArg('custom')).toBeUndefined();
    expect(parseReviewArg('custom   ')).toBeUndefined(); // 空白焦点文本无效
  });

  it('不认识的一律 undefined', () => {
    expect(parseReviewArg('')).toBeUndefined();
    expect(parseReviewArg('basement x')).toBeUndefined(); // 前缀撞车不算
    expect(parseReviewArg('UNCOMMITTED')).toBeUndefined();
    expect(parseReviewArg('uncommitted extra')).toBeUndefined();
    expect(parseReviewArg('base -x')).toBeUndefined(); // 选项注入
    expect(parseReviewArg('base a..b')).toBeUndefined(); // 区间注入
    expect(parseReviewArg('base a@{b}')).toBeUndefined(); // reflog 语法
    expect(parseReviewArg('base a b')).toBeUndefined(); // 分支名不含空格
    expect(parseReviewArg('base feature/')).toBeUndefined(); // 不以 / 结尾
    expect(parseReviewArg('base x.lock')).toBeUndefined(); // .lock 结尾保留给 git
    expect(parseReviewArg('base; rm')).toBeUndefined();
    expect(parseReviewArg('last-commit')).toBeUndefined(); // 已被提交选择器取代
  });
});

describe('buildReviewPrompt', () => {
  const uncommitted: ReviewSummary = {
    currentBranch: 'main',
    logLines: [],
    statLines: [' a.txt | 1 +', ' 1 file changed, 1 insertion(+)'],
    statusLines: [' M a.txt', '?? u.txt'],
    truncated: {},
  };
  const commit: ReviewSummary = {
    commitSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    commitOneline: 'abcdefabc second: add b',
    currentBranch: 'main',
    logLines: [],
    statLines: [' b.txt | 1 +'],
    statusLines: [],
    truncated: {},
  };
  const base: ReviewSummary = {
    headSha: '1111111111111111111111111111111111111111',
    mergeBaseSha: '2222222222222222222222222222222222222222',
    commitCount: 1,
    currentBranch: 'main',
    logLines: ['abcdefabc second: add b'],
    statLines: [' b.txt | 1 +'],
    statusLines: [],
    truncated: {},
  };

  it('只读条款与发现格式对所有范围都在', () => {
    for (const summary of [uncommitted, commit, base]) {
      for (const scope of [
        { kind: 'uncommitted' as const },
        { kind: 'commit' as const, sha: 'abcdef1234' },
        { kind: 'base' as const, branch: 'feature' },
        { kind: 'custom' as const, instructions: 'focus on races' },
      ]) {
        const prompt = buildReviewPrompt(scope, summary);
        expect(prompt).toContain('read-only review');
        expect(prompt).toContain('Do NOT modify');
        expect(prompt).toContain('exit_plan');
        expect(prompt).toContain('[high|medium|low]');
      }
    }
  });

  it('uncommitted:嵌 porcelain 与安全前缀命令,明示 untracked 要用 read 工具', () => {
    const prompt = buildReviewPrompt({ kind: 'uncommitted' }, uncommitted);
    expect(prompt).toContain(' M a.txt');
    expect(prompt).toContain('?? u.txt');
    expect(prompt).toContain('git diff HEAD -- <path>');
    expect(prompt).toContain('`??`');
    expect(prompt).toContain('read tool');
    // base 专属内容不该出现
    expect(prompt).not.toContain('merge-base');
    expect(prompt).not.toContain('git show');
  });

  it('commit:嵌 oneline 标题与 git show 命令(全 SHA)', () => {
    const prompt = buildReviewPrompt({ kind: 'commit', sha: 'abcdefabc' }, commit);
    expect(prompt).toContain('abcdefabc second: add b');
    expect(prompt).toContain('git show --stat abcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(prompt).toContain(
      'git show abcdefabcdefabcdefabcdefabcdefabcdefabcd -- <path>',
    );
    expect(prompt).not.toContain('merge-base');
  });

  it('custom:未提交范围块 + 用户焦点指令,且焦点指令优先于通用指引', () => {
    const prompt = buildReviewPrompt(
      { kind: 'custom', instructions: '重点看并发与错误处理' },
      uncommitted,
    );
    expect(prompt).toContain('重点看并发与错误处理');
    expect(prompt).toContain('Review focus requested by the user');
    expect(prompt).toContain('git diff HEAD -- <path>'); // 范围块照常在场
    expect(prompt).toContain('read tool'); // untracked 指引也在
  });

  it('base:嵌 merge-base SHA(命令用全 SHA,描述用短 SHA)与分支名', () => {
    const prompt = buildReviewPrompt({ kind: 'base', branch: 'feature' }, base);
    expect(prompt).toContain('since it diverged from feature');
    expect(prompt).toContain('2222222222222222222222222222222222222222 HEAD');
    expect(prompt).toContain('merge-base 2222222222');
    expect(prompt).toContain('1 commit(s) ahead');
    expect(prompt).toContain('newest first');
    expect(prompt).toContain('abcdefabc second: add b');
  });

  it('detached HEAD 时分支描述退化为 a detached HEAD', () => {
    const prompt = buildReviewPrompt(
      { kind: 'uncommitted' },
      { ...uncommitted, currentBranch: undefined },
    );
    expect(prompt).toContain('a detached HEAD');
  });

  it('超限段落以 ... N more 收尾', () => {
    const many: ReviewSummary = {
      ...uncommitted,
      statusLines: Array.from({ length: MAX_STATUS_LINES }, (_, i) => `?? f${i}.txt`),
      truncated: { status: 5 },
    };
    const prompt = buildReviewPrompt({ kind: 'uncommitted' }, many);
    expect(prompt).toContain('... 5 more');
    expect(prompt).not.toContain('?? f200.txt');
  });

  it('纯 untracked(无 stat)有占位说明', () => {
    const prompt = buildReviewPrompt(
      { kind: 'uncommitted' },
      { ...uncommitted, statLines: [] },
    );
    expect(prompt).toContain('(no tracked changes — only untracked files)');
  });
});

describe('collectReviewTargets / collectReviewCommits / collectReviewSummary(真实临时仓库)', () => {
  let repo: string;
  let clean: string;
  let orphanRepo: string;
  let emptyRepo: string;
  let plain: string;

  const commit = (cwd: string, message: string) =>
    execa(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message],
      { cwd },
    );

  beforeAll(async () => {
    // 主仓库:main 上两个提交,feature 分支停在第一个;工作区有未提交修改 + untracked。
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-review-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo });
    await commit(repo, 'first');
    await execa('git', ['branch', 'feature'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');
    await execa('git', ['add', 'b.txt'], { cwd: repo });
    await commit(repo, 'second: add b');
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\ndirty\n');
    await fs.writeFile(path.join(repo, 'u.txt'), 'u\n');

    // 干净仓库:clean-tree 用。
    clean = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-review-clean-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: clean });
    await fs.writeFile(path.join(clean, 'c.txt'), 'c\n');
    await execa('git', ['add', 'c.txt'], { cwd: clean });
    await commit(clean, 'clean commit');

    // 孤儿分支仓库:lonely 与 main 无共同祖先。
    orphanRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-review-orphan-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: orphanRepo });
    await fs.writeFile(path.join(orphanRepo, 'o.txt'), 'o\n');
    await execa('git', ['add', 'o.txt'], { cwd: orphanRepo });
    await commit(orphanRepo, 'o1');
    await execa('git', ['checkout', '-q', '--orphan', 'lonely'], { cwd: orphanRepo });
    await execa('git', ['rm', '-rqf', '.'], { cwd: orphanRepo });
    await fs.writeFile(path.join(orphanRepo, 'x.txt'), 'x\n');
    await execa('git', ['add', 'x.txt'], { cwd: orphanRepo });
    await commit(orphanRepo, 'orphan root');
    await execa('git', ['checkout', '-q', 'main'], { cwd: orphanRepo });

    // 空仓:只有 untracked,没有提交。
    emptyRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-review-empty-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: emptyRepo });
    await fs.writeFile(path.join(emptyRepo, 'u.txt'), 'u\n');

    // 非 git 目录。
    plain = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-review-plain-'));
    await fs.writeFile(path.join(plain, 'a.txt'), 'a\n');
  });

  afterAll(async () => {
    for (const dir of [repo, clean, orphanRepo, emptyRepo, plain]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('collectReviewTargets:给出当前分支与其余分支(含最新提交标题)', async () => {
    const targets = await collectReviewTargets(repo);
    expect(targets.isRepo).toBe(true);
    expect(targets.detached).toBe(false);
    expect(targets.currentBranch).toBe('main');
    const feature = targets.branches.find((b) => b.name === 'feature');
    expect(feature?.subject).toBe('first'); // feature 停在第一个提交上
    expect(targets.branches.some((b) => b.name === 'main')).toBe(false);
  });

  it('collectReviewTargets:空仓也是仓库(uncommitted 可用)', async () => {
    const targets = await collectReviewTargets(emptyRepo);
    expect(targets.isRepo).toBe(true);
    expect(targets.currentBranch).toBe('main');
  });

  it('collectReviewTargets:非 git 目录 isRepo=false', async () => {
    expect((await collectReviewTargets(plain)).isRepo).toBe(false);
  });

  it('collectReviewCommits:最近提交在前,带标题与相对时间', async () => {
    const commits = await collectReviewCommits(repo);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(commits[0]?.subject).toBe('second: add b');
    expect(commits[0]?.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(commits[0]?.date).not.toBe('');
    expect(commits[1]?.subject).toBe('first');
  });

  it('collectReviewCommits:空仓与非 git 目录返回空表', async () => {
    expect(await collectReviewCommits(emptyRepo)).toEqual([]);
    expect(await collectReviewCommits(plain)).toEqual([]);
  });

  it('uncommitted:摘要含 porcelain 与 diffstat', async () => {
    const result = await collectReviewSummary(repo, { kind: 'uncommitted' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 回归:分支名漏填会让 scope 描述误报 detached HEAD。
    expect(result.summary.currentBranch).toBe('main');
    expect(result.summary.statusLines.some((line) => line.includes('a.txt'))).toBe(true);
    expect(result.summary.statusLines).toContain('?? u.txt');
    expect(result.summary.statLines.join('\n')).toContain('a.txt');
    expect(result.summary.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('custom:与 uncommitted 同一份摘要', async () => {
    const result = await collectReviewSummary(repo, { kind: 'custom', instructions: 'x' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.statusLines).toContain('?? u.txt');
  });

  it('uncommitted:干净工作树报 clean-tree,不烧一轮', async () => {
    const result = await collectReviewSummary(clean, { kind: 'uncommitted' });
    expect(result).toEqual({ ok: false, reason: 'clean-tree' });
  });

  it('custom:干净工作树同样报 clean-tree', async () => {
    const result = await collectReviewSummary(clean, { kind: 'custom', instructions: 'x' });
    expect(result).toEqual({ ok: false, reason: 'clean-tree' });
  });

  it('uncommitted:空仓只有 untracked 也能审', async () => {
    const result = await collectReviewSummary(emptyRepo, { kind: 'uncommitted' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.statusLines).toContain('?? u.txt');
    expect(result.summary.headSha).toBeUndefined();
  });

  it('commit:短 sha 也能审,摘要含 oneline 标题与全 SHA', async () => {
    const head = await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo });
    const result = await collectReviewSummary(repo, { kind: 'commit', sha: head.stdout.trim() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.commitOneline).toContain('second: add b');
    expect(result.summary.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.summary.statLines.join('\n')).toContain('b.txt');
  });

  it('commit:不存在的 sha 报 unknown-commit(带原 sha)', async () => {
    const result = await collectReviewSummary(repo, { kind: 'commit', sha: 'deadbeef' });
    expect(result).toEqual({ ok: false, reason: 'unknown-commit', sha: 'deadbeef' });
  });

  it('commit:空仓同样报 unknown-commit', async () => {
    const result = await collectReviewSummary(emptyRepo, { kind: 'commit', sha: 'deadbeef' });
    expect(result).toEqual({ ok: false, reason: 'unknown-commit', sha: 'deadbeef' });
  });

  it('base:merge-base 落在分叉提交上,计数为 1', async () => {
    const result = await collectReviewSummary(repo, { kind: 'base', branch: 'feature' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = await execa('git', ['rev-parse', 'main~1'], { cwd: repo });
    expect(result.summary.mergeBaseSha).toBe(first.stdout.trim());
    expect(result.summary.commitCount).toBe(1);
    expect(result.summary.logLines.join('\n')).toContain('second: add b');
  });

  it('base:当前分支报 same-branch', async () => {
    const result = await collectReviewSummary(repo, { kind: 'base', branch: 'main' });
    expect(result).toEqual({ ok: false, reason: 'same-branch', branch: 'main' });
  });

  it('base:不存在的分支报 unknown-branch(sha/tag 也不认)', async () => {
    const result = await collectReviewSummary(repo, { kind: 'base', branch: 'nope' });
    expect(result).toEqual({ ok: false, reason: 'unknown-branch', branch: 'nope' });
  });

  it('base:无共同祖先报 no-merge-base', async () => {
    const result = await collectReviewSummary(orphanRepo, { kind: 'base', branch: 'lonely' });
    expect(result).toEqual({ ok: false, reason: 'no-merge-base', branch: 'lonely' });
  });

  it('非 git 目录报 no-repo', async () => {
    const result = await collectReviewSummary(plain, { kind: 'uncommitted' });
    expect(result).toEqual({ ok: false, reason: 'no-repo' });
  });
});
