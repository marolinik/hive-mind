import { layout, escapeHtml } from './layout.js';

export function renderSearch({ q, frames, entities, wiki }) {
  const sec = (title, items, render) => `
    <section>
      <h3>${escapeHtml(title)} <span class="muted">(${Array.isArray(items) ? items.length : 0})</span></h3>
      ${(Array.isArray(items) && items.length > 0) ? `<ul class="results">${items.map(render).join('')}</ul>` : '<p class="muted">No matches.</p>'}
    </section>
  `;

  const renderFrame = (f) => {
    const id = f.id ?? '';
    const ts = f.created_at || f.createdAt || '';
    const importance = f.importance || 'normal';
    const content = String(f.content || '').slice(0, 280);
    return `<li><a href="/frame/${id}">frame ${id}</a> <span class="muted">${escapeHtml(ts)} · ${escapeHtml(importance)}</span><div>${escapeHtml(content)}</div></li>`;
  };
  const renderEntity = (e) => {
    const id = e.id ?? '';
    const name = e.name || `entity ${id}`;
    const type = e.type || 'concept';
    return `<li><a href="/entity/${id}">${escapeHtml(name)}</a> <span class="muted">${escapeHtml(type)}</span></li>`;
  };
  const renderWiki = (p) => {
    const slug = p.slug || p.id || '';
    const title = p.title || slug;
    return `<li><a href="/wiki/${encodeURIComponent(slug)}">${escapeHtml(title)}</a> <span class="muted">${escapeHtml(p.summary || '')}</span></li>`;
  };

  const main = `
    <h2>Search</h2>
    <form action="/search" method="get" class="search-form">
      <input type="search" name="q" value="${escapeHtml(q || '')}" autofocus>
      <button type="submit">Search</button>
    </form>
    ${sec('Frames', frames, renderFrame)}
    ${sec('Entities', entities, renderEntity)}
    ${sec('Wiki pages', wiki, renderWiki)}
  `;
  return layout({ title: `Search: ${q || ''}`, main, activeNav: 'Search' });
}
