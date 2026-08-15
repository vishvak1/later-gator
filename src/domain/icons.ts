/**
 * Inline so folder rows and toolbar toggles need no extra request and inherit
 * the current text colour in both themes.
 */
export const ICONS = {
  all: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>`,
  unsorted: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6v2.2a1.8 1.8 0 0 0 3.6 0V4H21v5.4a1.8 1.8 0 0 1 0 3.6V20H4V13a1.8 1.8 0 0 1 0-3.6V4h5v2.2a1.8 1.8 0 0 0 0 0Z"/></svg>`,
  social: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-3.3A8.4 8.4 0 1 1 21 11.5Z"/></svg>`,
  articles: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11l3 3v13H5z"/><path d="M8 10h8M8 14h8M8 18h5"/></svg>`,
  videos: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 11l5-3v8l-5-3z"/></svg>`,
  code: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/></svg>`,
  docs: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h9l5 5v11H5z"/><path d="M14 4v5h5"/></svg>`,
  papers: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M9 12h6M9 16h4"/><circle cx="12" cy="8" r="1.6"/></svg>`,
  websites: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/></svg>`,
  review: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5 21 19H3z"/><path d="M12 10v4M12 16.5v.5"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`,
  heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-9.5A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.5 2.9C19.5 15.4 12 20 12 20Z"/></svg>`,
  note: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v11l-5 5H5z"/><path d="M19 15h-5v5"/><path d="M8 9h8M8 12.5h5"/></svg>`,
  help: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.9.7-.9 1.4v.4"/><path d="M12 17v.4"/></svg>`,
  /** Opens the folder and topic drawer where the sidebar cannot fit. */
  menu: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  logout: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M10 8l-4 4 4 4M6 12h9"/></svg>`,
  /**
   * Sits beside the Unsorted heading while the AI works. The wand arm and the
   * sparkles are separate groups so CSS can animate them independently.
   */
  mascot: `<svg viewBox="0 0 64 56" class="mascot-svg">
    <path d="M6 34c0-11 8-19 19-19h12c10 0 18 6 20 14l-11 1 11 5c-2 12-12 20-25 20H21C13 55 6 48 6 40v-6Z" fill="#2f7d4f"/>
    <path d="M12 36c0-8 6-14 14-14h10c7 0 13 4 15 10l-8 1 8 3c-2 9-9 15-19 15H23c-6 0-11-5-11-11v-4Z" fill="#8fd6a8"/>
    <circle cx="24" cy="27" r="3.2" fill="#183222"/><circle cx="25" cy="26" r="1.1" fill="#fff"/>
    <circle cx="38" cy="27" r="3.2" fill="#183222"/><circle cx="39" cy="26" r="1.1" fill="#fff"/>
    <path d="M20 42h26M27 42l3 5 3-5 3 5 3-5" fill="none" stroke="#2f7d4f" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <g class="mascot-wand">
      <path d="M47 30 60 15" stroke="#8a6a3a" stroke-width="3.4" stroke-linecap="round"/>
      <g class="mascot-sparks" fill="#f2c94c">
        <path d="M60 9.5l1.5 3.6 3.6 1.5-3.6 1.5-1.5 3.6-1.5-3.6-3.6-1.5 3.6-1.5z"/>
        <circle cx="53" cy="9" r="1.5"/><circle cx="63" cy="22" r="1.2"/>
      </g>
    </g>
  </svg>`,
  settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/></svg>`,
} as const;

/** Folder slugs are fixed by the schema, so the mapping is total. */
export const FOLDER_ICONS: Readonly<Record<string, string>> = {
  "social-posts": ICONS.social,
  articles: ICONS.articles,
  "videos-talks": ICONS.videos,
  code: ICONS.code,
  "docs-reference": ICONS.docs,
  papers: ICONS.papers,
  "websites-apps": ICONS.websites,
  "need-review": ICONS.review,
  unsorted: ICONS.unsorted,
  trash: ICONS.trash,
  all: ICONS.all,
};
