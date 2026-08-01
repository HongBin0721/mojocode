import React from 'react';
import { Text } from 'ink';
import { theme } from './theme.js';

/**
 * 面向终端的轻量 markdown 渲染:按行处理,支持标题、列表、引用、分隔线、
 * 代码块与行内的 `code` / **bold** / *italic*。不引入完整解析器——流式
 * 输出时文本随时可能截断在语法中间,逐行的宽松处理反而更稳。
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let inCode = false;

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      // 围栏行本身不渲染,只切换代码块状态。
      inCode = !inCode;
      return;
    }
    if (inCode) {
      out.push(
        <Text key={i} color={theme.code}>
          {`  ${line}` || ' '}
        </Text>,
      );
      return;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <Text key={i} bold color={theme.accent}>
          {heading[2]}
        </Text>,
      );
      return;
    }

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(
        <Text key={i}>
          {bullet[1]}
          <Text color={theme.dim}>• </Text>
          {renderInline(bullet[2]!, i)}
        </Text>,
      );
      return;
    }

    const ordered = /^(\s*\d+[.)])\s+(.*)$/.exec(line);
    if (ordered) {
      out.push(
        <Text key={i}>
          <Text color={theme.dim}>{ordered[1]} </Text>
          {renderInline(ordered[2]!, i)}
        </Text>,
      );
      return;
    }

    if (/^\s*>\s?/.test(line)) {
      out.push(
        <Text key={i} color={theme.dim} italic>
          {line.replace(/^\s*>\s?/, '│ ')}
        </Text>,
      );
      return;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(
        <Text key={i} color={theme.dim}>
          {'─'.repeat(30)}
        </Text>,
      );
      return;
    }

    out.push(<Text key={i}>{line ? renderInline(line, i) : ' '}</Text>);
  });

  return <>{out}</>;
}

/**
 * 渲染一行内的 `code`、**bold**、*italic* 片段。
 *
 * 斜体的两侧星号都要求紧贴非空白字符,且开头星号前不能是字母数字——
 * 否则 `*.ts and *.js` 里两个不相干的星号会被当成一对,中间的内容被
 * 当作斜体、星号被吃掉,导致模型输出丢字符。
 */
function renderInline(text: string, row: number): React.ReactNode[] {
  const parts = text.split(
    /(`[^`]+`|\*\*[^*]+\*\*|(?<![A-Za-z0-9])\*[^*\s](?:[^*]*[^*\s])?\*)/g,
  );
  return parts
    .filter((part) => part !== '')
    .map((part, i) => {
      const key = `${row}-${i}`;
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
        return (
          <Text key={key} color={theme.code}>
            {part.slice(1, -1)}
          </Text>
        );
      }
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
        return (
          <Text key={key} bold>
            {part.slice(2, -2)}
          </Text>
        );
      }
      if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
        return (
          <Text key={key} italic>
            {part.slice(1, -1)}
          </Text>
        );
      }
      return <Text key={key}>{part}</Text>;
    });
}
