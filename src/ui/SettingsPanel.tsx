import { batch, createMemo, createSignal, For, Show } from 'solid-js';
import { Box, Text, useInput, type JSX } from './kit.js';
import { theme, glyphs } from './theme.js';
import { LOCALES, t, type Locale, type MessageKey } from '../i18n/index.js';
import { centeredWindowStart } from './picker-utils.js';
import { STATUS_SEGMENTS, type StatusSegment } from '../config/schema.js';

/** 语言名用各自的母语写法展示,不做翻译。 */
const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

/** 状态栏各信息段的说明。穷尽 Record:新增段时编译期就会提醒补文案。 */
const SEGMENT_DESCRIPTIONS: Record<StatusSegment, MessageKey> = {
  mode: 'statusopt.mode',
  model: 'statusopt.model',
  cwd: 'statusopt.cwd',
  think: 'statusopt.think',
  context: 'statusopt.context',
  total: 'statusopt.total',
  todos: 'statusopt.todos',
};

/** 面板里的设置项。新增一项设置 = 这里加一支 + rows() 里加一段取值。 */
type SectionId = 'language' | 'statusbar';
const SECTIONS: readonly SectionId[] = ['language', 'statusbar'];
const SECTION_TITLES: Record<SectionId, MessageKey> = {
  language: 'settings.language',
  statusbar: 'settings.statusbar',
};

/** 一屏最多显示的行数,超出部分滚动(与二级选择器一致)。 */
const WINDOW = 8;

/** 一行的呈现数据。三个视图(设置项/语言/状态栏)都压到这一种形状上渲染。 */
interface Row {
  /** 行首主文本。 */
  label: string;
  /** 右侧的灰色补充,自带分隔符(`— 说明` 或 `▸ 当前值`)。 */
  suffix: string;
  /** 单选:是不是当前生效值,带 ✓ 标记。 */
  current?: boolean;
  /**
   * 多选:勾选状态。刻意取成 thunk 而不是 boolean——否则 rows() 会依赖
   * draft(),每按一次空格就重建整份行数据,<For> 也就失去了按引用复用。
   */
  checked?: () => boolean;
}

interface Props {
  /** 当前界面语言。 */
  language: Locale;
  /** 当前状态栏信息段(已按 STATUS_SEGMENTS 顺序规范化)。 */
  segments: StatusSegment[];
  /** 选定语言。App 负责落地 + 落盘 + 提示。 */
  onLanguage: (locale: Locale) => void;
  /** 确认状态栏信息段(按 STATUS_SEGMENTS 顺序,可为空)。 */
  onStatusBar: (segments: StatusSegment[]) => void;
  onClose: () => void;
}

/**
 * `/setting` 打开的设置面板。语言与状态栏原本各是一条带二级选择器的斜杠
 * 命令,现在统一收进这里:命令菜单里只剩一个入口,设置项之间也不必再各记
 * 一个命令名。
 *
 * 与 RewindPicker 同样的前提:它渲染期间 Input 已卸载(App 的渲染分支互斥),
 * 自带的 useInput 不会与输入框抢按键。
 *
 * 两级导航:一级是设置项列表(顺带显示当前值),回车进二级编辑,esc 逐级
 * 退出。二级里语言是单选(回车即生效),状态栏是多选(空格勾选草稿,回车
 * 才落地)——草稿的意义在于 esc 能原样退回。
 */
