/** Small stroke icons, drawn like refcheck's (24px grid, 2px round strokes, currentColor). */
const stroke = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
};

const DOC = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z";

export const LogoIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d={DOC} />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="12" y2="17" />
  </svg>
);

export const UploadIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" {...stroke} stroke-width="1.5" aria-hidden="true">
    <path d={DOC} />
    <polyline points="14 2 14 8 20 8" />
    <path d="M12 18v-6M9 15l3-3 3 3" />
  </svg>
);

export const SunIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

export const MonitorIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export const MoonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
