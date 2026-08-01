/** marked-terminal 不带类型声明,这里补一份用到的最小接口。 */
declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  export interface MarkedTerminalOptions {
    /** 输出宽度(列),配合 reflowText 使用。 */
    width?: number;
    /** 按 width 重排普通段落。 */
    reflowText?: boolean;
    /** 是否在标题前保留 `#` 前缀。 */
    showSectionPrefix?: boolean;
    /** 列表缩进宽度。 */
    tab?: number;
    /** 是否把 :emoji: 转成 emoji。 */
    emoji?: boolean;
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
