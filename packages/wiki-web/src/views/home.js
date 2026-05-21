import { layout, escapeHtml } from './layout.js';

export function renderHome({ health, wikiHits }) {
  let healthHtml = '<p class="muted">No health data yet — run cognify + compile_wiki.</p>';
  if (health) {
    const items = Array.isArray(health) ? health : Object.entries(health).map(([k, v]) => `${k}: ${v}`);
    healthHtml = `<ul>${items.slice(0, 12).map((i) => `<li>${escapeHtml(typeof i === 'string' ? i : JSON.stringify(i))}</li>`).join('')}</ul>`;
  }

  let pagesHtml = '<p class="muted">No wiki pages compiled yet.</p>';
  if (Array.isArray(wikiHits) && wikiHits.length > 0) {
    pagesHtml = `<ul>${wikiHits.map((p) => `
      <li><a href="/wiki/${encodeURIComponent(p.slug || p.id || p.title)}">${escapeHtml(p.title || p.slug || 'page')}</a> <span class="muted">${escapeHtml(p.summary || '')}</span></li>`).join('')}</ul>`;
  }

  const main = `
    <h2>Welcome</h2>
    <p>Local read-only wiki UI for your hive-mind. Reads via the CLI bridge — never touches the SQLite directly.</p>
    <section>
      <h3>Health</h3>
      ${healthHtml}
    </section>
    <section>
      <h3>Wiki pages</h3>
      ${pagesHtml}
    </section>
    <section>
      <h3>Quick links</h3>
      <ul>
        <li><a href="/search?q=">Search frames + entities + wiki</a></li>
        <li><a href="/graph">Knowledge graph</a></li>
      </ul>
    </section>
  `;
  return layout({ title: 'hive-mind', main, activeNav: 'Home' });
}
