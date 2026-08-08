import { Command } from 'commander';
import process from 'node:process';
import { bootstrap } from './app/bootstrap.js';
import { headlessAsker, renderHeadless } from './app/headless.js';
import { detectTuiRuntime, reexecWithFfi } from './app/runtime.js';
import { spawnManagedServer, type SpawnedServer } from './app/server-launch.js';
import type { SessionHandle } from './app/session-handle.js';
import { connectRemote } from './client/remote.js';
import { createPermissionBroker, startServer } from './server/serve.js';
import { ConfigError, MissingKeyError, loadConfig, loadRawConfig, resolveProvider } from './config/load.js';
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS } from './config/providers.js';
import {
  approvalPolicySchema,
  presetById,
  sandboxModeSchema,
  searchBackendSchema,
  type PartialConfig,
  type Permissions,
} from './config/schema.js';
import { listModels } from './model/registry.js';
import { AmbiguousSessionError, SessionNotFoundError, SessionStore } from './session/store.js';
import { resumeOverrides } from './app/resume.js';
import { APP_NAME } from './config/paths.js';
import { packageVersion } from './config/version.js';
import { formatDoctor, runDoctor } from './app/doctor.js';
import { detectLocale, setLocale, t } from './i18n/index.js';
import { INIT_PROMPT } from './agent/init.js';
import { expandAtReferences, warnableSkips, type ImageAttachment } from './app/attachments.js';
import { parseSlashInvocation } from './skills/invocation.js';

type TuiModule = typeof import('./ui/tui.js');

/**
 * TUI 运行时门 + 懒加载。TUI 模块(→ kit → @opentui/core)在模块加载期就
 * 需要原生 FFI,绝不能静态 import——`-p` 与全部子命令要在 Node 22 上照常
 * 工作。Node ≥26.1 缺 flag 时整个进程带 `--experimental-ffi` 重执行;
 * 跑不了时向 stderr 给指引、置退出码并返回 undefined(调用方直接 return)。
 */
async function loadTuiOrExplain(): Promise<TuiModule | undefined> {
  const runtime = await detectTuiRuntime();
  if (runtime.kind === 'reexec') {
    // 重执行会把整个 CLI 从头跑一遍;此处尚未启动任何子进程,直接以子进程
    // 的退出码收尾。这是全代码库唯一一处 process.exit——没有定时器要等。
    process.exit(reexecWithFfi());
  }
  if (runtime.kind === 'unsupported') {
    process.stderr.write(`${runtime.message}\n`);
    process.exitCode = 1;
    return undefined;
  }
  return import('./ui/tui.js');
}

interface GlobalFlags {
  provider?: string;
  model?: string;
  cwd?: string;
  plan?: boolean;
  sandbox?: string;
  askForApproval?: string;
  fullAuto?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  maxContext?: string;
  maxSteps?: string;
  /**
   * `--no-mcp` 的解析结果。commander 对 `--no-` 前缀的选项写的是**正名**:
   * 不带 flag 时 `mcp` 为 true,带了才是 false——`noMcp` 这个字段它从来
   * 不会赋值(写成 `noMcp === true` 的判断等于恒假,静默失效)。
   */
  mcp?: boolean;
  searchBackend?: string;
}

/** 根命令特有的 flags(`-p`、会话恢复相关)。 */
interface MainFlags extends GlobalFlags {
  print?: string;
  json?: boolean;
  resume?: string | boolean;
  continue?: boolean;
  forkSession?: boolean;
  /** 连接到外部已运行的 server(URL),不再自行拉起受管子进程。 */
  attach?: string;
}

/**
 * 两轴 flags 的合成:预设 flag 先落底,显式的 -s / -a 单独覆盖对应的轴。
 * 与 Codex 同名同义:--full-auto = auto 预设,--dangerously-bypass-approvals-and-sandbox
 * = full-access 预设。取值非法时直接报错退出,而不是静默落回默认。
 */
