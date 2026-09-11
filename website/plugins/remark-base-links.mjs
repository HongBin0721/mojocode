/**
 * 给正文里的根绝对链接(`/guides/quickstart/`)补上站点 base(`/mojocode`),
 * 英文页面(`src/content/docs/en/` 下)再补 `/en` 语言段。
 *
 * Astro 只给侧栏与组件里的链接补 base,Markdown 正文里的链接原样输出;而站点
 * 部署在 GitHub Pages 的项目子路径下,不补前缀就全部 404。写相对路径
 * (`../../config/overview/`)虽能绕开,但一篇文章搬个目录就要改一遍。
 * 这里统一在 remark 阶段补,base 从 astro.config 传进来,换域名只改一处。
 * 正文里因此一律写「不带语言段」的站内路径,中英文路径同一份写法;
 * 锚点不翻译,要按目标语言页面的标题写。
 */
export default function remarkBaseLinks({ base }) {
  const prefix = base.replace(/\/$/, '');
  return (tree, file) => {
    const isEnglish = /\/content\/docs\/en\//.test(String(file.path ?? ''));
    const visit = (node) => {
      if ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string') {
        const url = node.url;
        // 只处理根绝对路径;协议链接、纯锚点(#…)、已带前缀的都不动。
        if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith(`${prefix}/`)) {
          const localized = isEnglish && !url.startsWith('/en/') ? `/en${url}` : url;
          node.url = `${prefix}${localized}`;
        }
      }
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(tree);
  };
}
