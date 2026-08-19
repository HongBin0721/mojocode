/**
 * 图片附件(自 Composer.tsx 拆出):剪贴板/拖入/+ 按钮共用的追加逻辑,
 * 非图片静默忽略;拖拽悬停态一并收编。
 */

import { useState, type DragEvent, type ClipboardEvent } from 'react';
import type { ImageAttachment } from '@core/attachments';

/** 剪贴板/拖入的图片文件 → ImageAttachment(base64)。 */
async function toAttachment(file: File, index: number): Promise<ImageAttachment> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return {
    mediaType: file.type || 'image/png',
    data: btoa(binary),
    filename: file.name || `clipboard-${index}.png`,
  };
}

export function useAttachments() {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);

  /** 追加图片附件;非图片静默忽略。 */
  const addFiles = (list: Iterable<File>) => {
    const files = Array.from(list).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    void Promise.all(files.map((file, index) => toAttachment(file, index))).then((added) =>
      setImages((prev) => [...prev, ...added]),
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setDragging(true);
    }
  };

  const onDragLeave = (e: DragEvent) => {
    if ((e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
    setDragging(false);
  };

  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length === 0) return;
    e.preventDefault();
    addFiles(e.clipboardData.files);
  };

  const removeAt = (index: number) => setImages((prev) => prev.filter((_, i) => i !== index));
  const clear = () => setImages([]);

  return { images, dragging, addFiles, onDrop, onDragOver, onDragLeave, onPaste, removeAt, clear };
}
