import { useQuery } from '@tanstack/react-query';
import { handle401 } from '../utils/auth';

const fetchDatasets = async () => {
  let res = await fetch('/backend/datasets/datasets', { credentials: 'include' });

  if (res.status === 401) {
    const refreshed = await handle401();
    if (!refreshed) return [];
    res = await fetch('/backend/datasets/datasets', { credentials: 'include' });
  }

  if (!res.ok) throw new Error(`Failed to fetch datasets: ${res.status}`);
  const data = await res.json();
  return data.datasets ?? [];
};

export const useDatasets = () => {
  return useQuery({
    queryKey: ['datasets'],
    queryFn: fetchDatasets,
    staleTime: 5 * 60 * 1000,
  });
};
