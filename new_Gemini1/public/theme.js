(function () {
  'use strict';

  const THEME_KEY = 'ros2ide_theme';
  const LEGACY_THEME_KEY = 'ros2ide-theme';

  function normalizeTheme(theme) {
    return theme === 'light' ? 'light' : 'dark';
  }

  function updateThemeIcons(theme) {
    const moon = document.getElementById('icon-moon');
    const sun = document.getElementById('icon-sun');
    if (moon) moon.style.display = theme === 'light' ? 'none' : '';
    if (sun) sun.style.display = theme === 'light' ? '' : 'none';
  }

  function applyTheme(theme, persist) {
    const next = normalizeTheme(theme);
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    updateThemeIcons(next);
    if (persist) {
      localStorage.setItem(THEME_KEY, next);
      localStorage.removeItem(LEGACY_THEME_KEY);
    }
    window.dispatchEvent(new CustomEvent('roside-theme-change', { detail: { theme: next } }));
    return next;
  }

  const savedTheme = localStorage.getItem(THEME_KEY) || localStorage.getItem(LEGACY_THEME_KEY) || 'dark';
  applyTheme(savedTheme, true);

  window.applyRosideTheme = theme => applyTheme(theme, true);
  window.toggleTheme = function () {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light', true);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => updateThemeIcons(normalizeTheme(savedTheme)), { once: true });
  } else {
    updateThemeIcons(normalizeTheme(savedTheme));
  }

  window.addEventListener('storage', event => {
    if (event.key === THEME_KEY && event.newValue) applyTheme(event.newValue, false);
  });
})();
