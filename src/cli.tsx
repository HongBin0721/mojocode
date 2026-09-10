import { Command } from 'commander';
import path from 'node:path';
import process from 'node:process';
import { bootstrap } from './app/bootstrap.js';
import { renderHeadless } from './app/headless.js';
import { detectTuiRuntime, reexecWithFfi } from './app/runtime.js';
import { ConfigError, MissingKeyError, loadConfig, loadRawConfig, resolveProvider } from './config/load.js';
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS, providerModelIsVision } from './config/providers.js';
import { searchBackendSchema, type PartialConfig } from './config/schema.js';
import { listModels } from './model/registry.js';
import { AmbiguousSessionError, SessionNotFoundError, SessionStore } from './session/store.js';
import { APP_NAME } from './config/paths.js';
import { packageVersion } from './config/version.js';
import { formatDoctor, runDoctor } from './app/doctor.js';
import { detectLocale, setLocale, t } from './i18n/index.js';
import { INIT_PROMPT } from './agent/init.js';
import { expandAtReferences, warnableSkips, type ImageAttachment } from './app/attachments.js';
import { parseSlashInvocation } from './skills/invocation.js';
import { discoverExtensions } from './extensions/loader.js';
import { parseExtensionFlags } from './extensions/flags.js';
import { installPackage, nameOf, removePackage, resolvePackages } from './extensions/packages.js';

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
  maxContext?: string;
  maxSteps?: string;
  /**
   * `--no-mcp` 的解析结果。commander 对 `--no-` 前缀的选项写的是**正名**:
   * 不带 flag 时 `mcp` 为 true,带了才是 false——`noMcp` 这个字段它从来
   * 不会赋值(写成 `noMcp === true` 的判断等于恒假,静默失效)。
   */
  mcp?: boolean;
  searchBackend?: string;
  /** `-e <path>`(可重复):磁盘扩展的文件或目录。 */
  extension?: string[];
  /** `-X name[=value]`(可重复):给扩展的 flag(registerFlag / getFlag)。 */
  flag?: string[];
}



/** 根命令特有的 flags(`-p`、会话恢复相关)。 */
interface MainFlags extends GlobalFlags {
  print?: string;
  json?: boolean;
  resume?: string | boolean;
  continue?: boolean;
  forkSession?: boolean;
}

