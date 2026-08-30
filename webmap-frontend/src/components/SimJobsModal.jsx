import React, { useEffect, useRef, useState } from 'react';
import { useData } from '../context/DataContext';
import { handle401 } from '../utils/auth';
import './SimJobsModal.css';

const SIM = '/backend/sim';
const ACTIVE = new Set(['proposed', 'queued', 'running', 'uploading']);

/**
 * Persistent view of the user's custom simulation runs — independent of
 * the chat conversation: log out, come back in the evening, open this and
 * see exactly where each run stands (status, phase, iteration progress).
 * Polls every 5 s while open; the sidebar badge polls slowly in the
 * background via useSimJobsBadge().
 */

async function fetchJobs() {
  let res = await fetch(`${SIM}/jobs`, { credentials: 'include' });
  if (res.status === 401) {
    const ok = await handle401();
    if (!ok) throw new Error('unauthenticated');
    res = await fetch(`${SIM}/jobs`, { credentials: 'include' });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).jobs || [];
}

/** Slow background poll for the sidebar: {available, activeCount}. */
export function useSimJobsBadge(intervalMs = 45000) {
  const [state, setState] = useState({ available: false, activeCount: 0 });
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const jobs = await fetchJobs();
        if (!stop) {
          setState({
            available: true,
            activeCount: jobs.filter((j) => ACTIVE.has(j.status)).length,
          });
        }
      } catch {
        // sim service not deployed/reachable → hide the entry entirely
        if (!stop) setState({ available: false, activeCount: 0 });
      }
    }
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { stop = true; clearInterval(t); };
  }, [intervalMs]);
  return state;
}

const STATUS_LABEL = {
  proposed: 'awaiting confirmation',
  queued: 'queued',
  running: 'running',
  uploading: 'uploading result',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export default function SimJobsModal({ onClose }) {
  const { setDatasetId } = useData();
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  async function load() {
    try {
      setJobs(await fetchJobs());
      setError(null);
    } catch (err) {
      console.error('[SimJobs] load failed:', err);
      setError('Could not load simulation jobs.');
      if (jobs === null) setJobs([]);
    }
  }

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 5000);   // live while open
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cancel(id) {
    try {
      await fetch(`${SIM}/jobs/${id}/cancel`, {
        method: 'POST', credentials: 'include' });
      load();
    } catch (err) {
      console.error('[SimJobs] cancel failed:', err);
    }
  }

  function openResult(dsId) {
    setDatasetId(dsId);
    onClose();
  }

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '');

  return (
    <div className="simjobs-backdrop" onClick={onClose}>
      <div className="simjobs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="simjobs-header">
          <strong>🧪 Simulations</strong>
          <button className="simjobs-close" onClick={onClose}>✕</button>
        </div>

        <div className="simjobs-body">
          {error && <div className="simjobs-error">{error}</div>}
          {jobs === null && <div className="simjobs-empty">Loading…</div>}
          {jobs && jobs.length === 0 && !error && (
            <div className="simjobs-empty">
              No simulation runs yet. Ask the AI, e.g.&nbsp;
              <em>&quot;Close link X and run the simulation&quot;</em>.
            </div>
          )}

          {(jobs || []).map((j) => {
            const pct = Math.round((j.progress || 0) * 100);
            const active = ACTIVE.has(j.status);
            return (
              <div className={`simjobs-card ${j.status}`} key={j.job_id}>
                <div className="simjobs-card-head">
                  <span className="simjobs-title">#{j.job_id} · {j.title}</span>
                  <span className={`simjobs-badge ${j.status}`}>
                    {STATUS_LABEL[j.status] || j.status}
                  </span>
                </div>

                <ul className="simjobs-ops">
                  {(j.summary || []).slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}
                </ul>

                {(j.status === 'running' || j.status === 'uploading') && (
                  <>
                    <div className="simjobs-bar"><div style={{ width: `${pct}%` }} /></div>
                    <div className="simjobs-meta">
                      {j.phase || '…'} · {pct}%
                      {j.message ? ` · ${j.message}` : ''}
                    </div>
                  </>
                )}
                {j.status === 'queued' && (
                  <div className="simjobs-meta">
                    Waiting for a worker · {j.estimate}
                  </div>
                )}
                {j.status === 'proposed' && (
                  <div className="simjobs-meta">
                    Not started — confirm it in the AI chat ({j.estimate})
                  </div>
                )}
                {j.status === 'done' && (
                  <div className="simjobs-meta">
                    ✅ Finished {fmt(j.finished_at)} — result is your dataset
                    #{j.result_dataset_id}
                  </div>
                )}
                {(j.status === 'failed' || j.status === 'cancelled') && j.error && (
                  <div className="simjobs-meta">⚠️ {j.error}</div>
                )}

                <div className="simjobs-actions">
                  {j.status === 'done' && j.result_dataset_id && (
                    <button className="simjobs-open"
                            onClick={() => openResult(j.result_dataset_id)}>
                      Open result
                    </button>
                  )}
                  {active && (
                    <button className="simjobs-cancel"
                            onClick={() => cancel(j.job_id)}>
                      Cancel
                    </button>
                  )}
                  <span className="simjobs-when">{fmt(j.created_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
