import { useState, useEffect } from 'react';

/**
 * Hook that debounces a value by the specified delay.
 * @param {*} value - The value to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {*} The debounced value
 */
export function useDebounced(value, delay = 200) {
  const [debounced, setDebounced] = useState(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const handler = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debounced;
}
