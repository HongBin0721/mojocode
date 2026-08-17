/**
 * 行内 SVG 图标(ZCode 视觉语言:1.8px 描边、圆角端点、currentColor)。
 * 统一在这里维护,组件按需引用——不引第三方图标库。加新图标只写 path,
 * 包装样板由 icon() 工厂生成。
 */

import React from 'react';

interface IconProps {
  size?: number;
}

function icon(paths: React.ReactNode): (props: IconProps) => React.JSX.Element {
  return function Icon({ size = 14 }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {paths}
      </svg>
    );
  };
}

/** 盾牌(权限档 chip)。 */
export const ShieldIcon = icon(<path d="M12 3l7 3.2v5.3c0 4.6-3 8.1-7 9.5-4-1.4-7-4.9-7-9.5V6.2z" />);

/** 加号(附件按钮/分组「新任务」)。 */
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);

/** 圆圈加号(侧栏「新建任务」)。 */
export const CirclePlusIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </>,
);

/** 放大镜(搜索)。 */
export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </>,
);

/** 文件夹(项目分组/项目 chip)。 */
export const FolderIcon = icon(
  <path d="M3 7a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
);

/** git 分支(顶栏分支 chip)。 */
export const BranchIcon = icon(
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7M18 10.5c0 3-2.5 4.5-6 4.5" />
  </>,
);

/** 齿轮(设置)。 */
export const GearIcon = icon(
  <>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
  </>,
);

/** 左箭头(设置页「返回工作区」)。 */
export const ArrowLeftIcon = icon(<path d="M19 12H5M11 6l-6 6 6 6" />);

/** 滑杆(设置页·常规)。 */
export const SlidersIcon = icon(
  <>
    <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
    <circle cx="16" cy="8" r="2.2" />
    <circle cx="8" cy="16" r="2.2" />
  </>,
);

/** 调色盘(设置页·外观)。 */
export const PaletteIcon = icon(
  <>
    <path d="M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 0-5H12a2 2 0 0 1 0-4h6a3 3 0 0 0 3-3c0-3.3-4-6-9-6z" />
    <circle cx="7.5" cy="11" r="0.6" />
    <circle cx="10" cy="7" r="0.6" />
    <circle cx="14.5" cy="7" r="0.6" />
  </>,
);

/** 层叠(设置页·模型设置)。 */
export const LayersIcon = icon(
  <>
    <path d="M12 3l9 5-9 5-9-5z" />
    <path d="M3 13l9 5 9-5" />
  </>,
);

/** 铅笔(编辑模型条目)。 */
export const PencilIcon = icon(
  <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />,
);

/** 垃圾桶(删除模型/供应商)。 */
export const TrashIcon = icon(
  <>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
  </>,
);

/** 链接(切换到该模型)。 */
export const LinkIcon = icon(
  <>
    <path d="M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.6-5.6l-1.7 1.7" />
    <path d="M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.6 5.6l1.7-1.7" />
  </>,
);

/** 眼睛(API Key 明文切换)。 */
export const EyeIcon = icon(
  <>
    <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </>,
);

/** 划线的眼睛(隐藏 API Key)。 */
export const EyeOffIcon = icon(
  <>
    <path d="M4 4l16 16" />
    <path d="M9.9 5.9A9.9 9.9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-3.2 3.9M6 7.3A16.8 16.8 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 3.5-.7" />
    <path d="M9.8 9.8a2.8 2.8 0 0 0 4 4" />
  </>,
);

/** 下箭头(弹窗「高级」折叠)。 */
export const ChevronDownIcon = icon(<path d="M6 9l6 6 6-6" />);

/** 右箭头(级联菜单的二级入口)。 */
export const ChevronRightIcon = icon(<path d="M9 6l6 6-6 6" />);

/** 叉(弹窗关闭)。 */
export const XIcon = icon(<path d="M6 6l12 12M18 6L6 18" />);

/** 手掌(权限档·询问:改动前先确认)。 */
export const HandIcon = icon(
  <>
    <path d="M18 11.5V7a1.5 1.5 0 0 0-3 0" />
    <path d="M15 10.5V5a1.5 1.5 0 0 0-3 0" />
    <path d="M12 10.5V6a1.5 1.5 0 0 0-3 0v7" />
    <path d="M18 8.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1c-2.3 0-3.7-.7-4.9-2l-3.4-3.5a1.7 1.7 0 0 1 2.4-2.4L9 15" />
  </>,
);

/** 盾+勾(权限档·自动编辑)。 */
export const ShieldCheckIcon = icon(
  <>
    <path d="M12 3l7 3.2v5.3c0 4.6-3 8.1-7 9.5-4-1.4-7-4.9-7-9.5V6.2z" />
    <path d="M9 12l2 2 4-4.5" />
  </>,
);

/** 剪贴板(权限档·计划模式)。 */
export const ClipboardIcon = icon(
  <>
    <rect x="8" y="3" width="8" height="4" rx="1" />
    <path d="M8 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H16" />
  </>,
);

/** 开锁(权限档·完全访问)。 */
export const UnlockIcon = icon(
  <>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.8-1.2" />
  </>,
);

/** 勾(选择器当前项)。 */
export const CheckIcon = icon(<path d="M5 12.5l4.5 4.5L19 7" />);

/** 月亮(外观·深色主题)。 */
export const MoonIcon = icon(
  <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />,
);

/** 思考强度(「脑回路」风格的圆)。 */
export const EffortIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12c1.2-2.2 2-2.2 3.5 0s2.3 2.2 3.5 0" />
  </>,
);
