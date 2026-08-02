import { tool } from 'ai';
import { z } from 'zod';
import { canEverWrite, permissionsLabel } from '../config/schema.js';
import type { ToolContext } from './context.js';

/**
 * 计划模式的出口:呈交实现方案,等用户批准后自动切回进入计划模式之前的模式。
 *
 * 工具集在 Agent 构造时就固定了(没有 updateTools),所以这个工具在任何模式下
 * 都挂着,靠 execute() 内部判断模式来拒绝越权调用——与仓库既有原则一致:
 * 限制由权限门在执行时施加,不靠裁剪工具集。
 *
 * 三种返回都是**正常结果**而非抛错:方案被打回是正常的往复,不该在时间线上
 * 画成红色的工具报错。文本按约定保持英文(喂给模型的内容不本地化)。
 */
export function createExitPlanTool(ctx: ToolContext) {
  return tool({
    description:
      'Only meaningful in plan mode. Submit your finished implementation plan for the user to ' +
      'approve. On approval the permission mode switches back automatically and you implement the ' +
      'plan in the same turn. Do not call it in other modes, and do not print the plan as an ' +
      'ordinary message instead of calling this.',
    inputSchema: z.object({
      plan: z
        .string()
        .min(1)
        .describe(
          'The implementation plan as Markdown: which files change and how, in what order, and ' +
            'how to verify it. No preamble.',
        ),
    }),
    execute: async ({ plan }) => {
      if (!ctx.gate.planMode) {
        // read-only+never 也拒绝一切写入,不能笼统地说"你已经可以改了"——那会
        // 把模型推去撞 assertCanMutate,然后卡在两条互相矛盾的指令之间。
        // notApplicable 让摘要与时间线区分"方案被打回"和"压根没提交过方案"。
        const perms = { sandbox: ctx.gate.sandbox, approval: ctx.gate.approval };
        const label = permissionsLabel(perms);
        return {
          approved: false,
          notApplicable: true,
          message: canEverWrite(perms, false)
            ? `exit_plan only applies in plan mode; the permissions are "${label}", so you can ` +
              'already make changes (possibly with per-action approval). Implement the work ' +
              'directly and do not call this tool again.'
            : `exit_plan only applies in plan mode; the permissions are "${label}", which refuses ` +
              'all writes and has no approval step. Do not call this tool again. Report what you ' +
              'would change and let the user switch permissions.',
        };
      }

      const decision = await ctx.gate.requestPlanApproval(plan);

      if (!decision.approved) {
        const because = decision.reason ? `: ${decision.reason}` : '';
        return {
          approved: false,
          message:
            `The user did not approve this plan${because}. You are still in plan mode, so you ` +
            'still cannot edit anything. Ask what they want changed, or revise the plan yourself, ' +
            'then call exit_plan again.',
        };
      }

      const restored = ctx.exitPlanMode();
      const label = permissionsLabel(restored);
      // 批准后的编辑体验取决于还原到的组合:workspace-write 且非 untrusted
      // 时工作区编辑免确认,其余组合逐次确认。
      const editsFree = restored.sandbox !== 'read-only' && restored.approval !== 'untrusted';
      return {
        approved: true,
        mode: label,
        // 系统提示词滞后的兜底:prepareStep 会在下一步下发新的 instructions,
        // 但模型**本步**看到的仍是计划模式那份,不点破它会继续拒绝动手。
        message:
          `Plan approved. The permissions are now "${label}"` +
          (editsFree
            ? ', so file edits are auto-approved.'
            : ', so file edits will be confirmed by the user one at a time.') +
          ' Any instruction above saying you are in plan mode and cannot edit is now stale — ignore it.' +
          ' Record the plan steps with the todo tool, then start implementing right away.' +
          ' Do not ask for approval again.',
      };
    },
  });
}
