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

All rasters have real alpha. The wordmark is illegible below ~100px, which is
why favicons use the mark alone.

**npm note:** npmjs.com does not resolve relative image paths in a README, so
package READMEs must reference the logo by absolute `raw.githubusercontent.com`
URL.
