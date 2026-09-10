/* Runs before CSS to avoid a light flash when dark mode is selected. */
(() => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = localStorage.getItem('devtrends-theme-v1'); if (['light', 'dark', 'system'].includes(saved)) preference = saved; } catch {}
  function apply() {
    const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#11151c' : '#f7f8fa');
  }
  window.DevTrendsTheme = {
    get: () => preference,
    set(value) { preference = ['system', 'light', 'dark'].includes(value) ? value : 'system'; try { localStorage.setItem('devtrends-theme-v1', preference); } catch {} apply(); },
  };
  media.addEventListener('change', apply);
  apply();
})();
