import { layout, escapeHtml } from './layout.js';

export function renderEntity({ id, entity, error }) {
  if (error || !entity) {
    return layout({
      title: `Entity ${id}`,
      main: `<h2>Entity ${escapeHtml(String(id))}</h2><p class="error">${escapeHtml(error || 'not found')}</p>`,
    });
  }
  const props = entity.properties && typeof entity.properties === 'object'
    ? Object.entries(entity.properties).map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(JSON.stringify(v))}</li>`).join('')
    : '';
  const outgoing = entity.relations && Array.isArray(entity.relations.outgoing) ? entity.relations.outgoing : [];
  const incoming = entity.relations && Array.isArray(entity.relations.incoming) ? entity.relations.incoming : [];

  const relList = (arr) => arr.length === 0 ? '<p class="muted">none</p>' : `<ul>${arr.map((r) => {
    const target = r.target_id ?? r.source_id ?? r.id ?? '?';
    const rel = r.relation_type || r.type || '';
    return `<li><span class="muted">${escapeHtml(rel)}</span> → <a href="/entity/${target}">entity ${target}</a></li>`;
  }).join('')}</ul>`;

  const main = `
    <h2>${escapeHtml(entity.name || `entity ${id}`)}</h2>
    <p class="muted">type: ${escapeHtml(entity.type || '')} · id: ${escapeHtml(String(entity.id ?? id))}</p>
    <section><h3>Properties</h3><ul>${props || '<li class="muted">none</li>'}</ul></section>
    <section><h3>Outgoing relations</h3>${relList(outgoing)}</section>
    <section><h3>Incoming relations</h3>${relList(incoming)}</section>
  `;
  return layout({ title: entity.name || `entity ${id}`, main });
}
