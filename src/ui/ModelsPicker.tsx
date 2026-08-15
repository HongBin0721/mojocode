import { batch, createMemo, createSignal, For, Show } from 'solid-js';
import { Box, Text, useInput, type JSX } from './kit.js';
import { theme, glyphs, contextNote } from './theme.js';
import { t } from '../i18n/index.js';
import { centeredWindowStart, createManualEntry, ManualEntryBox } from './picker-utils.js';
import type { ProviderModels } from '../model/registry.js';

const WINDOW = 8;

/**
 * 一行渲染行:组头可回车/←→ 折叠展开,模型行回车选定,手动输入行垫底
 * (作用于当前厂商,与旧 /model 的手动行同一语义)。错误行不可选中。
 */
type Row =
  | { kind: 'header'; group: ProviderModels }
  | { kind: 'error'; group: ProviderModels }
  | { kind: 'model'; group: ProviderModels; model: string }
  | { kind: 'manual' };

interface Props {
  groups: ProviderModels[];
  currentProvider: string;
  currentModel: string;
  onPick: (providerId: string, modelId: string) => void;
  onCancel: () => void;
}

/**
 * `/models` 的分组模型选择器:按厂商分支显示,输入即搜索(子串匹配模型 id
 * 或厂商名,厂商名命中时展开该组全部模型),←/→ 折叠/展开分组。
 *
 * 结构对齐 ModelPicker:窗口化列表、↑/↓/回车/esc、点击即选定;渲染期间
 * Input 已卸载,自带的 useInput 不会与输入框抢按键。esc 的语义是两段式:
 * 有搜索词先清搜索,清了才关闭选择器。搜索时折叠状态被忽略(搜索结果的
 * 完整性优先),清词后恢复。
 */
