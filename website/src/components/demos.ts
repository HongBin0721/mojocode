/**
 * 首页终端窗口里的会话文本。写成 HTML 字符串而不是 .astro 模板,因为正文里有
 * 大量 `{ }`(代码 diff),在 Astro/MDX 模板里每一个都要转义。
 * 行首符号与摘要措辞照抄 TUI(src/ui/theme.ts 的 glyphs、i18n 的 sum.* 文案):
 * 这是产品真实的样子,不是示意图。
 */

const e = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const session = {
  'zh-CN': `<span class="u">›</span> <span class="b">把 src/api/ 里三处重复的 fetch 重试逻辑抽成一个函数,然后跑一遍测试</span>

<span class="d">✻ 已思考 4.1s</span>

<span class="t">⏺</span> <span class="b">Grep</span><span class="d">(retry|for \\(let i = 0 · src/api/**)</span>
  <span class="d">⎿  3 处匹配(ripgrep)</span>

<span class="t">⏺</span> <span class="b">Read</span><span class="d">(src/api/orders.ts)</span>
  <span class="d">⎿  读取 84,共 84 行</span>

<span class="t">⏺</span> <span class="b">Read</span><span class="d">(src/api/users.ts)</span>
  <span class="d">⎿  读取 61,共 61 行</span>

<span class="t">⏺</span> <span class="b">Write</span><span class="d">(src/api/retry.ts)</span>
  <span class="d">⎿  已创建,23 行</span>

<span class="t">⏺</span> <span class="b">Edit</span><span class="d">(src/api/orders.ts)</span>
  <span class="d">⎿  1 处替换</span>
     <span class="del">${e('-  for (let i = 0; i < 3; i++) {')}</span>
     <span class="del">${e('-    try { return await fetch(url, init); } catch (err) { last = err; }')}</span>
     <span class="del">${e('-  }')}</span>
     <span class="add">${e('+  return fetchWithRetry(url, init, { attempts: 3 });')}</span>

<span class="t">⏺</span> <span class="b">Bash</span><span class="d">(npm test)</span>
  <span class="d">⎿  退出码 0 · 耗时 3.8s</span>

三处重试逻辑收进了 <span class="b">src/api/retry.ts</span> 的 fetchWithRetry,
orders / users / cart 各自改为调用它。42 项测试全部通过。
改动未提交,你可以先看 diff。

<span class="d">▣ kimi-k2.6 · 38s · 12.4k tokens · 缓存命中 9.1k/11.2k (81%)</span>

<span class="d">──────────────────────────────────────────────────────────</span>
<span class="u">›</span> <span class="cur"></span>`,

  en: `<span class="u">›</span> <span class="b">Extract the three copies of the fetch retry loop in src/api/ into one function, then run the tests</span>

<span class="d">✻ Thought for 4.1s</span>

<span class="t">⏺</span> <span class="b">Grep</span><span class="d">(retry|for \\(let i = 0 · src/api/**)</span>
  <span class="d">⎿  3 matches (ripgrep)</span>

<span class="t">⏺</span> <span class="b">Read</span><span class="d">(src/api/orders.ts)</span>
  <span class="d">⎿  Read 84 of 84 lines</span>

<span class="t">⏺</span> <span class="b">Read</span><span class="d">(src/api/users.ts)</span>
  <span class="d">⎿  Read 61 of 61 lines</span>

<span class="t">⏺</span> <span class="b">Write</span><span class="d">(src/api/retry.ts)</span>
  <span class="d">⎿  Created, 23 lines</span>

<span class="t">⏺</span> <span class="b">Edit</span><span class="d">(src/api/orders.ts)</span>
  <span class="d">⎿  1 replacement</span>
     <span class="del">${e('-  for (let i = 0; i < 3; i++) {')}</span>
     <span class="del">${e('-    try { return await fetch(url, init); } catch (err) { last = err; }')}</span>
     <span class="del">${e('-  }')}</span>
     <span class="add">${e('+  return fetchWithRetry(url, init, { attempts: 3 });')}</span>

<span class="t">⏺</span> <span class="b">Bash</span><span class="d">(npm test)</span>
  <span class="d">⎿  exit 0 · 3.8s</span>

The three retry loops now live in <span class="b">src/api/retry.ts</span> as fetchWithRetry;
orders / users / cart call it. All 42 tests pass.
Nothing is committed yet, so you can review the diff first.

<span class="d">▣ kimi-k2.6 · 38s · 12.4k tokens · cache 9.1k/11.2k (81%)</span>

<span class="d">──────────────────────────────────────────────────────────</span>
<span class="u">›</span> <span class="cur"></span>`,
};

