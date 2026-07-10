import React, { useState } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import {
    AGE_SLIDER_MAX,
    DEFAULT_SOCIO_FILTERS,
    GENDER_OPTIONS,
    INCOME_OPTIONS,
    SUBSCRIPTION_OPTIONS,
    countActiveSocioFilters,
    isSocioDefault,
} from './socioFilterConfig';
import './SocioFilterPanel.css';

const SlidersIcon = () => (
    <svg className="socio-panel-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none">
            <line x1="1.5" y1="4" x2="14.5" y2="4" />
            <line x1="1.5" y1="8" x2="14.5" y2="8" />
            <line x1="1.5" y1="12" x2="14.5" y2="12" />
        </g>
        <circle cx="10.5" cy="4" r="2" fill="currentColor" />
        <circle cx="5" cy="8" r="2" fill="currentColor" />
        <circle cx="11.5" cy="12" r="2" fill="currentColor" />
    </svg>
);

const Chevron = ({ open }) => (
    <svg
        className={`socio-chevron${open ? ' open' : ''}`}
        viewBox="0 0 16 16"
        width="12"
        height="12"
        aria-hidden="true"
    >
        <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M4 6l4 4 4-4" />
    </svg>
);

const ageLabel = ([lo, hi]) =>
    (lo <= 0 && hi >= AGE_SLIDER_MAX) ? 'All ages' : `${lo} – ${hi}`;

/**
 * Controlled, presentational socioeconomic (person) filter panel.
 *
 * Zero context imports, zero data fetching, zero useEffect — the only local
 * state is UI ephemera (collapse toggle + in-progress slider drag). It emits a
 * brand-new filters object via `onChange` on every change; the age slider only
 * commits on release (onChangeComplete) so a drag doesn't spam refetches.
 *
 *   <SocioFilterPanel value={socioFilters} onChange={setSocioFilters} />
 *
 * `bare` drops the collapsible header (visibility is then the caller's job —
 * e.g. a toolbar button toggling the whole panel) and moves Clear to the
 * bottom of the body.
 */
const SocioFilterPanel = ({ value, onChange, bare = false }) => {
    const filters = value || DEFAULT_SOCIO_FILTERS;
    const [collapsed, setCollapsed] = useState(true);

    // Drag-in-progress age handles. `onChange` (slider) updates local state so
    // the label tracks the drag; `onChangeComplete` commits to the parent.
    const [ageDraft, setAgeDraft] = useState(filters.ageRange);
    // Sync local draft from props via the render-time "previous value" pattern
    // (no useEffect): when the incoming prop range changes, adopt it.
    const [lastAge, setLastAge] = useState(filters.ageRange);
    if (filters.ageRange !== lastAge) {
        setLastAge(filters.ageRange);
        setAgeDraft(filters.ageRange);
    }

    const activeCount = countActiveSocioFilters(filters);
    const showClear = !isSocioDefault(filters);

    const emit = (patch) => onChange?.({ ...filters, ...patch });

    const toggleInList = (list, val) =>
        list.includes(val) ? list.filter((v) => v !== val) : [...list, val];

    const handleClear = (e) => {
        e.stopPropagation();
        onChange?.({ ...DEFAULT_SOCIO_FILTERS });
    };

    return (
        <div className={`socio-panel${bare ? ' socio-panel-bare' : ''}`}>
            {!bare && (
                <div
                    className="socio-header"
                    onClick={() => setCollapsed((c) => !c)}
                    role="button"
                    tabIndex={0}
                >
                    <SlidersIcon />
                    <span className="socio-title">Person Filters</span>
                    {activeCount > 0 && <span className="socio-badge">{activeCount}</span>}
                    <span className="socio-header-spacer" />
                    {showClear && (
                        <button type="button" className="socio-clear-btn" onClick={handleClear}>
                            Clear
                        </button>
                    )}
                    <Chevron open={!collapsed} />
                </div>
            )}

            {(bare || !collapsed) && (
                <div className="socio-body">
                    {/* Gender */}
                    <div className="socio-row">
                        <label className="socio-row-label">Gender</label>
                        <div className="socio-segmented">
                            {GENDER_OPTIONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    className={`socio-seg-btn${filters.gender === opt.value ? ' active' : ''}`}
                                    onClick={() => emit({ gender: opt.value })}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Age */}
                    <div className="socio-row">
                        <label className="socio-row-label">Age: {ageLabel(ageDraft)}</label>
                        <div className="socio-slider-wrap">
                            <Slider
                                range
                                min={0}
                                max={AGE_SLIDER_MAX}
                                step={1}
                                value={ageDraft}
                                onChange={(val) => setAgeDraft(val)}
                                onChangeComplete={(val) => emit({ ageRange: val })}
                                allowCross={false}
                            />
                        </div>
                    </div>

                    {/* Income */}
                    <div className="socio-row">
                        <label className="socio-row-label">Income Class</label>
                        <div className="socio-chips">
                            {INCOME_OPTIONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    className={`socio-chip${filters.incomeClasses.includes(opt.value) ? ' active' : ''}`}
                                    onClick={() => emit({ incomeClasses: toggleInList(filters.incomeClasses, opt.value) })}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* PT Subscription */}
                    <div className="socio-row">
                        <label className="socio-row-label">PT Subscription</label>
                        <div className="socio-chips">
                            {SUBSCRIPTION_OPTIONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    className={`socio-chip${filters.subscriptions.includes(opt.value) ? ' active' : ''}`}
                                    onClick={() => emit({ subscriptions: toggleInList(filters.subscriptions, opt.value) })}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {bare && showClear && (
                        <button
                            type="button"
                            className="socio-clear-btn socio-clear-bottom"
                            onClick={handleClear}
                        >
                            Clear all
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default SocioFilterPanel;