function permissionsFromFlags(flags: GlobalFlags): Partial<Permissions> {
  const out: Partial<Permissions> = {};
  if (flags.fullAuto) Object.assign(out, presetById('auto'));
  if (flags.dangerouslyBypassApprovalsAndSandbox) Object.assign(out, presetById('full-access'));
  if (flags.sandbox) {
    const parsed = sandboxModeSchema.safeParse(flags.sandbox);
    if (!parsed.success) {
      throw new ConfigError(
        `Invalid --sandbox "${flags.sandbox}". Valid: ${sandboxModeSchema.options.join(', ')}`,
      );
    }
    out.sandbox = parsed.data;
  }
  if (flags.askForApproval) {
    const parsed = approvalPolicySchema.safeParse(flags.askForApproval);
    if (!parsed.success) {
      throw new ConfigError(
        `Invalid --ask-for-approval "${flags.askForApproval}". Valid: ${approvalPolicySchema.options.join(', ')}`,
      );
    }
    out.approval = parsed.data;
  }
  return out;
}

function overridesFromFlags(flags: GlobalFlags): PartialConfig {
  const overrides: PartialConfig = {};
  if (flags.provider) overrides.provider = flags.provider;
  if (flags.model) overrides.model = flags.model;
  const perms = permissionsFromFlags(flags);
  if (perms.sandbox) overrides.sandbox = perms.sandbox;
  if (perms.approval) overrides.approval = perms.approval;
  if (flags.plan) overrides.plan = true;
  if (flags.maxContext) overrides.maxContext = Number(flags.maxContext);
  if (flags.maxSteps) overrides.maxSteps = Number(flags.maxSteps);
  if (flags.searchBackend) {
    const parsed = searchBackendSchema.safeParse(flags.searchBackend);
    if (!parsed.success) {
      throw new ConfigError(
        `Invalid --search-backend "${flags.searchBackend}". Valid: ${searchBackendSchema.options.join(', ')}`,
      );
    }
    overrides.search = { backend: parsed.data };
  }
  return overrides;
}

/**
 * 从 argv 里手动捞 -C/--cwd:此刻 commander 还没解析,而项目级配置可能
 * 覆盖 language。捞不到就用 process.cwd(),差错也只影响语言检测。
 */
function cwdFromArgv(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-C' || arg === '--cwd') return argv[i + 1] ?? process.cwd();
    if (arg.startsWith('--cwd=')) return arg.slice('--cwd='.length);
  }
  return process.cwd();
}

// 语言必须在构建 commander 之前应用:所有命令/选项描述在下面构建时就用
// t() 求值,晚了的话 `--help` 和 models/sessions 等子命令就只认环境变量,
// 设置面板保存的语言偏好在这些入口上形同虚设——"下次打开恢复默认"的观感即源于此。
// runMain 里的再次应用仍保留:它拿的是完整解析后的配置(含 CLI 覆盖项)。
await applyConfigLocale(cwdFromArgv(process.argv));

const program = new Command();

