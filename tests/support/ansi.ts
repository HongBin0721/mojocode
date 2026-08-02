/**
 * 去掉 ANSI 样式序列,只留可见文本。
 *
 * 断言渲染结果里的文字必须先过这一步:着色是否开启取决于运行环境
 * (TTY / FORCE_COLOR),开启时样式码会插进单词中间,直接 toContain
 * 一段文本就会在本地终端里跑失败,而在 CI 的非 TTY 下通过。
 */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function plain(text: string | undefined): string {
  return (text ?? '').replace(ANSI_RE, '');
}
