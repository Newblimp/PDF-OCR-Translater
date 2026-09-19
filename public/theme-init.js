// Applies the saved colour theme before the stylesheet paints, so a forced
// light/dark choice never flashes another theme on load. Loaded synchronously
// from index.html (allowed by the CSP's script-src 'self').
// Keep the storage key and the default ("dark", as in refcheck) in sync with
// src/lib/storage/settings.ts; src/main.tsx re-applies the theme afterwards.
(function () {
  var theme = "dark";
  try {
    var raw = localStorage.getItem("pdf-ocr-translater.settings.v2");
    if (raw) theme = JSON.parse(raw).theme || theme;
  } catch (e) {
    /* ignore: storage unavailable or corrupt */
  }
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
})();
