/**
 * Banner illustration for the customer dashboard: an umbrella of cover over a
 * home, a car and a family, with a protective shield. Inline SVG, so it needs
 * no network request and scales cleanly.
 */
export function CoverageIllustration({ className }) {
  return (
    <svg viewBox="0 0 360 200" className={className} role="img" aria-label="An umbrella sheltering a home, a car and a family">
      <defs>
        <linearGradient id="cov-umbrella" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
        <linearGradient id="cov-ground" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1e3a5f" stopOpacity="0" />
          <stop offset="0.5" stopColor="#1e3a5f" />
          <stop offset="1" stopColor="#1e3a5f" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* rain stopped by the umbrella */}
      <g stroke="#7dd3fc" strokeWidth="2" strokeLinecap="round" opacity="0.55">
        <path d="M28 18l-6 14M58 6l-6 14M300 10l-6 14M332 26l-6 14M18 66l-6 14M344 70l-6 14" />
      </g>

      {/* umbrella canopy and handle */}
      <path d="M60 92C68 42 116 18 180 18s112 24 120 74c-12-10-26-10-38 0-12-10-28-10-41 0-13-10-29-10-41 0-12-10-28-10-41 0-12-10-27-10-39 0Z" fill="url(#cov-umbrella)" />
      <path d="M180 18v-8" stroke="#99f6e4" strokeWidth="3" strokeLinecap="round" />
      <path d="M180 92v80c0 8-12 8-12 0" fill="none" stroke="#cbd5e1" strokeWidth="3" strokeLinecap="round" />

      {/* ground */}
      <rect x="20" y="172" width="320" height="3" rx="1.5" fill="url(#cov-ground)" />

      {/* home */}
      <g>
        <path d="M84 172v-38l28-22 28 22v38Z" fill="#e2e8f0" />
        <path d="M78 136l34-28 34 28" fill="none" stroke="#f8fafc" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
        <rect x="104" y="148" width="16" height="24" rx="2" fill="#13325c" />
        <rect x="90" y="140" width="10" height="10" rx="1.5" fill="#7dd3fc" />
        <rect x="124" y="140" width="10" height="10" rx="1.5" fill="#7dd3fc" />
      </g>

      {/* car */}
      <g>
        <path d="M200 162l8-16c2-4 5-6 9-6h34c4 0 7 2 9 6l8 16h4c3 0 5 2 5 5v3h-82v-3c0-3 2-5 5-5Z" fill="#fbbf24" />
        <path d="M214 160l6-12h30l6 12Z" fill="#bae6fd" />
        <circle cx="214" cy="171" r="7" fill="#0f172a" />
        <circle cx="214" cy="171" r="3" fill="#94a3b8" />
        <circle cx="262" cy="171" r="7" fill="#0f172a" />
        <circle cx="262" cy="171" r="3" fill="#94a3b8" />
      </g>

      {/* family */}
      <g fill="#f1f5f9">
        <circle cx="160" cy="132" r="6" />
        <path d="M152 172v-24c0-5 3-8 8-8s8 3 8 8v24Z" />
        <circle cx="176" cy="146" r="4.5" />
        <path d="M170 172v-14c0-4 2-6 6-6s6 2 6 6v14Z" />
      </g>

      {/* shield with tick */}
      <g transform="translate(296 116)">
        <path d="M0 0l22 8v18c0 16-10 26-22 32C-12 52-22 42-22 26V8Z" fill="#13325c" stroke="#2dd4bf" strokeWidth="3" />
        <path d="M-9 26l6 6 13-14" fill="none" stroke="#2dd4bf" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  )
}