program
  .name(APP_NAME)
  .description(t('cli.appDesc'))
  .version(packageVersion())
  .option('-p, --print <prompt>', t('cli.opt.print'))
  .option('--json', t('cli.opt.json'))
  .option('--provider <id>', t('cli.opt.provider', { list: BUILTIN_PROVIDER_IDS.join(', ') }))
  .option('-m, --model <id>', t('cli.opt.model'))
  .option('-C, --cwd <dir>', t('cli.opt.cwd'))
  .option('--plan', t('cli.opt.plan'))
  .option('-s, --sandbox <mode>', t('cli.opt.sandbox'))
  .option('-a, --ask-for-approval <policy>', t('cli.opt.approval'))
  .option('--full-auto', t('cli.opt.fullAuto'))
  .option('--dangerously-bypass-approvals-and-sandbox', t('cli.opt.dangerous'))
  .option('--max-context <tokens>', t('cli.opt.maxContext'))
  .option('--max-steps <n>', t('cli.opt.maxSteps'))
  .option('--no-mcp', t('cli.opt.noMcp'))
  .option('--search-backend <id>', t('cli.opt.searchBackend'))
  .option('-r, --resume [sessionId]', t('cli.opt.resume'))
  .option('-c, --continue', t('cli.opt.continue'))
  .option('--fork-session', t('cli.opt.forkSession'))
  .option('--attach <url>', t('cli.opt.attach'))
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
    const tui = await loadTuiOrExplain();
    if (!tui) return;
    await tui.runAuthWizard();
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
  .command('doctor')
  .description(t('cli.cmd.doctor'))
  .option('--json', t('cli.opt.doctorJson'))
  .option('--offline', t('cli.opt.doctorOffline'))
  .action(async (opts: { json?: boolean; offline?: boolean }) => {
    // 根命令上已有 -C 和 --json,commander 会让父级抢先接住同名选项的值,
    // 子命令自己声明的那个只会拿到 undefined。所以一律回落读父级,
    // `mojocode -C dir doctor` 与 `mojocode doctor -C dir` 两种写法都能生效。
    const globals = program.opts() as MainFlags;
    const root = globals.cwd ? (await import('node:path')).resolve(globals.cwd) : process.cwd();
    const json = opts.json === true || globals.json === true;
    await applyConfigLocale(root);
    try {
      const report = await runDoctor({ root, offline: opts.offline === true });
      process.stdout.write(
        json
          ? `${JSON.stringify(report, null, 2)}\n`
          : formatDoctor(report, {
              color: process.stdout.isTTY === true && !process.env.NO_COLOR,
            }),
      );
      // 有异常项时给非零退出码,这样 CI 里 `mojocode doctor` 能当门禁用。
      if (!report.healthy) process.exitCode = 1;
    } catch (error) {
      fail(error);
    }
  });

program
  .command('serve')
  .description(t('cli.cmd.serve'))
  .option('--host <host>', t('cli.opt.serveHost'), '127.0.0.1')
  .option('--port <port>', t('cli.opt.servePort'), '0')
  .option('--managed', t('cli.opt.serveManaged'))
  .action(async (opts: { host: string; port: string; managed?: boolean }) => {
    await runServe(opts);
  });

