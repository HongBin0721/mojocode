import { createMemo, For, Show } from 'solid-js';
import { Box, Text, type JSX } from './kit.js';
import { theme } from './theme.js';
import { highlightLine, languageFromPath } from './highlight.js';
import { t } from '../i18n/index.js';

interface Props {
  patch: string;
  maxLines?: number;
}

/** 解析后的一行:行号 + 类型 + 正文(去掉 +/- 标记)。 */
interface Row {
  /** 新增/上下文行取新文件行号,删除行取旧文件行号;元信息行没有行号。 */
  num?: number;
  kind: 'add' | 'del' | 'ctx' | 'gap' | 'meta';
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** unified diff 的文件头,补丁自带路径——语言由此推断,无需外部传入。 */
const HEADER_RE = /^--- (.+?)(?:\t.*)?$/;

/**
 * 渲染 unified diff(Claude Code 风格):行号 + 新增/删除行的背景高亮,
 * hunk 之间用 ⋯ 分隔,过长的补丁折叠。
 */
export function Diff(props: Props): JSX.Element {
  const view = createMemo(() => {
    const { rows: all, language } = parsePatch(props.patch);
    const rows = all.slice(0, props.maxLines ?? 40);
    const hidden = all.length - rows.length;
    // 行号列宽按可见行的最大行号计算,右对齐。
    const numWidth = rows.reduce((w, r) => Math.max(w, String(r.num ?? '').length), 1);
    return { rows, hidden, numWidth, language };
  });

  return (
    <Box flexDirection="column">
      <For each={view().rows}>
        {(row) => <DiffRow row={row} numWidth={view().numWidth} language={view().language} />}
      </For>
      <Show when={view().hidden > 0}>
        <Text color={theme.dim}>{t('ui.moreDiffLines', { n: view().hidden })}</Text>
      </Show>
    </Box>
  );
}

/**
 * 一行 diff。代码文本按文件类型做语法高亮,再整体套上 +/- 的背景色:
 * ansi-spans 把高亮里的"恢复默认前景色"(SGR 39)解释为继承外层,因此
 * 未被着色的片段仍是 diff 的浅绿/浅红,背景也贯穿整行不断裂。
 *
 * row 是不可变数据(For 按引用整体重建),组件体里分支即可。
 */
function DiffRow(props: { row: Row; numWidth: number; language?: string }): JSX.Element {
  const row = props.row;
  const num = `${String(row.num ?? '').padStart(props.numWidth)} `;
  switch (row.kind) {
    case 'gap':
      return <Text color={theme.dim}>{`${' '.repeat(props.numWidth)} ⋯`}</Text>;
    case 'meta':
      return <Text color={theme.dim}>{row.text || ' '}</Text>;
    case 'add':
      return (
        <Text>
          <Text color={theme.dim}>{num}</Text>
          <Text backgroundColor={theme.diffAddedBg} color={theme.diffAddedFg}>
            {`+ ${highlightLine(row.text, props.language)}`}
          </Text>
        </Text>
      );
    case 'del':
      return (
        <Text>
          <Text color={theme.dim}>{num}</Text>
          <Text backgroundColor={theme.diffRemovedBg} color={theme.diffRemovedFg}>
            {`- ${highlightLine(row.text, props.language)}`}
          </Text>
        </Text>
      );
    default:
      return (
        <Text>
          <Text color={theme.dim}>{num}</Text>
          <Text>{`  ${highlightLine(row.text, props.language)}`}</Text>
        </Text>
      );
  }
}

function parsePatch(patch: string): { rows: Row[]; language?: string } {
  const rows: Row[] = [];
  let language: string | undefined;
  let oldLn = 0;
  let newLn = 0;
  let seenHunk = false;

  const lines = patch.split('\n');
  // 补丁末尾的换行会 split 出一个空串,不是真正的上下文行。
  if (lines.at(-1) === '') lines.pop();

  for (const line of lines) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLn = Number(hunk[1]);
      newLn = Number(hunk[2]);
      // hunk 头本身不显示,第二个 hunk 起画一条 ⋯ 分隔。
      if (seenHunk) rows.push({ kind: 'gap', text: '' });
      seenHunk = true;
      continue;
    }

    // `---`/`+++` 只在首个 hunk 之前才是文件头。hunk 内部它们是普通内容:
    // 新增一行顶格的 `++i;` 得到 `+++i;`,删掉一行顶格的 `-- 注释` 得到
    // `--- 注释`。当成文件头跳过的话,这些改动会从 diff 里凭空消失——而同一
    // 个组件也渲染写入/编辑的授权确认框,用户会在看不见改动的情况下批准。
    if (!seenHunk) {
      if (line.startsWith('---')) {
        // 文件头不渲染,只从中取出路径来判定语言。
        const header = HEADER_RE.exec(line);
        if (header?.[1]) language ??= languageFromPath(header[1]);
        continue;
      }
      if (line.startsWith('+++')) continue;
      // hunk 之前的其他头部行(如 diff --git)一律按元信息淡化。
      if (line.trim()) rows.push({ kind: 'meta', text: line });
      continue;
    }

    if (line.startsWith('+')) {
      rows.push({ num: newLn++, kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      rows.push({ num: oldLn++, kind: 'del', text: line.slice(1) });
    } else if (line.startsWith(' ') || line === '') {
      rows.push({ num: newLn, kind: 'ctx', text: line.slice(1) });
      oldLn++;
      newLn++;
    } else {
      // `\ No newline at end of file` 之类。
      rows.push({ kind: 'meta', text: line });
    }
  }
  return { rows, language };
}
