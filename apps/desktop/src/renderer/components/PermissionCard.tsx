/**
 * 审批卡(ZCode 形态):rounded-2xl 浮层卡,标题「需要权限」+ 风险 chip +
 * mono 命令/路径行;决策是编号选项列表——数字键直选,↑↓/Tab 移动高亮,
 * Enter 确认高亮项,点击即决。plan 类(markdown 方案)保持批准/驳回两键。
 *
 * 决策语义(server 侧 PermissionDecision):
 *  - allow:仅本次;
 *  - allow-always + rule:本会话记住(suggestedRule 由 server 预计算);
 *  - allow-persist + rule:写入 <workspace>/.mojocode/config.json;
 *  - deny:拒绝(reason 可选,GUI 暂不收集)。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { PermissionDecision, PermissionRequest } from '@core/events';
import { t, useLocale } from '../i18n/index.js';
import { DiffView, looksLikeDiff } from './DiffView.js';
import { Markdown } from './Markdown.js';

interface OptionEntry {
  decision: PermissionDecision;
  labelKey: 'permission.allow' | 'permission.allowAlways' | 'permission.allowPersist' | 'permission.deny';
  descKey:
    | 'permission.allowDesc'
    | 'permission.allowAlwaysDesc'
    | 'permission.allowPersistDesc'
    | 'permission.denyDesc';
  danger: boolean;
}

/** 选项表:有 suggestedRule 时四档,否则单次/拒绝两档。 */
function buildOptions(suggestedRule: string | undefined): OptionEntry[] {
  const base: OptionEntry[] = [
    {
      decision: { type: 'allow' },
      labelKey: 'permission.allow',
      descKey: 'permission.allowDesc',
      danger: false,
    },
  ];
  if (suggestedRule) {
    base.push(
      {
        decision: { type: 'allow-always', rule: suggestedRule },
        labelKey: 'permission.allowAlways',
        descKey: 'permission.allowAlwaysDesc',
        danger: false,
      },
      {
        decision: { type: 'allow-persist', rule: suggestedRule },
        labelKey: 'permission.allowPersist',
        descKey: 'permission.allowPersistDesc',
        danger: false,
      },
    );
  }
  base.push({
    decision: { type: 'deny' },
    labelKey: 'permission.deny',
    descKey: 'permission.denyDesc',
    danger: true,
  });
  return base;
}

export function PermissionCard({
  request,
  onDecide,
}: {
  request: PermissionRequest;
  onDecide: (decision: PermissionDecision) => void;
}) {
  useLocale();
  const cardRef = useRef<HTMLDivElement>(null);
  const options = buildOptions(request.suggestedRule);
  const [selected, setSelected] = useState(0);
  const isPlan = request.kind === 'plan';
  const isDiff = !isPlan && request.detail !== undefined && looksLikeDiff(request.detail);

  // 挂载即聚焦:数字键/方向键不用先点进卡片。
  useEffect(() => {
    cardRef.current?.focus();
  }, [request.id]);

  /** 键盘流:数字键直选,↑↓/Tab 移动,Enter 决定高亮项。 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isPlan) return;
    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
      e.preventDefault();
      onDecide(options[digit - 1]!.decision);
      return;
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      setSelected((selected + 1) % options.length);
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      setSelected((selected - 1 + options.length) % options.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onDecide(options[selected]!.decision);
    }
  };

  return (
    <div
      ref={cardRef}
      className="permission"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="permission-card"
    >
      <div className="permission-head">
        <span className={`risk-chip risk-${request.risk}`}>{t(`risk.${request.risk}` as 'risk.write')}</span>
        <span className="permission-heading">
          {isPlan ? request.title : t('permission.title')}
        </span>
      </div>

      {isPlan ? (
        <div className="permission-plan-body">
          <Markdown text={request.detail ?? ''} />
        </div>
      ) : (
        <>
          <div className="permission-subtitle">{request.title}</div>
          {isDiff ? (
            <DiffView diff={request.detail!} />
          ) : request.detail ? (
            <pre className="permission-detail">{request.detail}</pre>
          ) : null}
        </>
      )}

      {request.suggestedRule && !isPlan ? (
        <div className="permission-rule">{t('permission.ruleLabel')}: {request.suggestedRule}</div>
      ) : null}

      {isPlan ? (
        <div className="permission-actions">
          <button type="button" className="btn-brand" onClick={() => onDecide({ type: 'allow' })}>
            {t('permission.planApprove')}
          </button>
          <button type="button" className="btn-danger" onClick={() => onDecide({ type: 'deny' })}>
            {t('permission.planDeny')}
          </button>
        </div>
      ) : (
        <>
          <div className="permission-options" role="listbox">
            {options.map((option, index) => (
              <button
                type="button"
                key={option.labelKey}
                className={`permission-option ${index === selected ? 'permission-option-selected' : ''}`}
                role="option"
                aria-selected={index === selected}
                onMouseEnter={() => setSelected(index)}
                onClick={() => onDecide(option.decision)}
              >
                <span className="permission-option-num">{index + 1}.</span>
                <span className="permission-option-main">
                  <span
                    className={`permission-option-label ${option.danger ? 'permission-option-label-danger' : ''}`}
                  >
                    {t(option.labelKey)}
                  </span>
                  <span className="permission-option-desc">{t(option.descKey)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="permission-footer">{t('permission.keysHint')}</div>
        </>
      )}
    </div>
  );
}