export const models = {
  'zh-CN': `<span class="u">›</span> /models

<span class="d">选择模型 · 输入即搜索 · ←/→ 折叠</span>
<span class="b">▾ GLM (智谱 Coding Plan)</span>
    <span class="u">❯</span> GLM-5.3                      <span class="d">✓ 当前</span>
      GLM-5.3-Flash
<span class="b">▾ Kimi Code (订阅)</span>
      kimi-k3
      kimi-k2.6
<span class="b">▸ DeepSeek</span>
<span class="b">▸ local (vLLM · 127.0.0.1:8000)</span>

<span class="u">›</span> /think
<span class="d">思考强度 · 档位随当前模型而定</span>
      low
    <span class="u">❯</span> medium                       <span class="d">✓ 当前</span>
      high
      max`,
  en: `<span class="u">›</span> /models

<span class="d">Pick a model · type to search · ←/→ collapse</span>
<span class="b">▾ GLM (Zhipu Coding Plan)</span>
    <span class="u">❯</span> GLM-5.3                      <span class="d">✓ current</span>
      GLM-5.3-Flash
<span class="b">▾ Kimi Code (subscription)</span>
      kimi-k3
      kimi-k2.6
<span class="b">▸ DeepSeek</span>
<span class="b">▸ local (vLLM · 127.0.0.1:8000)</span>

<span class="u">›</span> /think
<span class="d">Thinking effort · levels follow the current model</span>
      low
    <span class="u">❯</span> medium                       <span class="d">✓ current</span>
      high
      max`,
};

export const feedback = {
  'zh-CN': `<span class="t">⏺</span> <span class="b">Edit</span><span class="d">(src/server/router.ts)</span>
  <span class="err">⎿  1 处替换 · 2 个 LSP 错误</span>
     <span class="d">src/server/router.ts:41  Property 'userId' does not exist on type 'Session'.</span>
     <span class="d">src/server/handlers.ts:18  Expected 2 arguments, but got 1.(本次改动可能弄坏了它)</span>

<span class="d">✻ 已思考 2.3s</span>

<span class="t">⏺</span> <span class="b">Edit</span><span class="d">(src/server/handlers.ts)</span>
  <span class="d">⎿  1 处替换</span>

<span class="t">⏺</span> <span class="b">Task</span><span class="d">(找出所有调用 createSession 的地方 · explore)</span> <span class="d">· 5 步</span>
   <span class="d">⎿ Grep(createSession · src/**)</span>
   <span class="d">⎿ Read(src/auth/session.ts)</span>
  <span class="d">⎿  7 步 · 18.2k tokens</span>`,
  en: `<span class="t">⏺</span> <span class="b">Edit</span><span class="d">(src/server/router.ts)</span>
  <span class="err">⎿  1 replacement · 2 LSP errors</span>
     <span class="d">src/server/router.ts:41  Property 'userId' does not exist on type 'Session'.</span>
     <span class="d">src/server/handlers.ts:18  Expected 2 arguments, but got 1. (this change may have broken it)</span>

<span class="d">✻ Thought for 2.3s</span>

<span class="t">⏺</span> <span class="b">Edit</span><span class="d">(src/server/handlers.ts)</span>
  <span class="d">⎿  1 replacement</span>

<span class="t">⏺</span> <span class="b">Task</span><span class="d">(find every caller of createSession · explore)</span> <span class="d">· 5 steps</span>
   <span class="d">⎿ Grep(createSession · src/**)</span>
   <span class="d">⎿ Read(src/auth/session.ts)</span>
  <span class="d">⎿  7 steps · 18.2k tokens</span>`,
};

