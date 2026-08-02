import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import process from 'node:process';
import { App } from './ui/App.js';
import { AuthWizard } from './ui/AuthWizard.js';
import { bootstrap } from './app/bootstrap.js';
import { headlessAsker, renderHeadless } from './app/headless.js';
import { ConfigError, MissingKeyError, loadConfig, loadRawConfig, resolveProvider } from './config/load.js';
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS } from './config/providers.js';
import type { PartialConfig, PermissionMode } from './config/schema.js';
import { listModels } from './model/registry.js';
import { AmbiguousSessionError, SessionNotFoundError, SessionStore } from './session/store.js';
import { SessionPicker } from './ui/SessionPicker.js';
import { resumeOverrides } from './app/resume.js';
import { APP_NAME } from './config/paths.js';
import { detectLocale, setLocale, t } from './i18n/index.js';

interface GlobalFlags {
  provider?: string;
  model?: string;
  cwd?: string;
  readonly?: boolean;
  acceptEdits?: boolean;
  yolo?: boolean;
  maxContext?: string;
  maxSteps?: string;
  noMcp?: boolean;
}

/** 根命令特有的 flags(`-p`、会话恢复相关)。 */
interface MainFlags extends GlobalFlags {
  print?: string;
  json?: boolean;
  resume?: string | boolean;
  continue?: boolean;
  forkSession?: boolean;
}

function modeFromFlags(flags: GlobalFlags): PermissionMode | undefined {
  if (flags.yolo) return 'yolo';
  if (flags.acceptEdits) return 'acceptEdits';
  if (flags.readonly) return 'readonly';
  return undefined;
}

function overridesFromFlags(flags: GlobalFlags): PartialConfig {
  const overrides: PartialConfig = {};
  if (flags.provider) overrides.provider = flags.provider;
  if (flags.model) overrides.model = flags.model;
  const mode = modeFromFlags(flags);
  if (mode) overrides.permissionMode = mode;
  if (flags.maxContext) overrides.maxContext = Number(flags.maxContext);
  if (flags.maxSteps) overrides.maxSteps = Number(flags.maxSteps);
  return overrides;
}

const program = new Command();

program
  .name(APP_NAME)
  .description(t('cli.appDesc'))
  .version('0.1.0')
  .option('-p, --print <prompt>', t('cli.opt.print'))
  .option('--json', t('cli.opt.json'))
  .option('--provider <id>', t('cli.opt.provider', { list: BUILTIN_PROVIDER_IDS.join(', ') }))
  .option('-m, --model <id>', t('cli.opt.model'))
  .option('-C, --cwd <dir>', t('cli.opt.cwd'))
  .option('--readonly', t('cli.opt.readonly'))
  .option('--accept-edits', t('cli.opt.acceptEdits'))
  .option('--yolo', t('cli.opt.yolo'))
  .option('--max-context <tokens>', t('cli.opt.maxContext'))
  .option('--max-steps <n>', t('cli.opt.maxSteps'))
  .option('--no-mcp', t('cli.opt.noMcp'))
  .option('-r, --resume [sessionId]', t('cli.opt.resume'))
  .option('-c, --continue', t('cli.opt.continue'))
  .option('--fork-session', t('cli.opt.forkSession'))
  .action(async (opts) => {
    await runMain(opts as MainFlags);
  });

program
  .command('auth')
  .alias('login')
  .description(t('cli.cmd.auth'))
  .action(async () => {
    if (!process.stdin.isTTY) {
      fail(new Error(t('auth.needsTty')));
      return;
    }
    await applyConfigLocale(process.cwd());
    const instance = render(<AuthWizard />);
    await instance.waitUntilExit();
  });

