/**
 * 附件大图预览(lightbox):Modal 骨架上的图片变体。关闭走 Modal 现成的
 * 三条路——Esc(浮层栈仲裁)、backdrop 点击、图片自身点击(lightbox 惯例,
 * 看完随手一点就走)。卡片类用 image-preview-card 把 modal-card 的定宽
 * 表单形态改成随图自适应。
 */

import React from 'react';
import type { TimelineImage } from '@core/types';
import { t } from '../../i18n/index.js';
import { imageDataUri } from '../../utils/image.js';
import { Modal } from './Modal.js';

// 入参只收真正读到的字段:声明成带 absolutePath 的 ImageAttachment,时间线
// 那条路(TimelineImage)靠结构兼容才编得过,将来谁在这里读 absolutePath
// 就会静默拿到 undefined。
export function ImagePreview({ image, onClose }: { image: TimelineImage; onClose: () => void }) {
  return (
    <Modal
      variant="modal"
      cardClassName="image-preview-card"
      ariaLabel={t('image.preview')}
      onClose={onClose}
    >
      <img
        className="image-preview-img"
        src={imageDataUri(image)}
        alt={image.filename ?? ''}
        onClick={onClose}
      />
      {image.filename ? <div className="image-preview-name">{image.filename}</div> : null}
    </Modal>
  );
}
