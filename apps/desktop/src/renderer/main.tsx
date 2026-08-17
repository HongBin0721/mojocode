import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initUiFontSize } from './utils/appearance.js';
import './styles.css';

// 恢复外观偏好(设置页·界面字号)——在首帧渲染前应用,避免字号跳动。
initUiFontSize();

// 平台类挂到 <html>:mac 走透明底 + vibrancy(body 透明),其余平台实体底色。
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