program
  .command('models')
  .description(t('cli.cmd.models'))
  .option('--provider <id>', t('cli.opt.provider', { list: BUILTIN_PROVIDER_IDS.join(', ') }))
  .action(async (opts: { provider?: string }) => {
    const root = process.cwd();
    try {
      const { config } = await loadConfig({ root, overrides: opts.provider ? { provider: opts.provider } : {} });
      const provider = resolveProvider(config);
      const models = await listModels(provider);
      process.stdout.write(`${provider.label} (${provider.baseURL})\n`);
      for (const model of models) {
        const marker = model.id === provider.model ? '*' : ' ';
        process.stdout.write(`${marker} ${model.id}\n`);
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('providers')
  .description(t('cli.cmd.providers'))
  .action(async () => {
    // 密钥可能来自环境变量,也可能是 `auth` 向导写进配置文件的——两处都认,
    // 与运行时的实际解析一致;配置读不了(损坏等)时降级为只看环境变量。
    const configured: Record<string, { apiKey?: string } | undefined> = await loadConfig({
      root: process.cwd(),
      overrides: {},
    })
      .then(({ config }) => config.providers)
      .catch(() => ({}));
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      const hasKey =
        preset.apiKeyEnv.some((name) => process.env[name]) || Boolean(configured[id]?.apiKey);
      process.stdout.write(
        `${hasKey ? '✓' : ' '} ${id.padEnd(12)} ${preset.label}\n` +
          `    ${preset.baseURL}\n` +
          `    key: ${preset.apiKeyEnv.join(' | ')}${hasKey ? '' : t('cli.keyNotSet')}\n`,
      );
    }
  });

program
  .command('sessions')
  .description(t('cli.cmd.sessions'))
  .option('--all', t('cli.opt.sessionsAll'))
  .action(async (opts: { all?: boolean }) => {
    const sessions = await SessionStore.list(opts.all ? undefined : process.cwd());
    if (sessions.length === 0) {
      process.stdout.write(`${t('cli.noSessions')}\n`);
      return;
    }
    for (const meta of sessions) {
      process.stdout.write(
        `${meta.id.slice(0, 8)}  ${meta.updatedAt.slice(0, 16).replace('T', ' ')}  ` +
          `${meta.provider}/${meta.model}  ${t('cli.msgs', { n: meta.messageCount })}  ${meta.title}\n`,
      );
    }
  });

program
  .command('config')
  .description(t('cli.cmd.config'))
  .action(async () => {
    const root = process.cwd();
    try {
      const loaded = await loadConfig({ root });
      process.stdout.write(`${t('cli.sources', { list: loaded.sources.join(', ') || t('cli.defaultsOnly') })}\n\n`);
      process.stdout.write(
        `${JSON.stringify(
          { ...loaded.config, providers: redactKeys(loaded.config.providers) },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      // 缺少 API key 不能阻止 `config` 展示配置——
      // 看到配置通常是修复 key 的第一步。
      if (error instanceof ConfigError) {
        process.stderr.write(`${t('cli.warning', { message: error.message })}\n\n`);
        const { config, sources } = await loadRawConfig({ root });
        process.stdout.write(`${t('cli.sources', { list: sources.join(', ') || t('cli.defaultsOnly') })}\n\n`);
        process.stdout.write(
          `${JSON.stringify({ ...config, providers: redactKeys(config.providers) }, null, 2)}\n`,
        );
        return;
      }
      fail(error);
    }
  });

/** 尽力而为:在完整配置加载前也尊重配置中的 `language`。 */
async function applyConfigLocale(root: string): Promise<void> {
  try {
    const { config } = await loadRawConfig({ root });
    if (config.language !== 'auto') setLocale(detectLocale(config.language));
  } catch {
    // 配置读不了也不应阻止向导;环境变量检测的结果继续有效。
  }
}

/**
 * 解析要恢复的会话。语义对齐 Claude Code:
 * - `-r <id前缀>`:唯一前缀匹配,未命中/歧义直接报错退出(不静默开新会话)。
 * - `-r`(无参,TTY):交互式选择器;esc/无会话 → 新会话。
 * - `-r`(无参,headless/非 TTY):退化为"最新"。
 * - `-c`:本工作区最新会话;没有 → 提示后开新会话。
 *
 * 返回 undefined 表示不恢复;显式失败直接抛错(由调用方 fail)。
 */
async function resolveResume(flags: MainFlags, root: string): Promise<SessionStore | undefined> {
  if (typeof flags.resume === 'string') {
    // 限定本工作区:恢复别处的会话会让它的 meta.root 继续指向旧项目,
    // 之后两边的 `mojocode sessions` 都列不到它(用 -C 切到那个目录即可)。
    const id = await SessionStore.resolveId(flags.resume, { root });
    return SessionStore.open(id);
  }

  const interactive = process.stdin.isTTY && typeof flags.print !== 'string';
  if (flags.resume === true && interactive) {
    const metas = await SessionStore.list(root);
    if (metas.length === 0) {
      process.stderr.write(`${t('cli.noResume')}\n`);
      return undefined;
    }
    let picked: string | undefined;
    const instance = render(
      <SessionPicker
        sessions={metas}
        onSelect={(id) => {
          picked = id;
        }}
      />,
      { exitOnCtrlC: true },
    );
    await instance.waitUntilExit();
    return picked ? SessionStore.open(picked) : undefined;
  }

  if (flags.resume === true || flags.continue) {
    const latest = await SessionStore.latest(root);
    if (!latest) process.stderr.write(`${t('cli.noResume')}\n`);
    return latest;
  }

  return undefined;
}

async function runMain(flags: MainFlags): Promise<void> {
  const root = flags.cwd ? (await import('node:path')).resolve(flags.cwd) : process.cwd();
  await applyConfigLocale(root); // 选择器与报错也要本地化,尽早生效

  // 恢复要在 loadConfig 之前解析:会话 meta/state 会并入配置层
  //(优先级:CLI flags > 会话身份 > env/配置文件)。
  let resume: SessionStore | undefined;
  try {
    resume = await resolveResume(flags, root);
  } catch (error) {
    if (error instanceof AmbiguousSessionError) {
      return fail(new Error(t('cli.sessionAmbiguous', { id: error.query, list: error.matches.join(', ') })));
    }
    if (error instanceof SessionNotFoundError) {
      return fail(new Error(t('cli.sessionNotFound', { id: error.query })));
    }
    return fail(error);
  }

  const overrides: PartialConfig = {
    ...(resume ? resumeOverrides(resume.meta, resume.state, { ...flags, mode: modeFromFlags(flags) }) : {}),
    ...overridesFromFlags(flags),
  };

  let loaded;
  try {
    loaded = await loadConfig({ root, overrides });
  } catch (error) {
    // 交互式会话且到处都找不到 key:提供一次配置向导,然后重试。
    // headless(-p)和非 TTY 运行则直接快速失败。
    const interactive = process.stdin.isTTY && typeof flags.print !== 'string';
    if (!(error instanceof MissingKeyError) || !interactive) return fail(error);

    process.stderr.write(`${t('auth.noKeyLaunch')}\n`);
    const wizard = render(<AuthWizard />);
    await wizard.waitUntilExit();
    try {
      loaded = await loadConfig({ root, overrides });
    } catch (retryError) {
      return fail(retryError);
    }
  }

  if (loaded.config.language !== 'auto') {
    setLocale(detectLocale(loaded.config.language));
  }

  const headless = typeof flags.print === 'string';

  const session = await bootstrap({
    root,
    loaded,
    ask: headlessAsker(loaded.config.permissionMode),
    resume,
    fork: flags.forkSession === true,
    skipMcp: flags.noMcp === true,
    onMcpStatus: (status) => {
      if (!status.connected && !headless) {
        process.stderr.write(`${t('cli.mcpFailed', { name: status.name, error: status.error ?? '?' })}\n`);
      }
    },
  });

  // 启动清理:超过保留期未活动的会话文件后台删除,失败不打扰。
  void SessionStore.cleanup({
    days: loaded.config.cleanupPeriodDays,
    keepIds: resume ? [resume.id, session.store.id] : [session.store.id],
  }).catch(() => {});

  if (headless) {
    renderHeadless(session, {
      json: flags.json === true,
      stream: process.stdout,
      errStream: process.stderr,
    });
    await session.agent.run(flags.print!);
    await session.dispose();
    process.stdout.write('\n');
    return;
  }

  if (!process.stdin.isTTY) {
    process.stderr.write(`${t('cli.needsTty')}\n`);
    process.exitCode = 1;
    await session.dispose();
    return;
  }

  // 关掉 ink 默认的"ctrl+c 立即退出":它会在 useInput 之前吞掉按键,
  // 让 App 里"连按两次 ctrl+c 退出"的逻辑永远收不到输入。
  const instance = render(<App session={session} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
  await session.dispose();
}

function redactKeys(providers: Record<string, { apiKey?: string }>): unknown {
  return Object.fromEntries(
    Object.entries(providers).map(([id, value]) => [
      id,
      value.apiKey ? { ...value, apiKey: '***' } : value,
    ]),
  );
}

function fail(error: unknown): void {
  const message =
    error instanceof ConfigError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(error);
});
