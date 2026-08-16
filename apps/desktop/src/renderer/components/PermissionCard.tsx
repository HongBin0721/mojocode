/**
 * 审批卡:tool 类(detail 是 diff 时走 DiffView,否则命令/说明文本;四档
 * 决策)与 plan 类(markdown 方案;批准/拒绝)两种形态。
 *
 * 决策语义(server 侧 PermissionDecision):
 *  - allow:仅本次;
 *  - allow-always + rule:本会话记住(suggestedRule 由 server 预计算);
 *  - allow-persist + rule:写入 <workspace>/.mojocode/config.json;
 *  - deny:拒绝(reason 可选,GUI 暂不收集)。
 */

import React from 'react';
import type { PermissionRequest } from '@core/events';
import { t, useLocale } from '../i18n/index.js';
import { DiffView, looksLikeDiff } from './DiffView.js';
import { Markdown } from './Markdown.js';

export function PermissionCard({
  request,
  onDecide,
}: {
  request: PermissionRequest;
  onDecide: (decision: import('@core/events').PermissionDecision) => void;
}) {
  useLocale();
  const isPlan = request.kind === 'plan';
  const isDiff = !isPlan && request.detail !== undefined && looksLikeDiff(request.detail);

  return (
    <div className={`permission ${isPlan ? 'permission-plan' : `permission-risk-${request.risk}`}`}>
      <div className="permission-head">
        <span className={`risk-chip risk-${request.risk}`}>{t(`risk.${request.risk}` as 'risk.write')}</span>
        <span className="permission-title">{request.title}</span>
      </div>

      {isPlan ? (
        <div className="permission-plan-body">
          <Markdown text={request.detail ?? ''} />
        </div>
      ) : isDiff ? (
        <DiffView diff={request.detail!} />
      ) : request.detail ? (
        <pre className="permission-detail">{request.detail}</pre>
      ) : null}

      {request.suggestedRule ? (
        <div className="permission-rule">规则:{request.suggestedRule}</div>
      ) : null}

      <div className="permission-actions">
        {isPlan ? (
          <>
            <button type="button" className="btn-primary" onClick={() => onDecide({ type: 'allow' })}>
              {t('permission.planApprove')}
            </button>
            <button type="button" className="btn-danger" onClick={() => onDecide({ type: 'deny' })}>
              {t('permission.planDeny')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn-primary" onClick={() => onDecide({ type: 'allow' })}>
              {t('permission.allow')}
            </button>
            {request.suggestedRule ? (
              <>
                <button
                  type="button"
                  onClick={() => onDecide({ type: 'allow-always', rule: request.suggestedRule! })}
                >
                  {t('permission.allowAlways')}
                </button>
                <button
                  type="button"
                  onClick={() => onDecide({ type: 'allow-persist', rule: request.suggestedRule! })}
                >
                  {t('permission.allowPersist')}
                </button>
              </>
            ) : null}
            <button type="button" className="btn-danger" onClick={() => onDecide({ type: 'deny' })}>
              {t('permission.deny')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
