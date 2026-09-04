import React, { useEffect, useRef, useState } from 'react';
import { useData } from '../context/DataContext';
import { handle401 } from '../utils/auth';
import './SimJobsModal.css';

const SIM = '/backend/sim';
export const ACTIVE = new Set(['proposed', 'queued', 'running', 'uploading']);

/**
 * Persistent view of the user's custom simulation runs — independent of
 * the chat conversation: log out, come back in the evening, open this and
 * see exactly where each run stands (status, phase, iteration progress).
 * Polls every 5 s while open; the sidebar + dataset selector poll slowly in
 * the background via useSimJobs().
 */

export async function fetchJobs() {
  let res = await fetch(`${SIM}/jobs`, { credentials: 'include' });
  if (res.status === 401) {
    const ok = await handle401();
    if (!ok) throw new Error('unauthenticated');
    res = await fetch(`${SIM}/jobs`, { credentials: 'include' });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).jobs || [];
}

async function post(path) {
  const res = await fetch(`${SIM}${path}`, { method: 'POST', credentials: 'include' });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch { /* keep */ }
    throw new Error(detail);
  }
  return res.json();
}

/** Slow background poll: {available, jobs}. available=false hides every
 *  simulation UI when the sim service isn't deployed/reachable. */
export function useSimJobs(intervalMs = 45000) {
  const [state, setState] = useState({ available: false, jobs: [] });
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const jobs = await fetchJobs();
        if (!stop) setState({ available: true, jobs });
      } catch {
        if (!stop) setState({ available: false, jobs: [] });
      }
    }
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { stop = true; clearInterval(t); };
  }, [intervalMs]);
  return state;
}

/** Sidebar badge: {available, activeCount}. */
export function useSimJobsBadge(intervalMs = 45000) {
  const { available, jobs } = useSimJobs(intervalMs);
  return { available, activeCount: jobs.filter((j) => ACTIVE.has(j.status)).length };
}

export const STATUS_LABEL = {
  proposed: 'awaiting confirmation',
  queued: 'queued',
  running: 'running',
  uploading: 'publishing',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const PHASE_LABEL = {
  claimed: 'claimed by worker',
  preparing: 'preparing inputs',
  simulating: 'simulating',
  analysing: 'analysing results',
  uploading: 'uploading results',
  ingesting: 'building dataset',
  done: 'done',
};

/** One-line "where is it" text for a job (shared by every job UI). */
export function jobStage(j) {
  const pct = Math.round((j.progress || 0) * 100);
  if (j.status === 'running' || j.status === 'uploading') {
    const phase = PHASE_LABEL[j.phase] || j.phase || '…';
    return `${phase} · ${pct}%${j.message ? ` · ${j.message}` : ''}`;
  }
  if (j.status === 'queued') return `waiting for a worker · ${j.estimate || ''}`.trim();
  if (j.status === 'proposed') return 'not started — confirm it in the AI chat';
  if (j.status === 'done') return `finished · dataset #${j.result_dataset_id}`;
  return j.error ? `${STATUS_LABEL[j.status]} · ${j.error}` : STATUS_LABEL[j.status];
}

export default function SimJobsModal({ onClose }) {
  const { setDatasetId } = useData();
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
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

  async function act(id, action) {
    setBusyId(id);
    try {
      await post(`/jobs/${id}/${action}`);
      setError(null);
      await load();
    } catch (err) {
      console.error(`[SimJobs] ${action} failed:`, err);
      setError(`${action} failed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  function openResult(dsId) {
    setDatasetId(dsId);
    onClose();
  }

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  // Only the newest attempt of a run offers Resume — older ones already have one.
  const resumedIds = new Set((jobs || []).map((j) => j.resume_of).filter(Boolean));

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
              No simulation runs yet. Ask the AI with a message starting with
              <code> /sim</code>, e.g.&nbsp;
              <em>&quot;/sim close link X and rerun the simulation&quot;</em>.
            </div>
          )}

          {(jobs || []).map((j) => {
            const pct = Math.round((j.progress || 0) * 100);
            const active = ACTIVE.has(j.status);
            const canResume = (j.status === 'failed' || j.status === 'cancelled')
              && j.started_at && !resumedIds.has(j.job_id);
            return (
              <div className={`simjobs-card ${j.status}`} key={j.job_id}>
                <div className="simjobs-card-head">
                  <span className="simjobs-title">#{j.job_id} · {j.title}</span>
                  <span className={`simjobs-badge ${j.status}`}>
                    {STATUS_LABEL[j.status] || j.status}
                  </span>
                </div>

                {j.description && <div className="simjobs-desc">{j.description}</div>}

                <ul className="simjobs-ops">
                  {(j.summary || []).slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}
                </ul>

                {(j.status === 'running' || j.status === 'uploading') && (
                  <div className="simjobs-bar"><div style={{ width: `${pct}%` }} /></div>
                )}
                <div className="simjobs-meta">
                  {j.status === 'done' ? '✅ ' : ''}
                  {(j.status === 'failed' || j.status === 'cancelled') ? '⚠️ ' : ''}
                  {jobStage(j)}
                  {j.resume_of ? ` · resumed from #${j.resume_of}` : ''}
                  {j.status === 'done' && j.finished_at ? ` · ${fmt(j.finished_at)}` : ''}
                </div>

                <div className="simjobs-actions">
                  {j.status === 'done' && j.result_dataset_id && (
                    <button className="simjobs-open"
                            onClick={() => openResult(j.result_dataset_id)}>
                      Open result
                    </button>
                  )}
                  {canResume && (
                    <button className="simjobs-open" disabled={busyId === j.job_id}
                            title="Re-queue this run; it continues from its last checkpoint when possible"
                            onClick={() => act(j.job_id, 'resume')}>
                      ↻ Resume
                    </button>
                  )}
                  {active && (
                    <button className="simjobs-cancel" disabled={busyId === j.job_id}
                            onClick={() => act(j.job_id, 'cancel')}>
                      {j.status === 'proposed' ? 'Discard' : 'Stop'}
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
