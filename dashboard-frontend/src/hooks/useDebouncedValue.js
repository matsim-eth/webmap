import { useEffect, useState } from 'react';

/**
 * Returns a delayed copy of `value` that only updates after `delayMs` of
 * stillness. Use to avoid expensive downstream work on every keystroke
 * while keeping the input itself responsive.
 *
 * Pattern:
 *   const [term, setTerm] = useState('');
 *   const debounced = useDebouncedValue(term, 150);
 *   const filtered = useMemo(() => filter(debounced), [debounced]);
 */
export function useDebouncedValue(value, delayMs = 150) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
