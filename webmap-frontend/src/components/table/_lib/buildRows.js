/**
 * Geojson → DataTable rows. Each module's table uses a different shape, so
 * `selectedGraph` switches the row builder between Transit (one row per
 * stop, parses `modes_list`/`line_ids`) and the network-style modules
 * (Network/Volumes/TransitVolumes — one row per direction, parses the
 * pipe-delimited `per_id_*` arrays).
 *
 * The `searchString` field on Transit rows holds a pipe-joined alternation
 * of the visible cells plus an accent-normalized copy of the stop name, so
 * DataTables' hidden-column "All columns" search picks up `geneve` for
 * `Genève` without needing a custom search function.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Strip diacritics on the BMP characters that show up in Swiss canton /
 * stop names (French/German). Used both at row-build time (Transit
 * `searchString`) and at search time (term expansion in useDataTable).
 * Kept as a plain regex chain — no `String.normalize('NFD')` — to avoid
 * stripping characters that aren't accents.
 */
export const normalizeAccents = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/[äàáâã]/gi, 'a')
    .replace(/[ëèéê]/gi, 'e')
    .replace(/[ïìíî]/gi, 'i')
    .replace(/[öòóôõ]/gi, 'o')
    .replace(/[üùúû]/gi, 'u')
    .replace(/[ÿ]/gi, 'y')
    .replace(/[ç]/gi, 'c')
    .replace(/[ñ]/gi, 'n');
};

/**
 * True when `selectedModes` is unset / "all" / empty, OR `rowModes`
 * (comma-separated) intersects the selected list. Used by the table to
 * apply the sidebar mode filter without re-running the row builder.
 */
