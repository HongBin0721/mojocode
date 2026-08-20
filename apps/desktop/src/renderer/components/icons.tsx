/**
 * 图标统一出口。Codex 风格重构起改用 @phosphor-icons/react(具名 import、
 * SVG 内嵌 JS、离线可用),全部经本文件转发——组件永不直接 import 图标库,
 * 上游换库/换版本只动这一个文件。旧的行内 SVG(ZCode 1.8px 描边)与
 * Phosphor 并存,随组件逐个改造退役。
 */

import React from 'react';

/* ---- Phosphor 转发:regular 默认;fill 形态用 weight="fill" prop ---- */
export {
  CheckCircle as CheckCircleIcon,
  House as HouseIcon,
  ChatTeardropDots as ChatTeardropDotsIcon,
  Archive as ArchiveIcon,
  FolderSimple as FolderSimpleIcon,
  FolderPlus as FolderPlusIcon,
  FolderOpen as FolderOpenIcon,
  GitBranch as GitBranchIcon,
  CaretDown as CaretDownIcon,
  CaretRight as CaretRightIcon,
  CaretUp as CaretUpIcon,
  CaretUpDown as CaretUpDownIcon,
  Sparkle as SparkleIcon,
  Brain as BrainIcon,
  CircleDashed as CircleDashedIcon,
  CircleNotch as CircleNotchIcon,
  FileCode as FileCodeIcon,
  PaperPlaneRight as PaperPlaneRightIcon,
  Paperclip as PaperclipIcon,
  Cpu as CpuIcon,
  ArrowUp as ArrowUpIcon,
  ArrowsOutSimple as ArrowsOutSimpleIcon,
  ArrowsInSimple as ArrowsInSimpleIcon,
  ArrowSquareOut as ArrowSquareOutIcon,
  PushPin as PushPinIcon,
  MinusCircle as MinusCircleIcon,
  Envelope as EnvelopeIcon,
  Hash as HashIcon,
  Copy as CopyIcon,
  DotsThree as DotsThreeIcon,
  Translate as TranslateIcon,
  SlidersHorizontal as SlidersHorizontalIcon,
  Stack as StackIcon,
  Terminal as TerminalIcon,
  Tree as TreeIcon,
  MagnifyingGlass as MagnifyingGlassIcon,
  Globe as GlobeIcon,
  ListChecks as ListChecksIcon,
  Robot as RobotIcon,
  Check as CheckIcon,
  Eye as EyeIcon,
  EyeSlash as EyeOffIcon,
  Hand as HandIcon,
  ShieldCheck as ShieldCheckIcon,
  ClipboardText as ClipboardIcon,
  LockSimpleOpen as UnlockIcon,
  Gear as GearIcon,
} from '@phosphor-icons/react';

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

/** 下箭头(弹窗「高级」折叠)。 */
export const ChevronDownIcon = icon(<path d="M6 9l6 6 6-6" />);

/** 右箭头(级联菜单的二级入口)。 */
export const ChevronRightIcon = icon(<path d="M9 6l6 6-6 6" />);

/** 叉(弹窗关闭)。 */
export const XIcon = icon(<path d="M6 6l12 12M18 6L6 18" />);

/** 月亮(外观·深色主题)。 */
export const MoonIcon = icon(
  <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />,
);
