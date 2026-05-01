import { DataProvider, useData } from './DataContext';
import { ChoroplethProvider, useChoropleth } from './ChoroplethContext';
import { FilterProvider, useFilters } from './FilterContext';
import { SelectionProvider, useSelection } from './SelectionContext';
import { ModuleProvider, useModule } from './ModuleContext';
import { MapProvider, useMap } from './MapContext';

/**
 * Composed app provider. AppContext was previously a single god-context
 * with ~50 fields; it now nests six narrower providers so each consumer
 * only re-renders when the slice it actually reads changes.
 *
 * Nesting order matters — inner providers consume outer ones:
 *   Data → Choropleth → Filter → Selection → Module(needs Selection) → Map(needs all).
 */
export const AppProvider = ({ children }) => (
  <DataProvider>
    <ChoroplethProvider>
      <FilterProvider>
        <SelectionProvider>
          <ModuleProvider>
            <MapProvider>{children}</MapProvider>
          </ModuleProvider>
        </SelectionProvider>
      </FilterProvider>
    </ChoroplethProvider>
  </DataProvider>
);

/**
 * Compat shim. Combines all six narrower hooks into a single flat object
 * mirroring the legacy useApp() shape. Prefer the narrower hooks
 * (useMap / useModule / useSelection / useFilters / useData / useChoropleth)
 * in new code — useApp() will be removed once all call sites have migrated.
 */
export const useApp = () => ({
  ...useData(),
  ...useChoropleth(),
  ...useFilters(),
  ...useSelection(),
  ...useModule(),
  ...useMap(),
});
