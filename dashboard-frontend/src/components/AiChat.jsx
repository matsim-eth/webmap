import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import Plot from 'react-plotly.js';
import { useDashboard } from '../context/DashboardContext';
import { handle401 } from '../utils/auth';
import './AiChat.css';

// crypto.randomUUID() only exists in secure contexts (HTTPS / localhost) -
// on a plain-HTTP dev host it is undefined and would crash the component.
function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  (globalThis.crypto?.getRandomValues
    ? crypto.getRandomValues(b)
    : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); }));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}


/**
 * Dashboard variant of the Ask-AI chat. Same backend agent as the webmap
 * (charts, tables, cross-run comparisons); map displays are summarized as
 * notes. Extra surface: AI-managed dashboard tiles (session-only) — the
 * agent pins its last rendered chart via ui_action add_tile / remove_tile.
 */

const TRACE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444',
  '#0ea5e9', '#a855f7', '#84cc16', '#64748b'];

// ── Session tile state (shared between chat and the tile strip) ──────────

const AiTilesContext = createContext(null);

export function AiTilesProvider({ children }) {
  const [tiles, setTiles] = useState([]);   // {id, title, display}
  return (
    <AiTilesContext.Provider value={{ tiles, setTiles }}>
      {children}
    </AiTilesContext.Provider>
  );
}

function useAiTiles() {
  const ctx = useContext(AiTilesContext);
  if (!ctx) throw new Error('useAiTiles needs AiTilesProvider');
  return ctx;
}

function ChartPlot({ d, height = 240 }) {
  const lay = d.layout || {};
  const data = (d.traces || []).map((t, i) => ({
    name: t.name,
    x: t.x,
    y: t.y,
    type: t.type === 'area' ? 'scatter' : (t.type === 'line' ? 'scatter' : t.type),
    mode: (t.type === 'line' || t.type === 'area') ? 'lines'
      : (t.type === 'scatter' ? 'markers' : undefined),
    fill: t.type === 'area' ? 'tozeroy' : undefined,
    marker: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
  }));
  if (!data.length && d.labels?.length) {
    data.push({ type: 'bar', x: d.labels, y: d.values,
      marker: { color: '#6366f1' } });
  }
  return (
    <Plot
      data={data}
      layout={{
        title: { text: d.title || '', font: { size: 12 } },
        margin: { l: 45, r: 10, t: d.title ? 30 : 10, b: 55 },
        height, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
        barmode: lay.stacked ? 'stack' : 'group',
        showlegend: (d.traces || []).length > 1,
        legend: { font: { size: 9 }, orientation: 'h' },
        xaxis: { tickfont: { size: 9 }, automargin: true,
                 title: { text: lay.x_title || '', font: { size: 10 } } },
        yaxis: { tickfont: { size: 9 },
                 type: lay.y_log ? 'log' : 'linear',
                 title: { text: lay.y_title || '', font: { size: 10 } } },
      }}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: '100%' }}
    />
  );
}

/** AI-created tiles, rendered above the regular plot grid. Session-only. */
export function AiTilesStrip() {
  const { tiles, setTiles } = useAiTiles();
  if (!tiles.length) return null;
  return (
    <div className="ai-tiles-strip">
      {tiles.map((t, i) => (
        <div className="ai-tile" key={t.id}>
          <div className="ai-tile-head">
            <span className="ai-tile-index">#{i + 1}</span>
            <span className="ai-tile-title">{t.title || t.display.title || 'AI chart'}</span>
            <button className="ai-tile-close" title="Remove tile"
              onClick={() => setTiles((cur) => cur.filter((x) => x.id !== t.id))}>
              ✕
            </button>
          </div>
          <ChartPlot d={t.display} height={220} />
        </div>
      ))}
    </div>
  );
}

