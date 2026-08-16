import stringWidth from 'string-width';
import { t } from '../../i18n/index.js';
import type { CheckLevel, DoctorReport } from './types.js';

const SYMBOLS: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };
const COLORS: Record<CheckLevel, string> = {
  ok: '\u001b[32m',
  warn: '\u001b[33m',
  fail: '\u001b[31m',
  info: '\u001b[90m',
};

/** 渲染成人读的报告。`color` 由调用方按 TTY / NO_COLOR 决定。 */
export function formatDoctor(report: DoctorReport, options: { color?: boolean } = {}): string {
  const color = options.color === true;
  const paint = (text: string, code: string): string => (color ? `${code}${text}\u001b[0m` : text);
  const lines: string[] = [`${t('doctor.title')} · v${report.version}`, ''];

  for (const section of report.sections) {
    lines.push(paint(section.title, '\u001b[1m'));
    const width = Math.max(0, ...section.checks.map((c) => stringWidth(c.label)));
    for (const check of section.checks) {
      const pad = ' '.repeat(Math.max(0, width - stringWidth(check.label)));
      const symbol = paint(SYMBOLS[check.level], COLORS[check.level]);
      // 多行 detail(端点返回的错误体)要跟着缩进,否则会顶到行首破坏对齐。
      // 列位 = 2 缩进 + 1 符号 + 1 空格 + label 宽 + 2 分隔,与下面的 hint 行一致。
      const detail = (check.detail ?? '').split('\n').join(`\n${' '.repeat(width + 6)}`);
      lines.push(`  ${symbol} ${check.label}${pad}  ${detail}`.trimEnd());
      if (check.hint) lines.push(`  ${' '.repeat(width + 2)}  → ${check.hint}`);
    }
    lines.push('');
  }

  lines.push(
    t('doctor.summary', {
      ok: String(report.counts.ok),
      warn: String(report.counts.warn),
      fail: String(report.counts.fail),
    }),
  );
  return `${lines.join('\n')}\n`;
}