export const modeMatches = (rowModes, selectedModes) => {
  if (
    !Array.isArray(selectedModes) ||
    selectedModes.length === 0 ||
    selectedModes.includes("all")
  )
    return true;
  const modes = String(rowModes || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (!modes.length) return false;
  return selectedModes.some((m) => modes.includes(m));
};

/** Faster: precompute formatted strings once per row; keep raw numbers for sort */
export const buildRowsFromGeojson = (geojson, selectedGraph = null) => {
  if (!geojson?.features) return [];

  const rows = [];
  geojson.features.forEach((feature, featureIndex) => {
    const props = feature?.properties || {};

    // Handle Transit stops differently
    if (selectedGraph === 'Transit') {
      const stopName = props.name || "Unknown Stop";

      // Parse modes_list
      let modesList = [];
      if (typeof props.modes_list === 'string') {
        try {
          modesList = JSON.parse(props.modes_list);
        } catch {
          modesList = props.modes_list.split(',').map(m => m.trim()).filter(Boolean);
        }
      } else if (Array.isArray(props.modes_list)) {
        modesList = props.modes_list;
      }
      const modes = Array.isArray(modesList) && modesList.length > 0
        ? modesList.join(", ")
        : "-";

      // Parse line_ids to count number of unique lines
      let lineIds = [];
      if (Array.isArray(props.line_ids)) {
        lineIds = props.line_ids;
      } else if (typeof props.line_ids === 'string') {
        try {
          lineIds = JSON.parse(props.line_ids);
        } catch {
          lineIds = [];
        }
      }
      const uniqueLineIds = Array.isArray(lineIds) ? [...new Set(lineIds)] : [];
      const lineCount = uniqueLineIds.length;

      // Volumes were attached upstream by useTransitStops
      const boardings = props.boardings || 0;
      const alightings = props.alightings || 0;

      const g = feature?.geometry;
      const coords = g?.type === "Point" ? g.coordinates : null;

      // Pipe-joined searchString backs the hidden "All columns" search
      // column. The normalized stop name lets `geneve` match `Genève`.
      const searchString = [
        stopName,
        normalizeAccents(stopName),
        modes,
        String(lineCount),
        String(boardings),
        String(alightings)
      ].join('|');

      rows.push({
        rowKey: `transit-stop-${featureIndex}`,
        tableId: featureIndex,
        stopName,
        modes,
        lineCount,
        boardings,
        alightings,
        searchString,
        coords,
        feature,
        featureProps: props
      });

      return;
    }

    // Network/Volumes/TransitVolumes: one row per direction in per_id_keys.
    const keys      = (props.per_id_keys || "").split("|").filter(Boolean);
    const capacities= (props.per_id_capacities || "").split("|").filter(Boolean);
    const lengths   = (props.per_id_lengths || "").split("|").filter(Boolean);
    const freespeeds= (props.per_id_freespeeds || "").split("|").filter(Boolean);
    const daily_avgs= (props.per_id_daily_avgs || "").split("|").filter(Boolean);
    const arrows    = (props.per_id_arrows || "").split("|").filter(Boolean);
    const directions= (props.per_id_directions || "").split("|").filter(Boolean);

    const tableId = Number(featureIndex);

    const g = feature?.geometry;
    const coords =
      g.type === "LineString"
        ? g.coordinates
        : g.type === "MultiLineString"
        ? g.coordinates.flat()
        : null;

    const roundTo = (value, decimals = 0) => {
      if (!Number.isFinite(value)) return value;
      const factor = Math.pow(10, decimals);
      return Math.round(value * factor) / factor;
    };

    const pushRow = (index) => {
      const directionId = keys[index] || null;
      const length      = num(lengths[index]);
      const freeSpeed   = num(freespeeds[index]);
      const capacity    = num(capacities[index]);
      const arrow       = arrows[index] || null;
      const direction   = directions[index] || null;

      // Total Daily Volume column.
      let totalVol;
      if (selectedGraph === 'TransitVolumes') {
        // TransitVolumes: directional total volumes baked by useTransitVolumesLayer.
        if (arrow === '←') {
          totalVol = props.total_left;
        } else if (arrow === '→') {
          totalVol = props.total_right;
        } else {
          totalVol = props.total_volume;
        }
      } else if (selectedGraph === 'Volumes') {
        // Volumes: full-day directional total (left_total/right_total), derived
        // from the backend traffic volumes by useNetworkLayers. Mirrors the
        // directional Filtered Volume (left_sum/right_sum) so the two columns
        // stay consistent (Total ≥ Filtered, equal at full window) instead of
        // mixing a per-link total against a directional filtered value.
        if (arrow === '←') {
          totalVol = num(props.left_total);
        } else if (arrow === '→') {
          totalVol = num(props.right_total);
        } else {
          totalVol = num(daily_avgs[index]);
        }
      } else {
        // Network (no time-windowed volumes): per-link daily average.
        totalVol = num(daily_avgs[index]);
      }

      // Filtered (time-windowed) volume — only set for Volumes / TransitVolumes
      let filteredVolume = null;
      if (selectedGraph === 'Volumes' || selectedGraph === 'TransitVolumes') {
        if (arrow === '←') {
          filteredVolume = num(props.left_sum);
        } else if (arrow === '→') {
          filteredVolume = num(props.right_sum);
        }
      }

      // Sum capacity across all directions for the major-roads filter
      let totalCapacity = 0;
      capacities.forEach(cap => {
        const c = num(cap);
        if (c !== null) totalCapacity += c;
      });

      rows.push({
        rowKey: `${tableId}-${directionId ?? "all"}-${rows.length}`,
        tableId,
        directionId: directionId ?? null,
        length:    length    ? roundTo(length, 1)    : length,
        freeSpeed: freeSpeed ? roundTo(freeSpeed, 1) : freeSpeed,
        capacity,
        totalCapacity,
        totalVol,
        filteredVolume: filteredVolume ? roundTo(filteredVolume, 1) : filteredVolume,
        modes: props.modes || "",
        coords,
        feature,
        featureProps: props,
        arrow,
        direction
      });
    };

    if (keys.length > 0) {
      keys.forEach((_, index) => pushRow(index));
    } else {
      pushRow(0);
    }
  });
  return rows;
};