export default function AiChat() {
  const { datasetId } = useDashboard();
  const { tiles, setTiles } = useAiTiles();

  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  const convoIdRef = useRef(newId());
  const lastChartRef = useRef(null);      // most recent chart display (for add_tile)
  const abortRef = useRef(null);          // in-flight stream (Stop button)

  useEffect(() => {
    let cancelled = false;
    fetch('/backend/ai_status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => { if (!cancelled) setEnabled(!!d.enabled); })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  useEffect(() => {
    stopStream();
    setMessages([]);
    convoIdRef.current = newId();
  }, [datasetId]);

  function execUiAction(d) {
    const p = d.params || {};
    try {
      if (d.action === 'add_tile') {
        const chart = lastChartRef.current;
        if (!chart) {
          console.warn('[AiChat] add_tile without a rendered chart');
          return;
        }
        setTiles((cur) => [...cur, { id: newId(),
          title: p.title, display: chart }]);
      } else if (d.action === 'remove_tile') {
        const idx = Math.round(p.index ?? 0) - 1;   // 1-based on the tiles
        setTiles((cur) => cur.filter((_, i) => i !== idx));
      } else {
        console.warn('[AiChat/dashboard] unsupported ui_action:', d.action);
      }
    } catch (err) {
      console.error('[AiChat] ui_action failed:', err);
    }
  }

  // Stop button: tell the server to cancel (deterministic) AND abort the
  // fetch so the UI frees immediately.
  function stopStream() {
    if (!abortRef.current) return;
    fetch('/backend/ai_cancel', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: convoIdRef.current }),
    }).catch(() => {});
    abortRef.current.abort();
  }

  // The streaming answer renders into one "live" message that fills in as
  // events arrive; a `done` event (or an error) finalizes it.
  function pushLive() {
    setMessages((m) => [...m, { role: 'ai', live: true, text: '', displays: [], steps: [] }]);
  }
  function updateLive(fn) {
    setMessages((m) => {
      const last = m[m.length - 1];
      if (!last?.live) return m;
      return [...m.slice(0, -1), fn(last)];
    });
  }
  function dropLive() {
    setMessages((m) => (m[m.length - 1]?.live ? m.slice(0, -1) : m));
  }

  function execDisplay(d) {
    if (d.type === 'chart') lastChartRef.current = d;
    if (d.type === 'ui_action') execUiAction(d);
  }

  function handleStreamEvent(ev) {
    switch (ev.type) {
      case 'turn':            // new LLM turn: text so far was provisional
        updateLive((l) => ({ ...l, text: '' }));
        break;
      case 'delta':
        updateLive((l) => ({ ...l, text: l.text + (ev.text || '') }));
        break;
      case 'step':
        updateLive((l) => ({ ...l, steps: [...l.steps, { ...ev.step, pending: true }] }));
        break;
      case 'step_done':
        updateLive((l) => {
          const steps = [...l.steps];
          for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].pending) { steps[i] = ev.step; break; }
          }
          return { ...l, steps };
        });
        break;
      case 'display': {
        const d = ev.display;
        if (!d || d.type === 'locate_failed') break;
        execDisplay(d);
        updateLive((l) => ({ ...l, displays: [...l.displays, d] }));
        break;
      }
      case 'done':
        updateLive((l) => ({
          ...l,
          live: false,
          text: ev.reply || l.text || 'An error occurred.',
          steps: Array.isArray(ev.steps) && ev.steps.length ? ev.steps : l.steps,
          isError: !!ev.error,
        }));
        break;
      default:
        break;
    }
  }

  // Non-streaming responses (older backend, error JSON) in one shot.
  function finalizeFromJson(data, ok) {
    let displays = Array.isArray(data.displays) && data.displays.length
      ? data.displays
      : (data.display && data.display.type !== 'chat' ? [data.display] : []);
    displays = displays.filter((d) => d.type !== 'locate_failed');
    for (const d of displays) execDisplay(d);
    updateLive((l) => ({
      ...l, live: false,
      text: data.reply || data.error || 'An error occurred.',
      displays,
      steps: Array.isArray(data.steps) ? data.steps : l.steps,
      isError: !ok || !!data.error,
    }));
  }

  async function send() {
    const question = input.trim();
    if (!question || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: question }]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    pushLive();
    try {
      const history = messages.slice(-6).map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        text: m.text,
      }));
      const url = `/backend/data/${datasetId}/ai_query`;
      const opts = {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ question, history,
          conversation_id: convoIdRef.current,
          stream: true,
          ui_state: { surface: 'dashboard', tiles: tiles.length } }),
      };
      let res = await fetch(url, opts);
      if (res.status === 401) {
        const ok = await handle401();
        if (!ok) { dropLive(); return; }
        res = await fetch(url, opts);
      }
      const ctype = res.headers.get('content-type') || '';
      if (!res.ok || !res.body || !ctype.includes('ndjson')) {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) console.error('[AiChat] query error:', res.status, data);
        finalizeFromJson(data, res.ok);
      } else {
        // NDJSON event stream: steps, text deltas and charts arrive live.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { handleStreamEvent(JSON.parse(line)); }
            catch (err) { console.warn('[AiChat] bad stream line:', err); }
          }
        }
        // Stream ended without a done event -> connection was lost.
        updateLive((l) => (l.live
          ? { ...l, live: false, text: l.text || 'Connection lost - please try again.', isError: !l.text }
          : l));
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        updateLive((l) => ({ ...l, live: false, stopped: true,
          text: l.text || 'Stopped.' }));
      } else {
        console.error('[AiChat] request failed:', err);
        updateLive((l) => ({ ...l, live: false,
          text: 'An error occurred - please try again.', isError: true }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  function renderDisplay(d, key) {
    if (!d) return null;
    if (d.type === 'chart' && (d.traces?.length || d.labels?.length)) {
      return (
        <div className="ai-chart" key={key}>
          {d.result_id && <div className="ai-chart-id">{d.result_id}</div>}
          <ChartPlot d={d} />
        </div>
      );
    }
    if (d.type === 'table' && d.rows?.length) {
      return (
        <div className="ai-table-wrap" key={key}>
          <table className="ai-table">
            <thead><tr>{d.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>
              {d.rows.slice(0, 50).map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j}>{String(v ?? '-')}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {d.rows.length > 50 && <div className="ai-table-more">… {d.rows.length - 50} more rows</div>}
        </div>
      );
    }
    if (d.type === 'ui_action') {
      return (
        <div className="ai-map-note" key={key}>
          🎛️ {String(d.action).replace(/_/g, ' ')}
          {d.params?.title ? `: ${d.params.title}` : ''}
        </div>
      );
    }
    if (d.type === 'map' || d.type === 'map_layers' || d.type === 'locate') {
      return (
        <div className="ai-map-note" key={key}>
          🗺️ Map output — open the webmap to see it drawn.
        </div>
      );
    }
    return null;
  }

  function renderSteps(steps) {
    if (!steps?.length) return null;
    return (
      <div className="ai-chips">
        {steps.map((s, i) => (
          <span key={i}
                className={`ai-chip ${s.pending ? 'pending' : s.ok ? '' : 'fail'}`}
                title={s.pending ? 'Running…'
                  : s.ok ? (s.detail || '')
                    : `Failed attempt (auto-retried): ${s.error || s.detail || ''}`}>
            {s.pending ? <span className="ai-chip-spin" /> : (s.ok ? '🔧' : '⚠️')}
            {' '}{s.tool}{s.detail ? ` · ${s.detail.slice(0, 40)}` : ''}
          </span>
        ))}
      </div>
    );
  }

  if (!enabled) return null;

  return (
    <>
      {!open && (
        <div className="ai-fab-stack">
          <button className="ai-fab" onClick={() => setOpen(true)} title="Ask AI">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 3l1.8 4.9L19 9.7l-4.4 3.3 1.5 5.3L12 15.4l-4.1 2.9 1.5-5.3L5 9.7l5.2-1.8L12 3z"
                    fill="currentColor"/>
            </svg>
          </button>
        </div>
      )}

      {open && (
        <div className="ai-panel">
          <div className="ai-header">
            <div className="ai-header-title">
              <span className="ai-header-icon">✦</span>
              <div>
                <strong>Ask AI</strong>
                <div className="ai-header-sub">Dashboard assistant</div>
              </div>
            </div>
            <div className="ai-header-actions">
              <button className="ai-close" onClick={() => setOpen(false)}>✕</button>
            </div>
          </div>

          <div className="ai-body" ref={bodyRef}>
            {messages.length === 0 && (
              <div className="ai-hello">
                <p>Ask about the data or manage dashboard tiles, e.g.:</p>
                <button onClick={() => setInput('Add a tile showing mode share by income class')}>
                  &quot;Add a tile showing mode share by income class&quot;
                </button>
                <button onClick={() => setInput('Compare car and PT trips by hour in one chart')}>
                  &quot;Compare car and PT trips by hour in one chart&quot;
                </button>
                <button onClick={() => setInput('How well does the simulation match the microcensus?')}>
                  &quot;How well does the simulation match the microcensus?&quot;
                </button>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`ai-msg ${m.role} ${m.isError ? 'error' : ''}`}>
                {m.role === 'ai' && renderSteps(m.steps)}
                {m.live && !m.text && !m.steps?.length
                  ? <div className="ai-typing"><span></span><span></span><span></span></div>
                  : <div className="ai-msg-text">{m.text}</div>}
                {m.role === 'ai' && (m.displays || []).map((d, j) => renderDisplay(d, j))}
                {m.stopped && <div className="ai-stopped-note">⏹ stopped</div>}
              </div>
            ))}
          </div>

          <div className="ai-input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder="Type a question…"
              rows={1}
              disabled={busy}
            />
            {busy ? (
              <button className="ai-send ai-stop" title="Stop"
                onClick={stopStream}>
                ◼
              </button>
            ) : (
              <button className="ai-send" onClick={send} disabled={!input.trim()}>
                ➤
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
