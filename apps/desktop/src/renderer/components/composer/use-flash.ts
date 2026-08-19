/** 模式值变化时品牌色环闪 2s(自 Composer.tsx 拆出;原顶栏徽章闪动的迁入)。 */

import { useEffect, useRef, useState } from 'react';

export function useFlash(value: string | undefined): boolean {
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== undefined && prev.current !== value) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 2000);
      prev.current = value;
      return () => clearTimeout(timer);
    }
    prev.current = value;
    return;
  }, [value]);
  return flash;
}
