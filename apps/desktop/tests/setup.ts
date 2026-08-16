/**
 * 组件测试的公共 setup:@testing-library/react 的自动 cleanup 依赖全局
 * afterEach——vitest 默认 globals:false 时拿不到,这里显式注册,否则前一个
 * 用例的 DOM 残留进下一个查询。
 */

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);