function overridesFromFlags(flags: GlobalFlags): PartialConfig {
  const overrides: PartialConfig = {};
  if (flags.provider) overrides.provider = flags.provider;
  if (flags.model) overrides.model = flags.model;
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

/** commander 的可重复选项收集器:`-e a -e b` → ['a', 'b']。 */
function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * 子命令的工作区根。
 *
 * 根命令上已有 `-C`,commander 会让父级抢先接住同名选项的值,子命令自己
 * 声明的那个只会拿到 undefined。所以一律回落读父级,`mojocode -C dir doctor`
 * 与 `mojocode doctor -C dir` 两种写法都生效。每个子命令都要这一句。
 */
function workspaceRoot(): string {
  const globals = program.opts() as MainFlags;
  return globals.cwd ? path.resolve(globals.cwd) : process.cwd();
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
  .option('--max-context <tokens>', t('cli.opt.maxContext'))
  .option('--max-steps <n>', t('cli.opt.maxSteps'))
  .option('--no-mcp', t('cli.opt.noMcp'))
  .option('-e, --extension <path>', t('cli.opt.extension'), collectRepeatable, [])
  .option('-X, --flag <name[=value]>', t('cli.opt.flag'), collectRepeatable, [])
  .option('--search-backend <id>', t('cli.opt.searchBackend'))
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
    // 根命令也声明了 --provider,commander 会把它吞给根(同 doctor 的 -C/--json
    // 坑):子命令自己的 opts 拿不到时从 program.opts() 兜底。
    const providerId = opts.provider ?? (program.opts() as { provider?: string }).provider;
    try {
      const { config } = await loadConfig({ root, overrides: providerId ? { provider: providerId } : {} });
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
    // 必须用 loadRawConfig:loadConfig 会顺带解析默认厂商,默认厂商缺 key 时
    // 抛 MissingKeyError,catch 把整张 providers 表(含自定义条目)一起丢掉。
    const configured: Record<string, { apiKey?: string; baseURL?: string; apiKeyEnv?: string }> =
      await loadRawConfig({
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
      delete configured[id];
    }
    // 内置之外剩下的就是自定义条目(auth 向导的"其他"入口或手写配置)。
    for (const [id, def] of Object.entries(configured)) {
      if (!def.baseURL) continue;
      const hasKey =
        Boolean(def.apiKey) ||
        (def.apiKeyEnv ? Boolean(process.env[def.apiKeyEnv]) : false);
      process.stdout.write(
        `${hasKey ? '✓' : ' '} ${id.padEnd(12)} ${def.baseURL}\n` +
          `    key: ${def.apiKeyEnv ?? 'providers.' + id + '.apiKey'}${hasKey ? '' : t('cli.keyNotSet')}\n`,
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
    // `--json` 与 `-C` 同理(见 workspaceRoot):父级抢先,一律回落读它。
    const globals = program.opts() as MainFlags;
    const root = workspaceRoot();
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
  .command('install <source>')
  .description(t('cli.cmd.install'))
  .option('--local', t('cli.opt.packageLocal'))
  .action(async (source: string, opts: { local?: boolean }) => {
    const root = workspaceRoot();
    try {
      const result = await installPackage(source, { root, scope: opts.local ? 'project' : 'global' });
      process.stdout.write(
        `${t('cli.installed', { name: nameOf(result.source), dir: result.dir, file: result.configFile })}\n`,
      );
    } catch (error) {
      fail(error);
    }
  });

program
  // 刻意没有 `--local`:卸载两层都清(见 removePackage),用户不必记得当初
  // 是从哪一层装的。
  .command('remove <name>')
  .description(t('cli.cmd.remove'))
  .action(async (name: string) => {
    const root = workspaceRoot();
    try {
      const { config } = await loadRawConfig({ root });
      const result = await removePackage(name, { root, configured: config.packages });
      if (!result.removed) {
        process.stderr.write(`${t('cli.removeNotFound', { name })}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${t('cli.removed', { name, file: result.configFiles.join(', ') })}\n`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('extensions')
  .description(t('cli.cmd.extensions'))
  .action(async () => {
    const root = workspaceRoot();
    const globals = program.opts() as MainFlags;
    try {
      const { config } = await loadRawConfig({ root });
      const resolved = await resolvePackages(config.packages, { root });
      const { extensions: found, notFound } = await discoverExtensions({
        root,
        extraPaths: globals.extension ?? [],
        packages: resolved.packages,
      });
      for (const file of notFound) {
        process.stderr.write(`! ${t('notice.extensionPathMissing', { file })}\n`);
      }
      if (found.length === 0 && config.packages.length === 0) {
        process.stdout.write(`${t('cli.noExtensions')}\n`);
        return;
      }
      if (found.length > 0) {
        process.stdout.write(`${t('cli.extensionsHeader')}\n`);
        for (const ext of found) {
          process.stdout.write(`  ${ext.id.padEnd(28)} ${ext.origin.padEnd(8)} ${ext.file}\n`);
        }
      }
      if (config.packages.length > 0) {
        process.stdout.write(`${t('cli.packagesHeader')}\n`);
        for (const pkg of resolved.packages) {
          process.stdout.write(`  ✓ ${nameOf(pkg.source).padEnd(26)} ${pkg.dir}\n`);
        }
        for (const spec of resolved.missing) {
          process.stdout.write(`${t('cli.packageMissingRow', { spec })}\n`);
        }
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('config')
  .description(t('cli.cmd.config'))
  .action(async () => {
    const root = process.cwd();
    // 加载期提示最该出现在这里:
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
    // 归档会话不进恢复选择器(带精确 id 的 --resume <id> 仍可打开)。
    const metas = (await SessionStore.list(root)).filter((m) => !m.archivedAt);
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

  // 恢复要在 loadConfig 之前解析:`-r` 裸用时要开选择器,而选择器是 TUI 的
  // 一部分,得在配置定稿、会话建起来之前问完。恢复的只有对话内容——
  // provider/model 不还原,始终用当前配置解析出的模型。
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

  const overrides: PartialConfig = overridesFromFlags(flags);

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

  const session = await bootstrap({
    root,
    loaded,
    resume,
    fork: flags.forkSession === true,
    ...(flags.mcp === false ? { disabledExtensions: ['mcp'] } : {}),
    extensionPaths: flags.extension ?? [],
    extensionFlags: parseExtensionFlags(flags.flag),
    mode: headless ? 'print' : 'tui',
    // MCP 连接失败经 bus notice 呈现(headless 渲染器也认 notice 事件),
    // 裸 stderr 在 TUI 下会写进 alt-screen。
  });

  // 加载期提示。`--json` 下不打:
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
    // `-p "/init"` 与 TUI 的 /init 对齐:替换为完整指令。
    const isInit = flags.print!.trim() === '/init';
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
        // 非视觉模型以引用模式展开 @图(判定与 Agent.prepareUserMessage 共用
        // providerModelIsVision,理由见 App.tsx 的同款注释);粘贴图 headless
        // 不支持,无需处理。
        imageMode: providerModelIsVision(session.provider, session.config)
          ? 'inline'
          : 'reference',
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