program
  .command('config')
  .description(t('cli.cmd.config'))
  .action(async () => {
    const root = process.cwd();
    // 加载期提示(旧版 permissionMode 的一次性转换等)最该出现在这里:
    // 想搞清楚"我的配置到底生效成什么样"的人就是来跑这条命令的。
    const showWarnings = (warnings: string[]): void => {
      for (const warning of warnings) process.stderr.write(`! ${warning}\n`);
      if (warnings.length > 0) process.stderr.write('\n');
    };
    try {
      const loaded = await loadConfig({ root });
      showWarnings(loaded.warnings);
      process.stdout.write(`${t('cli.sources', { list: loaded.sources.join(', ') || t('cli.defaultsOnly') })}\n\n`);
      process.stdout.write(`${JSON.stringify(redactConfig(loaded.config), null, 2)}\n`);
    } catch (error) {
      // 缺少 API key 不能阻止 `config` 展示配置——
      // 看到配置通常是修复 key 的第一步。
      if (error instanceof ConfigError) {
        process.stderr.write(`${t('cli.warning', { message: error.message })}\n\n`);
        const { config, sources, warnings } = await loadRawConfig({ root });
        showWarnings(warnings);
        process.stdout.write(`${t('cli.sources', { list: sources.join(', ') || t('cli.defaultsOnly') })}\n\n`);
        process.stdout.write(`${JSON.stringify(redactConfig(config), null, 2)}\n`);
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
async function resolveResume(
  flags: MainFlags,
  root: string,
  /** 已就绪的 TUI 模块;交互式选择器要用它。调用方已做过运行时门检查。 */
  tui: TuiModule | undefined,
): Promise<SessionStore | undefined> {
  if (typeof flags.resume === 'string') {
    // 限定本工作区:恢复别处的会话会让它的 meta.root 继续指向旧项目,
    // 之后两边的 `mojocode sessions` 都列不到它(用 -C 切到那个目录即可)。
    const id = await SessionStore.resolveId(flags.resume, { root });
    return SessionStore.open(id);
  }

  if (flags.resume === true && tui) {
    const metas = await SessionStore.list(root);
    if (metas.length === 0) {
      process.stderr.write(`${t('cli.noResume')}\n`);
      return undefined;
    }
    const picked = await tui.runSessionPicker(metas);
    return picked ? SessionStore.open(picked) : undefined;
  }

  if (flags.resume === true || flags.continue) {
    const latest = await SessionStore.latest(root);
    if (!latest) process.stderr.write(`${t('cli.noResume')}\n`);
    return latest;
  }

  return undefined;
}

/**
 * 把根命令的 flags 重放成受管 `serve` 子进程的参数。凭据(token)不在此列
 * ——它经环境变量传递;`-r`/`-c` 在父进程已解析成具体会话 id(交互式选择器
 * 只能在 TUI 侧跑),这里传定稿的 `--resume <id>`。
 */
function serveArgsFrom(flags: MainFlags, root: string, resumeId?: string): string[] {
  const args: string[] = ['--cwd', root];
  if (flags.provider) args.push('--provider', flags.provider);
  if (flags.model) args.push('--model', flags.model);
  if (flags.plan) args.push('--plan');
  if (flags.sandbox) args.push('--sandbox', flags.sandbox);
  if (flags.askForApproval) args.push('--ask-for-approval', flags.askForApproval);
  if (flags.fullAuto) args.push('--full-auto');
  if (flags.dangerouslyBypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (flags.maxContext) args.push('--max-context', flags.maxContext);
  if (flags.maxSteps) args.push('--max-steps', flags.maxSteps);
  if (flags.mcp === false) args.push('--no-mcp');
  if (flags.searchBackend) args.push('--search-backend', flags.searchBackend);
  if (resumeId) args.push('--resume', resumeId);
  if (flags.forkSession) args.push('--fork-session');
  return args;
}

/**
 * `mojocode serve`:bootstrap 一个会话并以 HTTP + SSE 暴露(进程模型对齐
 * opencode)。两种形态:
 *  - `--managed`:TUI 拉起的受管子进程——stdout 单行 JSON 握手,token 经
 *    环境变量注入,父进程退出(stdin 关闭)即自行收尾;
 *  - 独立运行:打印地址与 token,供 `mojocode --attach <url>` 连接。
 *
 * server 侧无 FFI,Node ≥ 22 即可;TUI 的 FFI 运行时门只管 client 进程。
 */
async function runServe(opts: { host: string; port: string; managed?: boolean }): Promise<void> {
  // 与 doctor 同一手法:共享 flags 声明在根命令上,从 program.opts() 读,
  // `mojocode -C dir serve` 与 `mojocode serve -C dir` 都生效。
  const globals = program.opts() as MainFlags;
  const root = globals.cwd ? (await import('node:path')).resolve(globals.cwd) : process.cwd();
  await applyConfigLocale(root);

  // serve 是非交互进程:`-r <id>` 接受显式 id(受管模式下父进程已把选择器
  // 的结果定稿成 id 传进来);裸 `-r` 与 `-c` 都退化为"本工作区最新"。
  let resume: SessionStore | undefined;
  try {
    if (typeof globals.resume === 'string') {
      resume = await SessionStore.open(await SessionStore.resolveId(globals.resume, { root }));
    } else if (globals.resume === true || globals.continue) {
      resume = await SessionStore.latest(root);
      if (!resume) process.stderr.write(`${t('cli.noResume')}\n`);
    }
  } catch (error) {
    if (error instanceof AmbiguousSessionError) {
      return fail(new Error(t('cli.sessionAmbiguous', { id: error.query, list: error.matches.join(', ') })));
    }
    if (error instanceof SessionNotFoundError) {
      return fail(new Error(t('cli.sessionNotFound', { id: error.query })));
    }
    return fail(error);
  }

  const flagPerms = permissionsFromFlags(globals);
  const overrides: PartialConfig = {
    ...(resume
      ? resumeOverrides(resume.meta, resume.state, {
          ...globals,
          permissions:
            flagPerms.sandbox && flagPerms.approval ? (flagPerms as Permissions) : undefined,
        })
      : {}),
    ...overridesFromFlags(globals),
  };

  let loaded;
  try {
    // MissingKeyError 直接快速失败:配置向导是交互流程,归 TUI 侧(父进程
    // 在拉起 server 之前已经跑过一轮 loadConfig + 向导)。
    loaded = await loadConfig({ root, overrides });
  } catch (error) {
    return fail(error);
  }
  if (loaded.config.language !== 'auto') {
    setLocale(detectLocale(loaded.config.language));
  }

  const broker = createPermissionBroker();
  const session = await bootstrap({
    root,
    loaded,
    ask: broker.ask,
    resume,
    fork: globals.forkSession === true,
    skipMcp: globals.mcp === false,
    onMcpStatus: (status) => {
      if (!status.connected) {
        process.stderr.write(`${t('cli.mcpFailed', { name: status.name, error: status.error ?? '?' })}\n`);
      }
    },
  });
  for (const warning of loaded.warnings) {
    process.stderr.write(`! ${warning}\n`);
  }
  void SessionStore.cleanup({
    days: loaded.config.cleanupPeriodDays,
    keepIds: resume ? [resume.id, session.store.id] : [session.store.id],
  }).catch(() => {});

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close().catch(() => {});
    await session.dispose().catch(() => {});
    // 受管/独立 server 都要显式退出:stdin 已 resume,事件循环不会自然清空。
    process.exit(0);
  };
  const server = await startServer({
    session,
    broker,
    host: opts.host,
    port: Number(opts.port),
    token: process.env.MOJOCODE_SERVER_TOKEN,
    onShutdown: () => void shutdown(),
  });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (opts.managed) {
    // 握手:单行 JSON。token 由父进程生成并经环境变量传入,不回显。
    process.stdout.write(`${JSON.stringify({ url: server.url })}\n`);
    // 父进程退出 → stdin 关闭 → 自行收尾,TUI 崩溃也不留孤儿 server。
    process.stdin.resume();
    process.stdin.on('end', () => void shutdown());
    process.stdin.on('close', () => void shutdown());
    // stdin EOF 在 Bun 下不总是触发(实测被 SIGKILL 的父进程留下过孤儿)。
    // 兜底:父进程死掉后本进程会被过继给 init/launchd,ppid 变化即收尾——
    // 运行时无关,轮询开销可忽略。
    const parentPid = process.ppid;
    const watchdog = setInterval(() => {
      if (process.ppid !== parentPid) void shutdown();
    }, 2000);
    watchdog.unref?.();
  } else {
    process.stdout.write(`${t('cli.serveListening', { url: server.url })}\n`);
    if (!process.env.MOJOCODE_SERVER_TOKEN) {
      process.stdout.write(`${t('cli.serveToken', { token: server.token })}\n`);
    }
  }
}

async function runMain(flags: MainFlags): Promise<void> {
  const root = flags.cwd ? (await import('node:path')).resolve(flags.cwd) : process.cwd();
  await applyConfigLocale(root); // 选择器与报错也要本地化,尽早生效

  const headless = typeof flags.print === 'string';

  // TTY 与 TUI 运行时的门放在最前面:`-r` 的交互式选择器本身就是 TUI,
  // 跑不了就该在这里一次性说明白退出(而不是先恢复会话再发现没界面可进);
  // 重执行(Node 补 flag)也会从头再跑一遍 CLI,不能先起 MCP 子进程。
  let tui: TuiModule | undefined;
  if (!headless) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`${t('cli.needsTty')}\n`);
      process.exitCode = 1;
      return;
    }
    tui = await loadTuiOrExplain();
    if (!tui) return;
  }

  // 恢复要在 loadConfig 之前解析:会话 meta/state 会并入配置层
  //(优先级:CLI flags > 会话身份 > env/配置文件)。
  let resume: SessionStore | undefined;
  try {
    resume = await resolveResume(flags, root, tui);
  } catch (error) {
    if (error instanceof AmbiguousSessionError) {
      return fail(new Error(t('cli.sessionAmbiguous', { id: error.query, list: error.matches.join(', ') })));
    }
    if (error instanceof SessionNotFoundError) {
      return fail(new Error(t('cli.sessionNotFound', { id: error.query })));
    }
    return fail(error);
  }

  // 只有两轴都被 flags 显式定死时,会话记录的权限才被完全压过。
  const flagPerms = permissionsFromFlags(flags);
  const overrides: PartialConfig = {
    ...(resume
      ? resumeOverrides(resume.meta, resume.state, {
          ...flags,
          permissions:
            flagPerms.sandbox && flagPerms.approval ? (flagPerms as Permissions) : undefined,
        })
      : {}),
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
    // interactive 蕴含非 headless,上面的门已确保 tui 就绪。
    await tui!.runAuthWizard();
    try {
      loaded = await loadConfig({ root, overrides });
    } catch (retryError) {
      return fail(retryError);
    }
  }

  if (loaded.config.language !== 'auto') {
    setLocale(detectLocale(loaded.config.language));
  }

  // 进程模型(对齐 opencode):TUI 默认是瘦客户端,agent 核心跑在受管的
  // `serve --managed` 子进程里(或经 --attach 连外部实例)。单进程模式只剩
  // 两条路:`-p` headless(管道语义、零 HTTP 开销),以及 MOJOCODE_NO_SERVER=1
  // 的排障逃生口。
  const inProcess = headless || process.env.MOJOCODE_NO_SERVER === '1';

  if (!inProcess) {
    let spawned: SpawnedServer | undefined;
    let handle: SessionHandle;
    try {
      if (flags.attach) {
        const token = process.env.MOJOCODE_SERVER_TOKEN;
        if (!token) return fail(new Error(t('cli.attachNeedsToken')));
        handle = await connectRemote({
          url: flags.attach.replace(/\/+$/, ''),
          token,
          ownsServer: false,
        });
      } else {
        // 配置警告与 MCP 失败提示由子进程 stderr 在握手前原样转发,这里不重复。
        spawned = await spawnManagedServer(serveArgsFrom(flags, root, resume?.id));
        handle = await connectRemote({ url: spawned.url, token: spawned.token, ownsServer: true });
      }
    } catch (error) {
      return fail(error);
    }
    await tui!.runTui(handle);
    await handle.dispose();
    await spawned?.waitExit();
    if (handle.agent.history.length > 0) {
      process.stdout.write(`${t('cli.resumeHint', { id: handle.store.id })}\n`);
    }
    return;
  }

  const session = await bootstrap({
    root,
    loaded,
    ask: headlessAsker({ sandbox: loaded.config.sandbox, approval: loaded.config.approval }),
    resume,
    fork: flags.forkSession === true,
    skipMcp: flags.mcp === false,
    onMcpStatus: (status) => {
      if (!status.connected && !headless) {
        process.stderr.write(`${t('cli.mcpFailed', { name: status.name, error: status.error ?? '?' })}\n`);
      }
    },
  });

  // 加载期提示(旧版 permissionMode 的一次性转换等)。`--json` 下不打:
  // stderr 是纯 NDJSON 流,掺普通文本会让逐行 JSON.parse 的消费方在第一行就炸。
  if (!(headless && flags.json === true)) {
    for (const warning of loaded.warnings) {
      process.stderr.write(`! ${warning}\n`);
    }
  }

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
    // `-p "/init"` 与 TUI 的 /init 对齐:替换为完整指令。headless 默认拒绝
    // 写入,提示用户带上放行 flag;仍照常运行,写入被拒时模型自会转述。
    // 走事件总线而不是直接写 stderr:`--json` 下 stderr 是纯 NDJSON 流,
    // 掺一行普通文本会让逐行 JSON.parse 的消费方在第一行就炸。
    const isInit = flags.print!.trim() === '/init';
    // /init 要写 AGENTS.md:headless 下确认一律被拒,所以除非写入本就免确认
    // (workspace-write 且非 untrusted),这一轮注定写不出文件,提前提示。
    const writesFree =
      loaded.config.sandbox !== 'read-only' &&
      loaded.config.approval !== 'untrusted' &&
      !loaded.config.plan;
    if (isInit && !writesFree) {
      session.bus.emit({ type: 'notice', level: 'warn', message: t('cli.initNeedsWrite') });
    }
    // `-p "/技能名 args"` 与 TUI 的斜杠技能调用对齐:runSkill 负责激活、
    // 展开、跑轮次(参数不做 @ 展开——技能参数是字面值)。不认识的斜杠
    // 文本照旧当普通 prompt 发出,与引入技能之前的行为一字不差。
    if (!isInit) {
      const invocation = parseSlashInvocation(flags.print!);
      if (invocation && session.skills.some((s) => s.name === invocation.name)) {
        await session.runSkill(invocation.name, invocation.args, {
          display: flags.print!.trim(),
        });
        await session.dispose();
        process.stdout.write('\n');
        return;
      }
    }
    // -p 同样支持 @文件引用(含图片):展开后发给模型,display 保留原文
    // (--json 的事件流与 --resume 回放看到的都是用户输入的原样)。
    let prompt = isInit ? INIT_PROMPT : flags.print!;
    let display = isInit ? '/init' : undefined;
    let images: ImageAttachment[] = [];
    if (!isInit) {
      const result = await expandAtReferences(prompt, {
        root: session.root,
        denyPath: session.config.permissions.denyPath,
      });
      const warnable = warnableSkips(result);
      if (warnable.length > 0) {
        session.bus.emit({
          type: 'notice',
          level: 'warn',
          message: t('notice.attachSkipped', {
            list: warnable.map((s) => `@${s.path} (${s.reason})`).join(', '),
          }),
        });
      }
      images = result.images;
      if (images.length > 0 && session.provider.sdk === 'deepseek') {
        session.bus.emit({ type: 'notice', level: 'warn', message: t('notice.providerNoVision') });
      }
      if (result.expanded !== prompt) {
        display = prompt;
        prompt = result.expanded;
      }
    }
    const runOptions = {
      ...(display !== undefined ? { display } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
    await session.agent.run(prompt, Object.keys(runOptions).length > 0 ? runOptions : undefined);
    await session.dispose();
    process.stdout.write('\n');
    return;
  }

  // runTui 内部关掉 exitOnCtrlC(保双 ctrl+c 退出),退出后把时间线 dump
  // 回主屏 scrollback(alternate screen 的内容随退出消失)。
  await tui!.runTui(session);
  await session.dispose();
  // 读 getter 而非启动时的快照:/new、/resume 会中途换 store,提示要指向
  // 退出那一刻真正在写的会话。空会话没有可恢复的内容,不打扰。
  if (session.agent.history.length > 0) {
    process.stdout.write(`${t('cli.resumeHint', { id: session.store.id })}\n`);
  }
}

function redactKeys(providers: Record<string, { apiKey?: string }>): unknown {
  return Object.fromEntries(
    Object.entries(providers).map(([id, value]) => [
      id,
      value.apiKey ? { ...value, apiKey: '***' } : value,
    ]),
  );
}

/** `mojocode config` 输出前打码所有落盘的 key:providers.*.apiKey 与 search.apiKey。 */
function redactConfig<T extends { providers: Record<string, { apiKey?: string }>; search: { apiKey?: string } }>(
  config: T,
): unknown {
  return {
    ...config,
    providers: redactKeys(config.providers),
    search: config.search.apiKey ? { ...config.search, apiKey: '***' } : config.search,
  };
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
