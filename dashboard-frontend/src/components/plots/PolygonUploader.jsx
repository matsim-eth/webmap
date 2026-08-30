import React, { useMemo, useRef } from 'react';
import './PolygonUploader.css';
import { useDashboard } from '../../context/DashboardContext';

// Pull keys from a feature's properties bag. Lots of GeoJSON exports include
// junk keys (`OBJECTID`, `Shape_Length`, etc.); we keep them all and let the
// user pick. Auto-default to the first reasonable string-typed key.
const collectPropertyKeys = (features) => {
  const keys = new Set();
  for (const f of features) {
    const props = f?.properties;
    if (props && typeof props === 'object') {
      for (const k of Object.keys(props)) keys.add(k);
    }
  }
  return [...keys];
};

const PREFERRED_NAME_KEYS = ['name', 'NAME', 'Name', 'label', 'Label', 'gemname'];

const pickDefaultNameKey = (keys, features) => {
  for (const candidate of PREFERRED_NAME_KEYS) {
    if (keys.includes(candidate)) return candidate;
  }
  // Fallback: first key whose value is a string in the first feature.
  const sample = features?.[0]?.properties;
  if (sample) {
    for (const k of keys) {
      if (typeof sample[k] === 'string') return k;
    }
  }
  return keys[0] ?? null;
};

const isPolygonalFeature = (f) =>
  f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon';

const PolygonUploader = () => {
  const { polygonSet, setPolygonSet, resetPolygonSet, primaryZoneType, zoneLabelPlural } = useDashboard();
  const fileInputRef = useRef(null);

  const isCustom = polygonSet?.kind === 'custom';

  // Double-offering guard (plan §F2.4): the default polygon set aggregates
  // boardings by MUNICIPALITY. For a dataset whose PRIMARY zone type is already
  // 'gemeinde' (a re-zoned single canton), that municipality overlay coincides
  // with the primary zones the rest of the dashboard already shows — so the
  // default is redundant rather than a distinct level. We don't remove it (it
  // still works), but we relabel it so the user understands it's the same level.
  const muniIsPrimary = primaryZoneType === 'gemeinde';

  const onPickFile = () => fileInputRef.current?.click();

  const onFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-uploading the same file
    if (!file) return;

    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const featuresRaw = Array.isArray(json?.features)
        ? json.features
        : Array.isArray(json)
          ? json
          : (json?.type === 'Feature' ? [json] : null);
      if (!featuresRaw) {
        // eslint-disable-next-line no-alert
        alert('File is not a GeoJSON FeatureCollection');
        return;
      }
      const features = featuresRaw.filter(isPolygonalFeature);
      if (!features.length) {
        // eslint-disable-next-line no-alert
        alert('No Polygon / MultiPolygon features found in the file');
        return;
      }
      const keys = collectPropertyKeys(features);
      const nameProperty = pickDefaultNameKey(keys, features);

      setPolygonSet({
        kind: 'custom',
        name: file.name,
        features,
        nameProperty,
        availableProperties: keys,
      });
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Failed to parse GeoJSON: ${err?.message ?? 'unknown error'}`);
    }
  };

  const onChangeNameProperty = (e) => {
    if (!isCustom) return;
    setPolygonSet({ ...polygonSet, nameProperty: e.target.value });
  };

  const summary = useMemo(() => {
    if (!isCustom) {
      return muniIsPrimary
        ? `Default: ${zoneLabelPlural} (primary zones)`
        : 'Default: Municipalities';
    }
    const featCount = polygonSet?.features?.length ?? 0;
    return `${polygonSet.name} (${featCount} polygons)`;
  }, [isCustom, polygonSet, muniIsPrimary, zoneLabelPlural]);

  return (
    <div className="control-group polygon-uploader-group">
      <label className="control-label">Polygons</label>
      <div className="polygon-uploader-inline">
        <span className="polygon-uploader-summary" title={summary}>{summary}</span>

        {isCustom && polygonSet?.availableProperties?.length > 0 && (
          <select
            className="polygon-uploader-prop"
            value={polygonSet.nameProperty ?? ''}
            onChange={onChangeNameProperty}
            title="Property used as polygon label"
          >
            {polygonSet.availableProperties.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        )}

        <button type="button" className="toggle-btn" onClick={onPickFile}>
          {isCustom ? 'Replace' : 'Upload'}
        </button>
        {isCustom && (
          <button
            type="button"
            className="toggle-btn"
            onClick={resetPolygonSet}
            title="Reset to default municipalities"
          >
            Reset
          </button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".geojson,application/geo+json,application/json,.json"
          style={{ display: 'none' }}
          onChange={onFileChange}
        />
      </div>
    </div>
  );
};

export default PolygonUploader;
