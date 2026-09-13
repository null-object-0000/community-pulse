/* Runs before CSS to avoid a light flash when dark mode is selected. */
(() => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  let accent = 'neutral';
  try { const saved = localStorage.getItem('devtrends-theme-v1'); if (['light', 'dark', 'system'].includes(saved)) preference = saved; } catch {}
  try { const saved = localStorage.getItem('devtrends-accent-v1'); if (['neutral', 'blue', 'forest', 'violet'].includes(saved)) accent = saved; } catch {}
  function apply() {
    const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f0f0e' : '#f6f6f3');
  }
  window.DevTrendsTheme = {
    get: () => preference,
    getAccent: () => accent,
    set(value) { preference = ['system', 'light', 'dark'].includes(value) ? value : 'system'; try { localStorage.setItem('devtrends-theme-v1', preference); } catch {} apply(); },
    setAccent(value) { accent = ['neutral', 'blue', 'forest', 'violet'].includes(value) ? value : 'neutral'; try { localStorage.setItem('devtrends-accent-v1', accent); } catch {} apply(); },
  };
  media.addEventListener('change', apply);
  apply();
})();
