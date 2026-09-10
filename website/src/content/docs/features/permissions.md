---
title: 没有权限系统
description: 边界交给运行环境,拦截交给扩展。
---

与 [pi](https://github.com/badlogic/pi-mono) 一致,mojocode **没有权限系统**:没有沙箱档位、没有确认框、没有允许或拒绝规则、没有计划模式。`read` / `write` / `edit` / `bash` 能碰到进程能碰到的任何路径,`web_fetch` 能访问任何地址。

这不是省事,是把「边界在哪」这件事交还给运行环境:把 mojocode 放进容器、沙箱账户或一次性的工作副本里跑,那才是真正靠得住的围栏;进程内的权限门只能拦住「客气」的模型,拦不住一条 `bash` 里的任何东西。

## 想拦截,写一个扩展

`tool_call` 钩子在每次工具执行前被调用,返回 `{ block: true, reason }` 即否决:错误喂回模型,整轮不终结。策略完全由你定,按路径、按命令前缀、按域名,或干脆弹一个确认。

```ts
// <项目>/.mojocode/extensions/guard.ts
export default (api) => {
  api.on('tool_call', ({ toolName, input }) => {
    const path = String((input as { path?: unknown }).path ?? '');
    if ((toolName === 'write' || toolName === 'edit') && path.startsWith('migrations/')) {
      return { block: true, reason: 'migrations/ is read-only in this project' };
    }
    return undefined;
  });
};
```

否决原因请用英文,它是喂给模型的文本。钩子抛错同样算否决,一个有 bug 的拦截器不会让工具裸跑。详见[扩展](/extensions/overview/#钩子)。

## 旧配置

旧版本的 `sandbox` / `approval` / `permissions` / `permissionMode` 配置键、会话文件里的规则记录、技能 frontmatter 的 `allowed-tools` 一律当作未知键忽略,不会报错。
