import { useEffect } from 'react';

export function useMountEffect(fn) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fn, []);
}
