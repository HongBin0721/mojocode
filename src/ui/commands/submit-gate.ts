/**
 * 提交门:handleSubmit / handleEscape / runCommand(经 ctx)三方共用的
 * 可变状态,收编成一个小对象——这三个入口对"提交是否在途"的语义必须完全
 * 一致,拆散到各文件就没人能一眼看全。
 */

export interface SubmitGate {
  /** 已受理但尚未发起 run() 的提交在途(@ 引用展开是异步的)。 */
  readonly pending: boolean;
  /** 在途的提交属于一次罐装命令启动(/review、/simplify)。 */
  readonly cannedPending: boolean;
  /** 受理代数:递增即作废所有在途提交。 */
  readonly gen: number;
  /**
   * 受理一次新提交:递增代数(作废上一个在途)并占住 busy 门。返回新代数,
   * 调用方持有它,展开完成后比对 gate.gen 判断自己是否仍在途。
   */
  begin(): number;
  /** 作废在途提交:代数再递增,busy 门放开。 */
  invalidate(): void;
  /** 只放开 busy 门(不动代数)。 */
  clearPending(): void;
  /**
   * 罐装命令启动窗口:占门 + 标记罐装。见 review-cmds 里 launchCanned 的
   * 注释——它与 @ 展开窗口不同,没有作废机制,esc 不清它、handleSubmit 拒绝它。
   */
  beginCanned(): void;
  /** 罐装命令落地(成功/失败/传输错误都算):两标志一并放开。 */
  endCanned(): void;
}

export function createSubmitGate(): SubmitGate {
  /**
   * 已受理但尚未发起 run() 的提交(@ 引用展开是异步的)。这段窗口里
   * agent 仍是 idle,esc 与 busy 拦截都要把它当作"忙"看待;submitGen
   * 递增即作废在途提交。
   */
  let submitPending = false;
  let submitGen = 0;
  /**
   * submitPending 当前属于一次罐装命令启动(launchCanned,/review、
   * /simplify)。它与 @ 展开窗口不同:没有 submitGen 那样的作废机制。esc 在
   * 窗口内既取消不了它、也不该清掉标志(清了会重新打开 busy 门,第二个罐装
   * 命令撞上 loop.ts 的防重入兜底退化成轮中注入),handleSubmit 对窗口内的
   * 普通消息同样据此拒绝——主 agent 空闲时没有轮可注入,放行只会另起一轮
   * 等应用轮撞车。轮子转起来(isRunning 点亮)后 esc 走正常的中断路径、
   * 消息走正常引导,不受此影响。
   */
  let cannedLaunchPending = false;

  return {
    get pending() {
      return submitPending;
    },
    get cannedPending() {
      return cannedLaunchPending;
    },
    get gen() {
      return submitGen;
    },
    begin() {
      submitGen++;
      submitPending = true;
      return submitGen;
    },
    invalidate() {
      submitGen++;
      submitPending = false;
    },
    clearPending() {
      submitPending = false;
    },
    beginCanned() {
      submitPending = true;
      cannedLaunchPending = true;
    },
    endCanned() {
      submitPending = false;
      cannedLaunchPending = false;
    },
  };
}
