export const getRouteDirection = (routeId) => {
  if (!routeId) return null;
  if (routeId.endsWith('.H')) return 'outbound';
  if (routeId.endsWith('.R')) return 'return';
  return null;
};

export const filterRoutesByDirection = (routeIds, direction) => {
  if (!routeIds || direction === 'total') return routeIds;
  const suffix = direction === 'outbound' ? '.H' : '.R';
  return routeIds.filter(id => id.endsWith(suffix));
};
