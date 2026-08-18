import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initCodeFontScale, initUiFontSize } from './utils/appearance.js';
import './styles/index.less';

// 恢复外观偏好(设置页·界面字号)——在首帧渲染前应用,避免字号跳动。
initUiFontSize();
initCodeFontScale();

// 平台类挂到 <html>:mac 的红绿灯让位等布局差异按这个类分流(底色全平台实色)。
try {
  if (window.mojocode?.platform === 'darwin') {
    document.documentElement.classList.add('platform-darwin');
  }
} catch {
  // 测试/异常环境下 window.mojocode 可能不存在,视觉退化为实体底。
}

const container = document.getElementById('root');
if (!container) throw new Error('index.html 缺少 #root 挂载点');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
