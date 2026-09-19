// Applies the saved colour theme before the stylesheet paints, so a forced
// light/dark choice never flashes the system theme on load. Loaded
// synchronously from index.html (allowed by the CSP's script-src 'self').
// Keep the storage key in sync with SETTINGS_STORAGE_KEY in
// src/lib/storage/settings.ts; src/main.tsx re-applies the theme afterwards.
(function () {
  try {
    var raw = localStorage.getItem("pdf-ocr-translater.settings.v2");
    var theme = raw ? JSON.parse(raw).theme : null;
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch (e) {
    /* ignore: storage unavailable or corrupt */
  }
})();
