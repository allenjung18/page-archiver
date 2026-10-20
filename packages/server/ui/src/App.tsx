// The reader UI: search and filter the library on the left, the chosen page on the right.
// An archive is shown only in an iframe sandboxed without allow-scripts, from the server's
// archive route (which adds ARCHIVE_CSP); its HTML never enters this page's own document.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "./api.ts";
import type { Facets, Hit, PageRecord, Query, VersionRef } from "./api.ts";

type View = "original" | "reader";

const EMPTY: Query = { q: "", site: "", tag: "", since: "", until: "", all: false };

function day(iso: string): string {
  return iso.slice(0, 10);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Snippet({ hit }: { hit: Hit }) {
  return (
    <p className="snippet" data-testid="snippet">
      {hit.snippet.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </p>
  );
}

function Filters({ query, facets, onChange }: { query: Query; facets: Facets; onChange: (q: Query) => void }) {
  const set = <K extends keyof Query>(k: K, v: Query[K]) => onChange({ ...query, [k]: v });
  return (
    <div className="filters">
      <label>
        Site
        <select aria-label="Site" value={query.site} onChange={(e) => set("site", e.target.value)}>
          <option value="">All sites</option>
          {facets.sites.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.count})
            </option>
          ))}
        </select>
      </label>
      <label>
        Tag
        <select aria-label="Tag" value={query.tag} onChange={(e) => set("tag", e.target.value)}>
          <option value="">All tags</option>
          {facets.tags.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.count})
            </option>
          ))}
        </select>
      </label>
      <label>
        From
        <input type="date" aria-label="From" value={query.since} onChange={(e) => set("since", e.target.value)} />
      </label>
      <label>
        To
        <input type="date" aria-label="To" value={query.until} onChange={(e) => set("until", e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={query.all} onChange={(e) => set("all", e.target.checked)} />
        Every version
      </label>
    </div>
  );
}

