import { layout, escapeHtml } from './layout.js';

export function renderFrame({ id, frame, error }) {
  if (error || !frame) {
    return layout({
      title: `Frame ${id}`,
      main: `<h2>Frame ${escapeHtml(String(id))}</h2><p class="error">${escapeHtml(error || 'not found')}</p>`,
    });
  }
  const main = `
    <h2>Frame ${escapeHtml(String(frame.id ?? id))}</h2>
    <p class="muted">${escapeHtml(frame.created_at || '')} · ${escapeHtml(frame.importance || 'normal')} · ${escapeHtml(frame.source || '')}</p>
    <pre class="content-block">${escapeHtml(frame.content || '')}</pre>
  `;
  return layout({ title: `frame ${id}`, main });
}
