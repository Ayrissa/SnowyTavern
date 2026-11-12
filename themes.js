// SnowyTavern — themes.js
//
// Theme registry. Each theme is just a CSS class toggled on <body>; the
// actual rules live in style.css under `body.snowytavern-theme-<id>`.
// To add a new theme later: add an entry here (id/label) and a matching
// CSS block in style.css — nothing else in index.js needs to change.

export const THEMES = [
    {
        id: 'none',
        label: 'Без темы',
        className: null,
    },
    {
        id: 'classic',
        label: '🎄 Зима / Classic',
        className: 'snowytavern-theme-classic',
    },
];

export function getTheme(id) {
    return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function applyTheme(id) {
    for (const theme of THEMES) {
        if (theme.className) {
            document.body.classList.remove(theme.className);
        }
    }
    const theme = getTheme(id);
    if (theme.className) {
        document.body.classList.add(theme.className);
    }
}
