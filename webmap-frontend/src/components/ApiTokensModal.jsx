import React, { useEffect, useState } from 'react';
import { handle401 } from '../utils/auth';
import './ApiTokensModal.css';

const AUTH = '/authentification/backend';

/**
 * Personal API tokens: create / list / revoke. Tokens authenticate MCP
 * clients (Claude Code, Claude Desktop, ...) against <origin>/mcp — the
 * plaintext token is shown exactly once after creation.
 */
export default function ApiTokensModal({ onClose }) {
  const [tokens, setTokens] = useState(null);       // null = loading
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState(null);         // {token, name} shown once
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  const mcpUrl = `${window.location.origin}/mcp`;

  async function authedFetch(url, opts = {}) {
    const merged = { credentials: 'include', ...opts };
    let res = await fetch(url, merged);
    if (res.status === 401) {
      const ok = await handle401();
      if (ok) res = await fetch(url, merged);
    }
    return res;
  }

  async function load() {
    try {
      const res = await authedFetch(`${AUTH}/api-tokens`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTokens((await res.json()).tokens || []);
    } catch (err) {
      console.error('[ApiTokens] load failed:', err);
      setError('Could not load tokens.');
      setTokens([]);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await authedFetch(`${AUTH}/api-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || 'API token', days: Number(days) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFresh(data);
      setCopied(false);
      setName('');
      await load();
    } catch (err) {
      console.error('[ApiTokens] create failed:', err);
      setError('Could not create the token.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id) {
    try {
      const res = await authedFetch(`${AUTH}/api-tokens/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (fresh && fresh.id === id) setFresh(null);
      await load();
    } catch (err) {
      console.error('[ApiTokens] revoke failed:', err);
      setError('Could not revoke the token.');
    }
  }

  function copy(text) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString() : '-');

  return (
    <div className="apitok-backdrop" onClick={onClose}>
      <div className="apitok-modal" onClick={(e) => e.stopPropagation()}>
        <div className="apitok-header">
          <strong>API tokens</strong>
          <button className="apitok-close" onClick={onClose}>✕</button>
        </div>

        <div className="apitok-body">
          <p className="apitok-intro">
            Connect an AI assistant (Claude Code, Claude Desktop, any MCP
            client) to your datasets. The token grants read-only access to
            exactly the datasets your account can see.
          </p>

          {/* Create */}
          <div className="apitok-create">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name (e.g. my laptop)"
              maxLength={100}
            />
            <select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
            <button onClick={create} disabled={creating}>Create</button>
          </div>

          {error && <div className="apitok-error">{error}</div>}

          {/* Fresh token — shown exactly once */}
          {fresh && (
            <div className="apitok-fresh">
              <div className="apitok-fresh-title">
                Token created - copy it now, it will not be shown again:
              </div>
              <div className="apitok-fresh-row">
                <code>{fresh.token}</code>
                <button onClick={() => copy(fresh.token)}>
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
              <details className="apitok-connect">
                <summary>How to connect</summary>
                <div className="apitok-connect-body">
                  <div className="apitok-connect-label">Claude Code:</div>
                  <code className="apitok-cmd">
                    claude mcp add webmap --transport http {mcpUrl} --header
                    "Authorization: Bearer {fresh.token}"
                  </code>
                  <div className="apitok-connect-label">
                    Claude Desktop (Settings → Developer → Edit Config):
                  </div>
                  <code className="apitok-cmd">
{`{"mcpServers": {"webmap": {"command": "npx", "args":
["mcp-remote", "${mcpUrl}", "--header",
"Authorization: Bearer ${fresh.token}"]}}}`}
                  </code>
                  <div className="apitok-connect-label">
                    Then ask e.g. &quot;List my webmap datasets&quot; or
                    &quot;How many bike trips are in dataset 1?&quot;
                  </div>
                </div>
              </details>
            </div>
          )}

          {/* Existing tokens */}
          <div className="apitok-list">
            {tokens === null && <div className="apitok-empty">Loading…</div>}
            {tokens && tokens.length === 0 && (
              <div className="apitok-empty">No tokens yet.</div>
            )}
            {tokens && tokens.length > 0 && (
              <table>
                <thead>
                  <tr><th>Name</th><th>Created</th><th>Expires</th><th>Last used</th><th /></tr>
                </thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td>{fmt(t.created_at)}</td>
                      <td>{fmt(t.expires_at)}</td>
                      <td>{fmt(t.last_used_at)}</td>
                      <td>
                        <button className="apitok-revoke" onClick={() => revoke(t.id)}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