export const sessions = {
  'zh-CN': `<span class="u">$</span> mojocode sessions
<span class="d">  id        更新            消息   标题</span>
  a3f9c1d2  今天 14:02       38   把重复的 fetch 重试逻辑抽成一个函数
  7b20e8aa  昨天 21:47       12   排查 CI 上 vitest 偶发超时
  c4d1f0b7  9-06 10:15       56   给 /export 加 CSV 输出

<span class="u">$</span> mojocode -r 7b20 --fork-session
<span class="d">已从 7b20e8aa 分叉为新会话,原会话保持不动。</span>

<span class="u">›</span> <span class="b">上次那个超时,把 retry 的等待改成指数退避再试一次</span>`,
  en: `<span class="u">$</span> mojocode sessions
<span class="d">  id        updated         msgs  title</span>
  a3f9c1d2  today 14:02       38  Extract the duplicated fetch retry loop
  7b20e8aa  yesterday 21:47   12  Debug flaky vitest timeouts on CI
  c4d1f0b7  Sep 6 10:15       56  Add CSV output to /export

<span class="u">$</span> mojocode -r 7b20 --fork-session
<span class="d">Forked 7b20e8aa into a new session; the original is untouched.</span>

<span class="u">›</span> <span class="b">That timeout from last time: switch the retry wait to exponential backoff and try again</span>`,
};

export const extension = {
  'zh-CN': `<span class="d">// ~/.mojocode/extensions/guard.ts</span>
<span class="t">export default</span> (api) => {
  api.on(<span class="ok">'tool_call'</span>, ({ toolName, input }) => {
    <span class="t">if</span> (toolName === <span class="ok">'bash'</span> &amp;&amp;
        <span class="ok">/\\brm\\s+-rf\\b/</span>.test(input.command)) {
      <span class="t">return</span> { block: <span class="warn">true</span>, reason: <span class="ok">'rm -rf is blocked'</span> };
    }
  });
  api.registerCommand(<span class="ok">'deploy'</span>, {
    description: <span class="ok">'部署到预发环境'</span>,
    handler: (args) =>
      api.followUp(<span class="ok">\`按 docs/deploy.md 部署到 \${args || 'staging'}\`</span>),
  });
};

<span class="u">›</span> /deploy
<span class="d">⏺ Bash(rm -rf build)</span>
<span class="err">  ⎿  Tool call blocked: rm -rf is blocked</span>`,
  en: `<span class="d">// ~/.mojocode/extensions/guard.ts</span>
<span class="t">export default</span> (api) => {
  api.on(<span class="ok">'tool_call'</span>, ({ toolName, input }) => {
    <span class="t">if</span> (toolName === <span class="ok">'bash'</span> &amp;&amp;
        <span class="ok">/\\brm\\s+-rf\\b/</span>.test(input.command)) {
      <span class="t">return</span> { block: <span class="warn">true</span>, reason: <span class="ok">'rm -rf is blocked'</span> };
    }
  });
  api.registerCommand(<span class="ok">'deploy'</span>, {
    description: <span class="ok">'Deploy to staging'</span>,
    handler: (args) =>
      api.followUp(<span class="ok">\`Deploy to \${args || 'staging'} per docs/deploy.md\`</span>),
  });
};

<span class="u">›</span> /deploy
<span class="d">⏺ Bash(rm -rf build)</span>
<span class="err">  ⎿  Tool call blocked: rm -rf is blocked</span>`,
};
