/**
 * Base HTML layout. Pure string template.
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { escapeHtml };

export function layout({ title = 'Hive Mind Wiki', main = '', rightRail = '', activeNav = '' }) {
  const navItems = [
    { href: '/', label: 'Home' },
    { href: '/search', label: 'Search' },
    { href: '/graph', label: 'Graph' },
  ];
  const navHtml = navItems
    .map((n) => `<a href="${n.href}" class="${activeNav === n.label ? 'active' : ''}">${escapeHtml(n.label)}</a>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="app">
    <aside class="left-nav">
      <h1 class="brand">hive-mind</h1>
      <nav>${navHtml}</nav>
      <form action="/search" method="get" class="search-box">
        <input type="search" name="q" placeholder="Search…" autocomplete="off">
      </form>
    </aside>
    <main class="main">
      ${main}
    </main>
    <aside class="right-rail">
      ${rightRail}
    </aside>
  </div>
  <script src="/app.js"></script>
</body>
</html>`;
}
