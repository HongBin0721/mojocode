/**
 * doctor 门面:实现按分节拆在 ./doctor/ 下(types / util / 各分节检查 /
 * report 组装 / format 渲染),这里只保留稳定公共导出,消费方
 * (src/cli.tsx、TUI 的 /doctor、remote 客户端、测试)的导入路径不变。
 */
export type {
  CheckLevel,
  DoctorCheck,
  DoctorSection,
  DoctorReport,
  DoctorInput,
  DoctorOptions,
} from './doctor/types.js';
export { runDoctor, collectDoctor } from './doctor/report.js';
export { formatDoctor } from './doctor/format.js';
export { compareVersions } from './doctor/util.js';
