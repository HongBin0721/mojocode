import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

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