function ResultItem({ page, selected, onOpen }: { page: PageRecord | Hit; selected: boolean; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className={selected ? "result selected" : "result"} aria-current={selected ? "true" : undefined} data-testid="result" data-id={page.id} onClick={onOpen}>
        <span className="title">{page.title || page.url}</span>
        <span className="meta">
          {page.site ?? hostOf(page.url)} · {day(page.capturedAt)}
          {page.versions > 1 ? ` · v${page.version}/${page.versions}` : ""}
        </span>
        {page.tags.length > 0 && (
          <span className="tags">
            {page.tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </span>
        )}
        {api.isHit(page) && <Snippet hit={page} />}
      </button>
    </li>
  );
}

interface ViewerProps {
  id: string;
  onDeleted: () => void;
  onChanged: (id: string) => void;
  onError: (message: string) => void;
}

function Viewer({ id, onDeleted, onChanged, onError }: ViewerProps) {
  const [data, setData] = useState<{ page: PageRecord; versions: VersionRef[] } | null>(null);
  const [view, setView] = useState<View>("original");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [newTag, setNewTag] = useState("");

  useEffect(() => {
    let live = true;
    setConfirming(false);
    api
      .page(id)
      .then((d) => {
        if (!live) return;
        setData(d);
        if (!d.page.hasReader) setView("original");
      })
      .catch((e: Error) => live && onError(e.message));
    return () => {
      live = false;
    };
  }, [id, onError]);

  if (!data || data.page.id !== id) return <section className="viewer empty">Loading…</section>;
  const { page, versions } = data;

  const run = async (label: string, job: () => Promise<void>) => {
    setBusy(label);
    try {
      await job();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const addTag = (e: FormEvent) => {
    e.preventDefault();
    const t = newTag.trim();
    if (!t) return;
    void run("Tagging…", async () => {
      const p = await api.tag(page.id, [t]);
      setData({ page: p, versions });
      setNewTag("");
      onChanged(p.id);
    });
  };

  const removeTag = (t: string) =>
    run("Tagging…", async () => {
      const p = await api.tag(page.id, [], [t]);
      setData({ page: p, versions });
      onChanged(p.id);
    });

  return (
    <section className="viewer" aria-label="Page">
      <header className="viewer-head">
        <div className="viewer-title">
          <h2>{page.title || page.url}</h2>
          <p className="meta">
            <a href={page.url} target="_blank" rel="noreferrer noopener">
              {page.url}
            </a>{" "}
            · captured {new Date(page.capturedAt).toLocaleString()}
            {page.versions > 1 && ` · version ${page.version} of ${page.versions}`}
          </p>
          {versions.length > 1 && (
            <p className="versions">
              Versions:{" "}
              {versions.map((v) => (
                <button key={v.id} type="button" className="link" disabled={v.id === page.id} onClick={() => onChanged(v.id)}>
                  v{v.version} ({day(v.capturedAt)})
                </button>
              ))}
            </p>
          )}
        </div>
        <div className="toolbar">
          <div className="toggle" role="group" aria-label="Copy to show">
            <button type="button" aria-pressed={view === "original"} onClick={() => setView("original")}>
              Original
            </button>
            <button type="button" aria-pressed={view === "reader"} disabled={!page.hasReader} title={page.hasReader ? undefined : "This capture has no reader copy"} onClick={() => setView("reader")}>
              Reader
            </button>
          </div>
          <button type="button" disabled={busy !== null} onClick={() => run("Capturing…", async () => onChanged((await api.recapture(page.id)).page.id))}>
            Re-capture
          </button>
          {confirming ? (
            <span className="confirm">
              Delete this capture?{" "}
              <button
                type="button"
                className="danger"
                disabled={busy !== null}
                onClick={() =>
                  run("Deleting…", async () => {
                    await api.remove(page.id);
                    onDeleted();
                  })
                }
              >
                Yes, delete
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirming(true)}>
              Delete
            </button>
          )}
          {busy && (
            <span className="busy" role="status">
              {busy}
            </span>
          )}
        </div>
        <div className="tag-editor">
          {page.tags.map((t) => (
            <span key={t} className="tag">
              {t}
              <button type="button" aria-label={`Remove tag ${t}`} onClick={() => void removeTag(t)}>
                ×
              </button>
            </span>
          ))}
          <form onSubmit={addTag}>
            <input aria-label="New tag" placeholder="add a tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
            <button type="submit">Add</button>
          </form>
        </div>
      </header>
      {/* sandbox="" grants nothing: no scripts, no same origin, no forms, no popups, no top navigation */}
      <iframe key={`${page.id}/${view}`} title={`${view === "reader" ? "Reader copy" : "Archived page"}: ${page.title}`} src={`/archive/${page.id}/${view}`} sandbox="" referrerPolicy="no-referrer" />
    </section>
  );
}

export function App() {
  const [query, setQuery] = useState<Query>(EMPTY);
  const [results, setResults] = useState<Array<PageRecord | Hit> | null>(null);
  const [facets, setFacets] = useState<Facets>({ sites: [], tags: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  const onError = useCallback((m: string) => setError(m), []);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api
        .find(query)
        .then((r) => {
          if (!live) return;
          setResults(r);
          setError(null);
        })
        .catch((e: Error) => live && setError(e.message));
    }, query.q ? 150 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, generation]);

  useEffect(() => {
    api.facets().then(setFacets, (e: Error) => setError(e.message));
  }, [generation]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Page archive</h1>
        <form role="search" onSubmit={(e) => e.preventDefault()}>
          <input type="search" aria-label="Search" placeholder="Search titles and text" value={query.q} onChange={(e) => setQuery({ ...query, q: e.target.value })} />
        </form>
        <Filters query={query} facets={facets} onChange={setQuery} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {results === null ? (
          <p className="hint">Loading…</p>
        ) : results.length === 0 ? (
          <p className="hint" data-testid="no-results">
            {query.q || query.site || query.tag || query.since || query.until ? "Nothing matches." : "No pages yet. Save one with pa save <url>."}
          </p>
        ) : (
          <>
            <p className="count" data-testid="count">
              {results.length} {results.length === 1 ? "page" : "pages"}
            </p>
            <ul className="results" aria-label="Pages">
              {results.map((p) => (
                <ResultItem key={p.id} page={p} selected={p.id === selected} onOpen={() => setSelected(p.id)} />
              ))}
            </ul>
          </>
        )}
      </aside>
      <main>
        {selected ? (
          <Viewer
            id={selected}
            onError={onError}
            onDeleted={() => {
              setSelected(null);
              refresh();
            }}
            onChanged={(id) => {
              setSelected(id);
              refresh();
            }}
          />
        ) : (
          <section className="viewer empty">Choose a page to read it.</section>
        )}
      </main>
    </div>
  );
}
