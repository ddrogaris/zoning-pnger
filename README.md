# Zoning Atlas Chart Exporter

A Chrome extension that bulk-exports every chart on a National Zoning Atlas snapshot page as a set of PNGs bundled in a single ZIP file.

## How it works

1. The snapshot page (`zoningatlas.org/snapshots?jurisdiction=…`) loads the actual report inside a cross-origin iframe (`edit.zoningatlas.org/statsrollup/…`).
2. The extension injects `capture.js` directly into that iframe via the `all_frames: true` content-script declaration and matching host permissions.
3. Each chart container is found via a multi-strategy DOM search (explicit class selectors → heuristic large-block detection).
4. **Div-based charts** are captured using the **SVG `<foreignObject>` technique**: the element is cloned, every descendant's computed styles are inlined, relative URLs are made absolute, and the result is serialised into an SVG blob → rendered onto a 2× canvas → exported as PNG.
5. **Native `<canvas>` elements** (e.g. Chart.js) are captured directly via `canvas.toDataURL()`.
6. **Native `<svg>` elements** are serialised with `XMLSerializer` and rendered via canvas.
7. All PNGs are zipped using JSZip and downloaded as a single archive.

---

## Installation (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `pnger/` folder (this directory)
5. The "Zoning Chart Exporter" extension appears in your toolbar (pin it via the puzzle-piece icon)

---

## Usage

1. Navigate to a snapshot URL, e.g.:
   ```
   https://www.zoningatlas.org/snapshots?jurisdiction=8998
   ```
2. Wait for the report to fully load (charts become visible).
3. Click the extension icon 🗺️ in the toolbar.
4. Confirm the popup shows **"Jurisdiction XXXX snapshot loaded. Ready to export."**
5. Click **Export Charts as ZIP**.
6. The extension captures each chart in order, showing a live checklist.
7. A ZIP file named `zoning-snapshot-8998-2026-05-26.zip` downloads to your default Downloads folder.

---

## Output

Each PNG inside the ZIP is named:
```
01-housing-mix.png
02-lot-size-distribution.png
03-chart-03.png          ← fallback name when no heading is found
…
```

- Resolution: **2× device pixels** (retina-quality)
- Background: white (charts with transparent fills look correct)
- One file per detected chart container, in document order

---

## File structure

```
pnger/
├── manifest.json      Chrome MV3 manifest
├── popup.html         Popup UI
├── popup.js           Popup controller
├── content.js         Injected into main page (PING / ready check)
├── capture.js         Injected into report iframe (detection + SVG capture)
├── background.js      Service worker (ZIP build, download, message relay)
└── lib/
    └── jszip.min.js   Bundled JSZip (no network calls)
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup shows "Page still loading" | Refresh the page; wait for charts to appear; re-open popup |
| "Snapshot report iframe not found" | The page must show the charts (select a jurisdiction first, or use the `?jurisdiction=` URL param) |
| "No charts detected" | The site may have updated its markup — open DevTools on the iframe page and check the DOM for chart container class names, then add them to the `CHART_SELECTORS` array in `capture.js` |
| PNGs are blank / wrong | External image assets inside charts may be blocked by CORS inside the SVG blob — this is a known limitation of the foreignObject technique for pages with cross-origin images |
| Extension not appearing | Make sure Developer Mode is on and the folder was loaded correctly |

---

## Permissions

| Permission | Why |
|---|---|
| `downloads` | Save the ZIP file |
| `scripting` | Detect the iframe's frame ID |
| `activeTab` | Access the current tab |
| `tabs` | Query the active tab from the popup |
| host: `www.zoningatlas.org` | Inject content script into main page |
| host: `edit.zoningatlas.org` | Inject capture script into report iframe |
