import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import cantonAlias from "../../utils/canton_alias.json";


/**
* Keeps map view centred when sidebar opens / resizes.
*/
export default function useMapPadding({
  mapRef,
  isGraphExpanded,
  selectedDestinationData,
}) {
  
  const cantonNumToNameRef = useRef({});

  useEffect(() => {
    if (!selectedDestinationData || !mapRef.current || !mapRef.current.getSource('cantons')) return;
    const map = mapRef.current;
    const { perCanton } = selectedDestinationData;
    if (!perCanton || Object.keys(perCanton).length === 0) return;
    
    // Remap perCanton to use canton names as keys
    const cantonNumToName = cantonNumToNameRef.current;
    const perCantonByName = {};
    Object.entries(perCanton).forEach(([num, data]) => {
      const name = cantonNumToName[num] || num;
      perCantonByName[name] = data;
    });
    
    // adds layer over cantons to be colored (placed before canton-borders)
    if (!map.getLayer('destination-choropleth')) {
      map.addLayer({
        id: 'destination-choropleth',
        type: 'fill',
        source: 'cantons',
        paint: {
          'fill-color': '#A07CC5',
          'fill-opacity': 0.6
        }
      }, 'canton-borders');
    }
    
    // Compute totals over all modes over all cantons 
    const allValues = { all: [], car: [], pt: [], bike: [], walk: [] };
    Object.values(perCantonByName).forEach(cantonData => {
      if (!cantonData || typeof cantonData !== 'object') return;
      Object.keys(allValues).forEach(mode => {
        if (cantonData[mode] && cantonData[mode] > 0) {
          allValues[mode].push(cantonData[mode]);
        }
      });
    });
    
    // get second largest value for each mode (or largest if only one value exists)
    const maxValues = {};
    Object.keys(allValues).forEach(mode => {
      const sortedValues = allValues[mode].sort((a, b) => b - a);
      maxValues[mode] = sortedValues.length > 1 ? sortedValues[1] : (sortedValues[0] || 0);
    });
    
    const MODE_COLORS = {
      car: "#636efa",
      pt: "#00cc96",
      bike: "#ab63fa",
      walk: "#ffa15a",
      all: "#1f77b4"
    };
    
    // build case expression for chloropleth
    const createColorExpression = (mode = 'all') => {
      const maxValue = maxValues[mode];
      if (maxValue === 0) return 'rgba(0,0,0,0)';
      
      const caseExpression = ['case'];
      Object.entries(perCantonByName).forEach(([canton, data]) => {
        if (!data || typeof data !== 'object') return;
        const value = data[mode] || 0;
        const intensity = Math.min(value / maxValue, 1);
        const baseColor = MODE_COLORS[mode] || MODE_COLORS.all;
        const hexToRgb = (hex) => {
          const bigint = parseInt(hex.slice(1), 16);
          return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
        };
        
        // use quartile based shading (otherwise counts are too sparse)
        const baseRgb = hexToRgb(baseColor);
        let colorIntensity;
        
        if (intensity <= 0.25) {
          colorIntensity = 0.25;
        } else if (intensity <= 0.5) {
          colorIntensity = 0.5;
        } else if (intensity <= 0.75) {
          colorIntensity = 0.75;
        } else {
          colorIntensity = 1.0;
        }
        
        const rgb1 = [255, 255, 255];
        const r = Math.round(rgb1[0] * (1 - colorIntensity) + baseRgb[0] * colorIntensity);
        const g = Math.round(rgb1[1] * (1 - colorIntensity) + baseRgb[1] * colorIntensity);
        const b = Math.round(rgb1[2] * (1 - colorIntensity) + baseRgb[2] * colorIntensity);
        const color = `rgb(${r},${g},${b})`;
        
        caseExpression.push(['==', ['get', 'NAME'], canton]);
        caseExpression.push(color);
      });
      
      // translucent as default color
      caseExpression.push('rgba(0,0,0,0)');
      return caseExpression;
    };
    map.setPaintProperty('destination-choropleth', 'fill-color', createColorExpression(selectedDestinationData.selectedMode || 'all'));
    map.setPaintProperty("canton-fill", "fill-opacity", 0);
  }, [selectedDestinationData]);
  
  useEffect(() => {
    if (!mapRef.current || !selectedDestinationData?.perCanton) return;
    const map = mapRef.current;
    const { perCanton } = selectedDestinationData;
    const cantonNumToName = cantonNumToNameRef.current;
    const perCantonByName = {};
    Object.entries(perCanton).forEach(([num, data]) => {
      const name = cantonNumToName[num] || num;
      perCantonByName[name] = data;
    });
    
    const handleMouseEnter = (e) => {
      const cantonName = e.features[0].properties.NAME;
      const cantonData = perCantonByName[cantonName];
      const selectedMode = selectedDestinationData.selectedMode || 'all';
      
      if (cantonData && typeof cantonData === 'object') {
        const modeLabels = {
          all: 'Total',
          car: 'Car',
          pt: 'Public Transport',
          bike: 'Bicycle',
          walk: 'Walk'
        };
        
        const selectedValue = cantonData[selectedMode] || 0;
        const selectedLabel = modeLabels[selectedMode] || 'Total';
        
        const popupContent = `
        <div style="font-size: 12px;">
          <strong>${cantonAlias[cantonName]}</strong><br/>
          <strong>Inflow from Origin:</strong><br/>
          <div style="font-weight: bold; color: #007AFF; margin: 4px 0;">
            ${selectedLabel}: ${selectedValue.toLocaleString()}
          </div>
          <div style="font-size: 11px; color: #666; border-top: 1px solid #ddd; padding-top: 4px;">
            Total: ${(cantonData.all || 0).toLocaleString()}<br/>
            Car: ${(cantonData.car || 0).toLocaleString()}<br/>
            Public Transport: ${(cantonData.pt || 0).toLocaleString()}<br/>
            Bicycle: ${(cantonData.bike || 0).toLocaleString()}<br/>
            Walk: ${(cantonData.walk || 0).toLocaleString()}
          </div>
        </div>
      `;
        new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(popupContent)
        .addTo(map);
      }
    };
    
    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = '';
      const popups = document.getElementsByClassName('mapboxgl-popup');
      if (popups.length) {
        popups[0].remove();
      }
    };
    
    if (map.getLayer('destination-choropleth')) {
      map.on('mouseenter', 'destination-choropleth', handleMouseEnter);
      map.on('mouseleave', 'destination-choropleth', handleMouseLeave);
    }
    return () => {
      if (map.getLayer('destination-choropleth')) {
        map.off('mouseenter', 'destination-choropleth', handleMouseEnter);
        map.off('mouseleave', 'destination-choropleth', handleMouseLeave);
      }
    };
  }, [selectedDestinationData?.perCanton]);
  
  // Hide/show destination choropleth based on graph selection
  useEffect(() => {
    if (!mapRef.current) return;
    
    const map = mapRef.current;
    if (map.getLayer('destination-choropleth') && isGraphExpanded !== "Destination") {
      map.setPaintProperty("canton-fill", "fill-opacity", 0.15);
      map.removeLayer('destination-choropleth')
    }
  }, [isGraphExpanded, selectedDestinationData]);
}
