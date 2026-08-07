import { createMemo, type JSX as SolidJSX } from 'solid-js';
import { Text, type JSX } from './kit.js';
import { highlightLine, resolveLanguage } from './highlight.js';
import { theme } from './theme.js';

/**
 * 面向终端的轻量 markdown 渲染:按行处理,支持标题、列表、引用、分隔线、
 * 代码块与行内的 `code` / **bold** / *italic*。不引入完整解析器——流式
 * 输出时文本随时可能截断在语法中间,逐行的宽松处理反而更稳。
 *
 * 流式预览每个 delta 都会换 text——整体收进 memo 粗粒度重建即可,
 * 输出本来就是按行整批换掉的。
 */
export function Markdown(props: { text: string }): JSX.Element {
  const view = createMemo<SolidJSX.Element[]>(() => {
    const lines = props.text.split('\n');
    const out: SolidJSX.Element[] = [];
    let inCode = false;
    let codeLang: string | undefined;

    lines.forEach((line) => {
      const fence = /^\s*```(\S*)/.exec(line);
      if (fence) {
        // 围栏行本身不渲染,只切换代码块状态并记下语言标注。
        inCode = !inCode;
        codeLang = inCode && fence[1] ? resolveLanguage(fence[1]) : undefined;
        return;
      }
      if (inCode) {
        // 认得语言就语法着色,认不出(或没标注)统一用行内代码的颜色兜底。
        out.push(
          codeLang ? (
            <Text>{`  ${highlightLine(line, codeLang)}`}</Text>
          ) : (
            <Text color={theme.code}>{`  ${line}`}</Text>
          ),
        );
        return;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        out.push(
          <Text bold color={theme.accent}>
            {heading[2]}
          </Text>,
        );
        return;
      }

      const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        out.push(
          <Text>
            {bullet[1]}
            {/* 与定稿渲染(markdown-ansi.ts 的 BULLET)同一个符号,提交前后不跳字。 */}
            <Text color={theme.dim}>- </Text>
            {renderInline(bullet[2]!)}
          </Text>,
        );
        return;
      }

      const ordered = /^(\s*\d+[.)])\s+(.*)$/.exec(line);
      if (ordered) {
        out.push(
          <Text>
            <Text color={theme.dim}>{ordered[1]} </Text>
            {renderInline(ordered[2]!)}
          </Text>,
        );
        return;
      }

      if (/^\s*>\s?/.test(line)) {
        out.push(
          <Text color={theme.dim} italic>
            {line.replace(/^\s*>\s?/, '│ ')}
          </Text>,
        );
        return;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push(<Text color={theme.dim}>{'─'.repeat(30)}</Text>);
        return;
      }

      out.push(<Text>{line ? renderInline(line) : ' '}</Text>);
    });
    return out;
  });

  return <>{view()}</>;
}

/**
 * 渲染一行内的 `code`、**bold**、*italic* 片段。
 *
 * 斜体的两侧星号都要求紧贴非空白字符,且开头星号前不能是字母数字——
 * 否则 `*.ts and *.js` 里两个不相干的星号会被当成一对,中间的内容被
 * 当作斜体、星号被吃掉,导致模型输出丢字符。
 */
function renderInline(text: string): SolidJSX.Element[] {
  const parts = text.split(
    /(`[^`]+`|\*\*[^*]+\*\*|(?<![A-Za-z0-9])\*[^*\s](?:[^*]*[^*\s])?\*)/g,
  );
  return parts
    .filter((part) => part !== '')
    .map((part) => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
        return <Text color={theme.code}>{part.slice(1, -1)}</Text>;
      }
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
        return <Text bold>{part.slice(2, -2)}</Text>;
      }
      if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
        return <Text italic>{part.slice(1, -1)}</Text>;
      }
      return <Text>{part}</Text>;
    });
}
