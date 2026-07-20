# Brand assets

Generated from `logo.svg` (the source of truth — Inkscape-authored, with the
letter counters boolean-subtracted so they are real holes rather than white
fills). Regenerate rasters rather than editing them by hand.

| File | Use |
|---|---|
| `logo.svg` | full lockup, icon + wordmark — source of truth |
| `logo.png` / `logo-600.png` | README and npm page (1200px / 600px) |
| `icon.svg` | mark only, no wordmark — source for favicons |
| `icon-512.png` | PWA / large app icon |
| `apple-touch-icon.png` | 180px, iOS home screen |
| `icon-32.png`, `icon-16.png` | browser favicons |
| `favicon.ico` | multi-resolution 16/32/48 |

## Palette

| Colour | Use | Contrast (white / dark) |
|---|---|---|
| `#EA580C` | "Author" wordmark | 3.56 / 5.32 |
| `#0B90AE` | "bot" wordmark | 3.95 / 4.79 |
| `#102A40` | book cover, robot body | 14.71 / 1.29 |
| `#E2B655` | sparkle accent | 1.90 / 9.96 |

The wordmark was navy until it proved invisible on dark backgrounds (1.29:1 —
the book cover colour is fine as a shape but fails as text). `#EA580C` clears
the 3:1 large-text threshold against both white and GitHub's dark background.
Keep that constraint if the palette changes: the logo appears on light READMEs,
dark READMEs, and npm.

All rasters have real alpha. The wordmark is illegible below ~100px, which is
why favicons use the mark alone.

**npm note:** npmjs.com does not resolve relative image paths in a README, so
package READMEs must reference the logo by absolute `raw.githubusercontent.com`
URL.
