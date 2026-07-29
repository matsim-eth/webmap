/**
 * Which modules relate to the shared MATSim network layers, and who owns them.
 *
 * `network-source` / `network-layer` / `network-layer-hitbox` are created and
 * torn down by `useNetworkLayers` alone, but several other hooks touch their
 * paint, filter or visibility while their own module is active. That is fine as
 * long as every one of them agrees on WHO owns the base network right now —
 * without a shared answer, a hook that runs later in the same commit can undo
 * `useNetworkLayers`' decision (which is exactly how the road network came back
 * on top of Transit Volumes: LinkSpeeds' module-exit teardown re-showed
 * `network-layer` after useNetworkLayers had just hidden it).
 */

/** Modules whose own symbology IS the road network (useNetworkLayers draws it). */
export const ROAD_NETWORK_MODULES = new Set([
  'Network', 'Volumes', 'VolumeFlow', 'NodeFlows', 'LinkSpeeds',
]);

/**
 * Modules that render the SAME MATSim links with their own symbology and own
 * source. The base road layers are hidden (not destroyed) while these are
 * active, so the return trip is a show() rather than a re-tile.
 */
export const SHARES_NETWORK_GEOMETRY = new Set(['TransitVolumes']);

/**
 * True when `module` is the one the base `network-layer` belongs to — i.e. when
 * it may be visible. Any hook restoring base-network visibility on module exit
 * must gate on this, or it will resurrect the road network over whatever module
 * the user actually switched to.
 */
export const ownsBaseNetwork = (module) => ROAD_NETWORK_MODULES.has(module);