export function SettingsPanel(props: Props): JSX.Element {
  const [section, setSection] = createSignal<SectionId | undefined>(undefined);
  const [cursor, setCursor] = createSignal(0);
  // 状态栏多选的草稿集合;进入二级时从当前值拷一份。
  const [draft, setDraft] = createSignal<Set<StatusSegment>>(new Set());

  /** 一级列表里每项右侧显示的当前值。 */
  const sectionValue = (id: SectionId): string =>
    id === 'language'
      ? LOCALE_LABELS[props.language]
      : props.segments.length > 0
        ? props.segments.join(' ')
        : t('settings.none');

  /**
   * 当前视图的所有行。按键处理与渲染共用这一份,行数不会和画出来的列表
   * 对不上(光标取模用的是同一个 length)。
   */
  const rows = createMemo<Row[]>(() => {
    const id = section();
    if (id === 'language') {
      return LOCALES.map((locale) => ({
        label: locale,
        suffix: `— ${LOCALE_LABELS[locale]}`,
        current: locale === props.language,
      }));
    }
    if (id === 'statusbar') {
      return STATUS_SEGMENTS.map((segment) => ({
        label: segment,
        suffix: `— ${t(SEGMENT_DESCRIPTIONS[segment])}`,
        checked: () => draft().has(segment),
      }));
    }
    return SECTIONS.map((s) => ({ label: t(SECTION_TITLES[s]), suffix: `▸ ${sectionValue(s)}` }));
  });

  /** 退回一级列表,光标停在刚才进入的那一项上。 */
  const back = (from: SectionId) => {
    // batch:section 与 cursor 中间那一拍(新列表 + 旧下标)会白画一帧。
    batch(() => {
      setSection(undefined);
      setCursor(SECTIONS.indexOf(from));
    });
  };

  const enter = (id: SectionId) => {
    batch(() => {
      setSection(id);
      if (id === 'language') {
        setCursor(Math.max(0, LOCALES.indexOf(props.language)));
      } else {
        setDraft(new Set(props.segments));
        setCursor(0);
      }
    });
  };

  /** 多选:切换第 index 个信息段的勾选状态(空格 / 点击共用)。 */
  const toggleSegment = (index: number) => {
    const segment = STATUS_SEGMENTS[index];
    if (!segment) return;
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(segment)) next.delete(segment);
      else next.add(segment);
      return next;
    });
  };

  /** 提交状态栏草稿。按固定顺序提交,勾选先后不影响状态栏的排布。 */
  const commitStatusBar = () => {
    const picked = STATUS_SEGMENTS.filter((s) => draft().has(s));
    back('statusbar');
    props.onStatusBar(picked);
  };

  /**
   * 落在第 index 行上的动作,回车与点击共用。
   *
   * 注意状态栏那一支:它是多选,行的动作是勾选而不是提交(回车才提交),
   * 所以点击一行也只是勾选——点击不能比回车做得更多。
   */
  const activate = (index: number) => {
    const id = section();
    if (!id) {
      const target = SECTIONS[index];
      if (target) enter(target);
      return;
    }
    if (id === 'language') {
      const locale = LOCALES[index];
      // back() 要先走:选中语言会让 App 按 locale 重挂载整棵界面树(见
      // App 末尾的 keyed Show),本组件随之销毁,之后的 setSection 就落在
      // 一个没人再读的信号上了。
      back(id);
      if (locale) props.onLanguage(locale);
      return;
    }
    toggleSegment(index);
  };

  useInput((input, key) => {
    const id = section();
    if (key.escape) {
      if (id) back(id);
      else props.onClose();
      return;
    }
    const total = rows().length;
    if (total === 0) return;
    if (key.upArrow) {
      setCursor((c) => (c + total - 1) % total);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % total);
      return;
    }
    // 多选:空格切换光标处信息段的勾选状态。
    if (id === 'statusbar' && input === ' ' && !key.return) {
      toggleSegment(cursor());
      return;
    }
    if (!key.return) return;
    // 二级多选里回车是"提交草稿",不是行动作。
    if (id === 'statusbar') {
      commitStatusBar();
      return;
    }
    activate(cursor());
  });

  const windowStart = createMemo(() => centeredWindowStart(cursor(), rows().length, WINDOW));

  const title = () => {
    const id = section();
    // 面包屑用 ›(与光标的 ❯ 区分开,免得看成"这一行被选中")。
    return id ? `${t('settings.title')} ${glyphs.prompt} ${t(SECTION_TITLES[id])}` : t('settings.title');
  };

  /** 一级用自己的提示语(进入/关闭),二级复用选择器那两句(确认/返回)。 */
  const hint = () => {
    const id = section();
    if (!id) return t('settings.hint');
    return t(id === 'statusbar' ? 'selector.multiHint' : 'selector.hint');
  };

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {title()}
        </Text>
        <Show when={windowStart() > 0}>
          <Text color={theme.dim}>{t('selector.moreAbove', { n: windowStart() })}</Text>
        </Show>
        <For each={rows().slice(windowStart(), windowStart() + WINDOW)}>
          {(row, i) => {
            const index = () => windowStart() + i();
            const active = () => index() === cursor();
            const checked = row.checked;
            return (
              // 点击 = 光标移过来 + 执行该行的动作(状态栏那一支即勾选)。
              <Text
                color={active() ? theme.accent : undefined}
                wrap="truncate-end"
                onClick={() => {
                  const target = index();
                  setCursor(target);
                  activate(target);
                }}
              >
                {active() ? `${glyphs.pointer} ` : '  '}
                <Show when={checked}>
                  <Text color={checked!() ? theme.success : theme.dim}>
                    {checked!() ? glyphs.bullet : glyphs.pending}{' '}
                  </Text>
                </Show>
                {row.label}
                <Show when={row.current}>
                  <Text color={theme.success}>
                    {' '}
                    {glyphs.done} {t('selector.current')}
                  </Text>
                </Show>
                <Text color={theme.dim}> {row.suffix}</Text>
              </Text>
            );
          }}
        </For>
        <Show when={windowStart() + WINDOW < rows().length}>
          <Text color={theme.dim}>
            {t('selector.moreBelow', { n: rows().length - windowStart() - WINDOW })}
          </Text>
        </Show>
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{hint()}</Text>
      </Box>
    </Box>
  );
}