export function ModelsPicker(props: Props): JSX.Element {
  const [query, setQuery] = createSignal('');
  // 折叠的 providerId 集合;不可变替换,让 memo 依赖引用变化即可。
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  // 手动输入作用于当前厂商,与旧 /model 的手动行同一语义。
  const manual = createManualEntry((id) => props.onPick(props.currentProvider, id));

  const rows = createMemo<Row[]>(() => {
    const q = query().trim().toLowerCase();
    const out: Row[] = [];
    for (const group of props.groups) {
      // 本组要显示的模型,三态归一:搜索时厂商名命中整组保留、否则按模型
      // id 过滤;非搜索时折叠组就是空(只剩组头)。组头/错误行/模型行的
      // 入队规则因此只写一份。
      const models = q
        ? group.label.toLowerCase().includes(q)
          ? group.models
          : group.models.filter((m) => m.id.toLowerCase().includes(q))
        : collapsed().has(group.providerId)
          ? []
          : group.models;
      // 搜索全不命中 → 整组隐藏(非搜索的折叠组 models 为空,组头照常)。
      if (q && models.length === 0) continue;
      out.push({ kind: 'header', group });
      if (group.error) out.push({ kind: 'error', group });
      for (const m of models) out.push({ kind: 'model', group, model: m.id });
    }
    out.push({ kind: 'manual' });
    return out;
  });

  /** 渲染行 → 可选中序号的映射(错误行不占序号)。光标永远落在可选中行上。 */
  const table = createMemo(() => {
    let sel = 0;
    const entries = rows().map((row) => ({
      row,
      selIndex: row.kind === 'error' ? -1 : sel++,
    }));
    return { entries, total: sel };
  });

  /** 按谓词找第一个可选中行的序号,找不到为 -1。 */
  const findSel = (pred: (row: Row) => boolean): number => {
    for (const entry of table().entries) {
      if (entry.selIndex >= 0 && pred(entry.row)) return entry.selIndex;
    }
    return -1;
  };

  const firstModelIndex = () => Math.max(0, findSel((r) => r.kind === 'model'));

  const currentSel = findSel(
    (r) =>
      r.kind === 'model' &&
      r.group.providerId === props.currentProvider &&
      r.model === props.currentModel,
  );
  const [cursor, setCursor] = createSignal(currentSel >= 0 ? currentSel : firstModelIndex());

  /** 行集收缩(打字/清词/折叠)后光标可能悬空,读取时统一钳到末行。 */
  const curIndex = createMemo(() =>
    Math.min(cursor(), Math.max(0, table().total - 1)),
  );

  const entryAtCursor = () =>
    table().entries.find((e) => e.selIndex === curIndex());

  /** 折叠集合的唯一写入口:不可变替换,让 memo 依赖引用变化。 */
  const setGroupCollapsed = (providerId: string, value: boolean): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (value) next.add(providerId);
      else next.delete(providerId);
      return next;
    });
  };

  const toggleGroup = (providerId: string): void => {
    // 搜索时行集忽略 collapsed(结果完整性优先),这时切折叠只会改到一个
    // 看不见的集合——清词后凭空少掉几组。搜索中一律不动它。
    if (query()) return;
    setGroupCollapsed(providerId, !collapsed().has(providerId));
  };

  useInput((input, key) => {
    if (manual.handleKey(input, key)) return;
    if (key.escape) {
      // 两段式:先清搜索词,清了才关闭。
      if (query()) {
        batch(() => {
          setQuery('');
          setCursor(firstModelIndex());
        });
      } else {
        props.onCancel();
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (query()) setQuery((q) => q.slice(0, -1));
      return;
    }
    const total = table().total;
    if (total === 0) return;
    if (key.upArrow) {
      setCursor((curIndex() + total - 1) % total);
      return;
    }
    if (key.downArrow) {
      setCursor((curIndex() + 1) % total);
      return;
    }
    // 输入即搜索:可打印字符追加到搜索词,光标跳到首个模型行(回车即选)。
    if (!key.ctrl && !key.meta && !key.tab && !key.return && !key.leftArrow && !key.rightArrow && input) {
      const ch = input.replace(/[\r\n]/g, '');
      if (!ch) return;
      batch(() => {
        setQuery((q) => q + ch);
        setCursor(firstModelIndex());
      });
      return;
    }
    const entry = entryAtCursor();
    if (!entry) return;
    if (key.leftArrow || key.rightArrow) {
      if (entry.row.kind === 'manual') return;
      // 与 toggleGroup 同一条纪律:搜索中不改看不见的折叠集合。
      if (query()) return;
      const providerId = entry.row.group.providerId;
      // ← 折叠、→ 展开;已是目标态就 no-op。
      const collapsing = key.leftArrow;
      if (collapsed().has(providerId) === collapsing) return;
      setGroupCollapsed(providerId, collapsing);
      // 折叠模型行时把光标挪回它所在组的组头,免得悬到下一组。
      if (collapsing && entry.row.kind === 'model') {
        const headerSel = findSel(
          (r) => r.kind === 'header' && r.group.providerId === providerId,
        );
        if (headerSel >= 0) setCursor(headerSel);
      }
      return;
    }
    if (key.return) {
      if (entry.row.kind === 'manual') {
        manual.openEntry();
        return;
      }
      if (entry.row.kind === 'header') {
        toggleGroup(entry.row.group.providerId);
        return;
      }
      // 错误行不可选(不占光标序号),到这里的只会是模型行。
      if (entry.row.kind === 'model') {
        props.onPick(entry.row.group.providerId, entry.row.model);
      }
    }
  });

  /** 窗口化:围绕光标行开窗(对齐 ModelPicker 的居中滚动)。 */
  const view = createMemo(() => {
    const entries = table().entries;
    const cursorRow = entries.findIndex((e) => e.selIndex === curIndex());
    const start = centeredWindowStart(Math.max(0, cursorRow), entries.length, WINDOW);
    const slice = entries.slice(start, start + WINDOW);
    return { start, slice, below: entries.length - start - slice.length };
  });

  const hasModelRows = () => rows().some((r) => r.kind === 'model');
  const currentProviderLabel = () =>
    props.groups.find((g) => g.providerId === props.currentProvider)?.label ??
    props.currentProvider;

  return (
    // 不设 marginTop:与时间线的分隔由 App 底部固定区的外层容器统一给出。
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {t('modelspicker.title')}
        </Text>
        {/* 搜索行:有词时显示光标符,空时给暗色占位提示。 */}
        <Text>
          {query() ? (
            `${glyphs.prompt} ${query()}▏`
          ) : (
            <Text color={theme.dim}>
              {`${glyphs.prompt} ${t('modelspicker.search')}`}
            </Text>
          )}
        </Text>
        <Show when={view().start > 0}>
          <Text color={theme.dim}>{t('selector.moreAbove', { n: view().start })}</Text>
        </Show>
        <For each={view().slice}>
          {(entry) => {
            const active = () => entry.selIndex >= 0 && entry.selIndex === curIndex();
            const expanded = (group: ProviderModels) =>
              query() !== '' || !collapsed().has(group.providerId);
            if (entry.row.kind === 'header') {
              const group = entry.row.group;
              return (
                <Text
                  color={active() ? theme.accent : undefined}
                  bold
                  wrap="truncate-end"
                  onClick={() => toggleGroup(group.providerId)}
                >
                  {active() ? `${glyphs.pointer} ` : '  '}
                  {expanded(group) ? glyphs.expanded : glyphs.expandable} {group.label}
                  <Text color={theme.dim}>
                    {' '}
                    {t('modelspicker.count', { n: group.models.length })}
                  </Text>
                  <Show when={group.providerId === props.currentProvider}>
                    <Text color={theme.success}> {glyphs.done}</Text>
                  </Show>
                </Text>
              );
            }
            if (entry.row.kind === 'error') {
              const group = entry.row.group;
              return (
                <Text color={theme.dim} wrap="truncate-end">
                  {'  '}
                  {glyphs.failed} {t('modelspicker.fetchFailed')}
                  {group.error ? ` — ${group.error}` : ''}
                </Text>
              );
            }
            if (entry.row.kind === 'model') {
              const { group, model } = entry.row;
              const isCurrent = () =>
                group.providerId === props.currentProvider && model === props.currentModel;
              const note = () => contextNote(group.contextWindows?.[model]);
              return (
                // 点击即选定(等价于把光标移过去再回车)。
                <Text
                  color={active() ? theme.accent : undefined}
                  wrap="truncate-end"
                  onClick={() => props.onPick(group.providerId, model)}
                >
                  {active() ? `${glyphs.pointer}   ` : '    '}
                  {model}
                  <Show when={isCurrent()}>
                    <Text color={theme.success}>
                      {' '}
                      {glyphs.done} {t('selector.current')}
                    </Text>
                  </Show>
                  <Show when={note()}>
                    <Text color={theme.dim}> — {note()}</Text>
                  </Show>
                </Text>
              );
            }
            return (
              <Text
                color={active() ? theme.accent : theme.dim}
                wrap="truncate-end"
                onClick={() => manual.openEntry()}
              >
                {active() ? `${glyphs.pointer} ` : '  '}
                {glyphs.prompt} {t('modelspicker.manual', { label: currentProviderLabel() })}
              </Text>
            );
          }}
        </For>
        <Show when={query() !== '' && !hasModelRows()}>
          <Text color={theme.dim}>{t('modelspicker.noMatches')}</Text>
        </Show>
        <Show when={manual.open()}>
          <ManualEntryBox buffer={manual.buffer()} />
        </Show>
        <Show when={view().below > 0}>
          <Text color={theme.dim}>{t('selector.moreBelow', { n: view().below })}</Text>
        </Show>
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{t('modelspicker.hint')}</Text>
      </Box>
    </Box>
  );
}
