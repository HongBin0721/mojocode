// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import remarkBaseLinks from './plugins/remark-base-links.mjs';

// 文档站部署在 GitHub Pages 的项目子路径下,所以 base 是 /mojocode;
// 换成自定义域名时只改 site 与 base 两行(正文链接由 remark 插件按 base 补前缀)。
const site = 'https://hongbin0721.github.io';
const base = '/mojocode';

export default defineConfig({
  site,
  base,
  markdown: {
    remarkPlugins: [[remarkBaseLinks, { base }]],
  },
  integrations: [
    starlight({
      title: 'mojocode',
      description: '运行在终端里的通用编程 agent,可接入任意大模型。',
      // 中文是默认语言(根路径),英文在 /en/;英文缺页自动回退到中文。
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/HongBin0721/mojocode' },
      ],
      editLink: {
        baseUrl: 'https://github.com/HongBin0721/mojocode/edit/main/website/',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: '开始',
          translations: { en: 'Getting started' },
          items: [{ slug: 'guides/quickstart' }],
        },
        {
          label: '使用',
          translations: { en: 'Usage' },
          items: [
            { slug: 'guides/tui' },
            { slug: 'guides/headless' },
            { slug: 'guides/sessions' },
            { slug: 'guides/cli' },
            { slug: 'guides/server' },
          ],
        },
        {
          label: '配置',
          translations: { en: 'Configuration' },
          items: [
            { slug: 'config/overview' },
            { slug: 'config/providers' },
            { slug: 'config/search' },
            { slug: 'config/lsp' },
            { slug: 'config/mcp' },
            { slug: 'config/language' },
            { slug: 'config/project-instructions' },
          ],
        },
        {
          label: '扩展',
          translations: { en: 'Extensions' },
          items: [
            { slug: 'extensions/overview' },
            { slug: 'extensions/packages' },
            { slug: 'extensions/builtin' },
            { slug: 'extensions/skills' },
          ],
        },
        {
          label: '特性',
          translations: { en: 'Features' },
          items: [
            { slug: 'features/subagents' },
            { slug: 'features/review' },
            { slug: 'features/goal' },
            { slug: 'features/permissions' },
          ],
        },
        {
          label: '参考',
          translations: { en: 'Reference' },
          items: [
            { slug: 'reference/architecture' },
            { slug: 'reference/session-format' },
          ],
        },
        {
          label: '开发',
          translations: { en: 'Development' },
          items: [{ slug: 'dev/contributing' }, { slug: 'faq' }],
        },
      ],
    }),
  ],
});
