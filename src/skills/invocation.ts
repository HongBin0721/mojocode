/**
 * 斜杠技能调用的回放信封。
 *
 * 用户敲 `/name args` 时,真正进历史的是展开后的技能正文——回放与回退列表
 * 必须能还原成当时敲的命令,否则时间线上突然多出一大段用户"没说过"的话。
 * 手法与 INIT_PROMPT_MARKER 相同:首行放稳定标记,回放按标记还原。
 *
 * **首行格式是持久化契约**:改动即破坏旧会话的回放,只准追加新逻辑,
 * 不准改标记本身(与 attachments.ts 的 ATTACHMENTS_HEADER 同级别)。
 */

const OPEN = '<skill-command>';
const CLOSE = '</skill-command>';

/** display 是用户敲的原文(`/name args`);body 是展开后的技能正文。 */
export function wrapSkillPrompt(display: string, body: string): string {
  // display 里出现换行或闭合标记会破坏首行契约;斜杠命令本身是单行输入,
  // 这里只是兜底净化。
  const safe = display.replace(/\s+/g, ' ').replaceAll(CLOSE, '').trim();
  return `${OPEN}${safe}${CLOSE}\n\n${body}`;
}

/**
 * 从持久化的用户消息还原命令原文;不是技能信封时返回 undefined
 * (老会话、普通消息都落在这条路上,天然兼容)。
 */
export function unwrapSkillPrompt(text: string): string | undefined {
  if (!text.startsWith(OPEN)) return undefined;
  const lineEnd = text.indexOf('\n');
  const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
  if (!firstLine.endsWith(CLOSE)) return undefined;
  const command = firstLine.slice(OPEN.length, firstLine.length - CLOSE.length).trim();
  // 信封里必须是斜杠命令——用户手打的 <skill-command> 开头的普通消息不还原。
  if (!command.startsWith('/')) return undefined;
  return command;
}

/**
 * 解析 `/name args` 形式的输入;App 与 headless `-p` 共用,保证两个入口
 * 对同一串输入切出同一对 (name, args)。不是斜杠输入时返回 undefined。
 */
export function parseSlashInvocation(raw: string): { name: string; args: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!name) return undefined;
  return { name, args: rest.join(' ') };
}
