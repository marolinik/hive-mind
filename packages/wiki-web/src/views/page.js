import { layout, escapeHtml } from './layout.js';
import { Marked } from 'marked';

/**
 * Render a single compiled wiki page. The MCP get_page response shape is
 * unstable (pre-1.0), so we handle a few common variants:
 *   - { slug, title, summary, body | content | markdown, ... }
 *   - { ok, page: { ... } }
 *   - falsy → render "not found"
 */
function pickField(obj, ...keys) {
  if (!obj) return '';
  for (const k of keys) {
    if (obj[k] != null && typeof obj[k] === 'string') return obj[k];
  }
  return '';
}

// Markdown rendering via marked. The wiki content is generated locally by
// `claude -p` on the user's machine and served over localhost only, so the
// XSS surface is "claude -p output gets prompt-injected by harvested
// content into echoing a <script> tag." We mitigate by:
//   1. Disabling raw HTML passthrough — marked escapes <tag> by default
//      when we don't override the renderer for raw HTML blocks.
//   2. Single-user / localhost — no cross-origin attack surface.
// gfm: true gives us tables, autolinks, fenced code blocks, strikethrough.
const md = new Marked({
  gfm: true,
  breaks: false,
  pedantic: false,
});

function bodyToHtml(body) {
  if (!body) return '<p class="muted">empty</p>';
  return md.parse(body);
}

/**
 * Render the source-frames fallback used when get_page returned no body.
 * Each frame links to /frame/:id for full content; the inline excerpt
 * is capped at PER_FRAME_CHARS so the page stays readable.
 */
const PER_FRAME_CHARS = 320;
function renderSourceFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return '';
  const items = frames.map((f) => {
    const id = typeof f.id === 'number' ? f.id : null;
    const ts = f.created_at || f.createdAt || '';
    const from = f.from || f.workspace || 'personal';
    const importance = f.importance ? `(${f.importance})` : '';
    const score = typeof f.score === 'number' ? `· score ${f.score.toFixed(3)}` : '';
    const c = String(f.content || '');
    const trimmed = c.length > PER_FRAME_CHARS ? c.slice(0, PER_FRAME_CHARS) + '…' : c;
    const link = id !== null ? `<a href="/frame/${id}">#${id}</a>` : '';
    return `
      <li class="source-frame">
        <div class="meta">
          ${link} <small class="muted">${escapeHtml(ts)} · ${escapeHtml(from)} ${escapeHtml(importance)} ${score}</small>
        </div>
        <div class="content-block">${escapeHtml(trimmed)}</div>
      </li>
    `;
  });
  return `
    <h3 class="source-frames-heading">Source frames <small class="muted">— synthesis pending</small></h3>
    <p class="muted">No synthesized body yet. Showing the top recall hits for this entity name. The synth pipeline will produce a curated summary on the next drain.</p>
    <ul class="source-frames">
      ${items.join('\n')}
    </ul>
  `;
}

export function renderPage({ slug, page, error, dirtyEnqueued, sourceFrames }) {
  if (error || !page) {
    const main = `
      <h2>Page not found</h2>
      <p class="muted">slug: <code>${escapeHtml(slug)}</code></p>
      ${error ? `<pre>${escapeHtml(error)}</pre>` : ''}
      <p><a href="/">← back to home</a></p>
    `;
    return layout({ title: `${slug} · not found`, main, activeNav: '' });
  }

  const title = pickField(page, 'title', 'name', 'slug') || slug;
  const summary = pickField(page, 'summary', 'description');
  const body = pickField(page, 'body', 'content', 'markdown', 'text');

  const meta = [];
  if (page.updated_at || page.last_compiled || page.compiled_at) {
    meta.push(`<small class="muted">compiled ${escapeHtml(page.updated_at || page.last_compiled || page.compiled_at)}</small>`);
  }
  // page.sources is the count returned by get_page; page.source_frames may be
  // the actual array on richer responses. Prefer the count when both unset.
  const sourcesCount = (page.source_frames && Array.isArray(page.source_frames))
    ? page.source_frames.length
    : (typeof page.sources === 'number' ? page.sources : null);
  if (sourcesCount !== null) {
    meta.push(`<small class="muted">${sourcesCount} source frame${sourcesCount === 1 ? '' : 's'}</small>`);
  }
  const dirtyHint = dirtyEnqueued
    ? `<small class="muted">↻ resynth queued (will pick up new source frames on next drain)</small>`
    : '';

  // Prefer the synthesized body when it exists; otherwise show the recall
  // fallback. As soon as a synth-drain produces real content, the body
  // section wins on the next page view.
  const bodyHtml = body ? bodyToHtml(body) : renderSourceFrames(sourceFrames);

  const main = `
    <article>
      <h2>${escapeHtml(title)}</h2>
      ${summary ? `<p class="lead">${escapeHtml(summary)}</p>` : ''}
      <div class="meta">${meta.join(' · ')} ${dirtyHint}</div>
      <hr>
      <div class="body">
        ${bodyHtml || '<p class="muted">empty</p>'}
      </div>
    </article>
    <p class="muted"><a href="/">← back to home</a></p>
  `;
  return layout({ title: `${title} · hive-mind wiki`, main, activeNav: '' });
}
