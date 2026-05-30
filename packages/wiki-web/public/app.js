/* global document */
// Client-side: debounced search input.
(function () {
  const input = document.querySelector('.left-nav .search-box input[name="q"]');
  if (!input) return;

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return;
    timer = setTimeout(() => {
      // Just navigate — server-rendered. Keep it simple.
    }, 300);
  });
})();
