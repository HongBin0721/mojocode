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
import { SessionStore } from './session/store.js';
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
  .action(async (opts) => {
    await runMain(opts as GlobalFlags & { print?: string; json?: boolean; resume?: string | boolean });
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
  .action(() => {
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      const hasKey = preset.apiKeyEnv.some((name) => process.env[name]);
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
      // A missing API key must not stop `config` from showing the config —
      // seeing it is usually the first step in fixing the key.
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

/** Best-effort: honour the config's `language` even before full config load. */
async function applyConfigLocale(root: string): Promise<void> {
  try {
    const { config } = await loadRawConfig({ root });
    if (config.language !== 'auto') setLocale(detectLocale(config.language));
  } catch {
    // An unreadable config shouldn't stop the wizard; env detection stands.
  }
}

async function runMain(
  flags: GlobalFlags & { print?: string; json?: boolean; resume?: string | boolean },
): Promise<void> {
  const root = flags.cwd ? (await import('node:path')).resolve(flags.cwd) : process.cwd();

  let loaded;
  try {
    loaded = await loadConfig({ root, overrides: overridesFromFlags(flags) });
  } catch (error) {
    // Interactive session with no key anywhere: offer the setup wizard once,
    // then retry. Headless (-p) and non-TTY runs fail fast instead.
    const interactive = process.stdin.isTTY && typeof flags.print !== 'string';
    if (!(error instanceof MissingKeyError) || !interactive) return fail(error);

    await applyConfigLocale(root);
    process.stderr.write(`${t('auth.noKeyLaunch')}\n`);
    const wizard = render(<AuthWizard />);
    await wizard.waitUntilExit();
    try {
      loaded = await loadConfig({ root, overrides: overridesFromFlags(flags) });
    } catch (retryError) {
      return fail(retryError);
    }
  }

  if (loaded.config.language !== 'auto') {
    setLocale(detectLocale(loaded.config.language));
  }

  let resume: SessionStore | undefined;
  if (flags.resume) {
    resume =
      typeof flags.resume === 'string'
        ? await SessionStore.open(flags.resume).catch(() => undefined)
        : await SessionStore.latest(root);
    if (!resume) {
      process.stderr.write(`${t('cli.noResume')}\n`);
    }
  }

  const headless = typeof flags.print === 'string';

  const session = await bootstrap({
    root,
    loaded,
    ask: headlessAsker(loaded.config.permissionMode),
    resume,
    skipMcp: flags.noMcp === true,
    onMcpStatus: (status) => {
      if (!status.connected && !headless) {
        process.stderr.write(`${t('cli.mcpFailed', { name: status.name, error: status.error ?? '?' })}\n`);
      }
    },
  });

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

  const instance = render(<App session={session} />);
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
