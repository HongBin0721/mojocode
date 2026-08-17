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

/** 思考强度(「脑回路」风格的圆)。 */
export const EffortIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12c1.2-2.2 2-2.2 3.5 0s2.3 2.2 3.5 0" />
  </>,
);
