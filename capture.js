/* capture.js — injected into edit.zoningatlas.org/statsrollup/* (the report iframe)
 *
 * This script:
 *  1. Finds all chart/graph containers on the page using multiple strategies
 *  2. Captures each as a PNG via SVG foreignObject → canvas (for div-based charts)
 *     or via canvas.toDataURL() directly (for native <canvas> charts)
 *  3. Responds to CAPTURE_CHARTS messages from background.js
 */

(function () {
  'use strict';

  /* ============================================================
     CHART DETECTION — heading-anchored section finder
     ============================================================ */

  // The 7 known report sections, in desired output order.
  // Matching is case-insensitive substring (.includes).
  const KNOWN_SECTIONS = [
    'zoning codes overview',
    'land categories',
    'zoning categories',
    'housing units allowed',
    'minimum lot sizes',
    'accessory dwelling units',
    'parking mandates'
  ];

  /**
   * Walk UP from a heading to find its enclosing section container.
   *
   * "Section container" criteria:
   *   - ≥ 200px tall and ≥ 300px wide
   *   - Heading sits in the top 40% of the element's height
   *   - Parent is at least 1.5× taller (prevents over-walking to a giant wrapper)
   *
   * Falls back to the heading's parentElement if nothing better is found.
   */
  function findSectionContainer(heading) {
    const hRect = heading.getBoundingClientRect();
    let el = heading.parentElement;

    while (el && el !== document.body && el !== document.documentElement) {
      const rect = el.getBoundingClientRect();

      if (rect.width >= 300 && rect.height >= 200) {
        const relPos = rect.height > 0
          ? (hRect.top - rect.top) / rect.height
          : 1;

        if (relPos >= 0 && relPos < 0.40) {
          const parentRect = el.parentElement
            ? el.parentElement.getBoundingClientRect()
            : null;

          // Stop here if parent is absent, zero-height, or significantly larger
          if (!parentRect || parentRect.height <= 0 || parentRect.height >= rect.height * 1.5) {
            return el;
          }
        }
      }

      el = el.parentElement;
    }

    return heading.parentElement || heading;
  }

  /**
   * Primary: find the 7 named sections by anchoring on their heading text.
   * Returns them in KNOWN_SECTIONS order; skips any not present on this page.
   */
  function findSectionsByHeading() {
    const allHeadings = Array.from(
      document.querySelectorAll('h1, h2, h3, h4, h5, h6')
    );
    const seen = new Set();
    const results = [];

    for (const name of KNOWN_SECTIONS) {
      const heading = allHeadings.find(h =>
        h.textContent.trim().toLowerCase().includes(name)
      );
      if (!heading) continue;

      const container = findSectionContainer(heading);
      if (container && !seen.has(container)) {
        seen.add(container);
        results.push(container);
      }
    }

    return results;
  }

  /**
   * Fallback: generic selector sweep used only when heading-based detection
   * finds nothing (e.g. site markup changed).
   *
   * Key fix vs the original: dedup keeps OUTERMOST elements (not innermost),
   * so a section container is kept rather than its child canvas/svg.
   */
  const FALLBACK_SELECTORS = [
    '[class*="chart-container"]',
    '[class*="chart-wrapper"]',
    '[class*="chart-section"]',
    '[class*="report-section"]',
    '[class*="stat-block"]',
    '[class*="stat_block"]',
    'canvas[width][height]',
    'svg[width][height]:not([aria-hidden="true"])',
  ];

  function findSectionsGeneric() {
    const seen = new Set();
    const candidates = [];

    for (const sel of FALLBACK_SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          if (seen.has(el)) return;
          if (el.closest('header, footer, nav, aside')) return;
          const { width, height } = el.getBoundingClientRect();
          if (width < 200 || height < 150) return;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          seen.add(el);
          candidates.push(el);
        });
      } catch (_) {}
    }

    // Keep outermost: drop any element that is a descendant of another candidate
    return candidates.filter(el =>
      !candidates.some(other => other !== el && other.contains(el))
    );
  }

  function detectCharts() {
    const primary = findSectionsByHeading();
    if (primary.length > 0) return primary;
    return findSectionsGeneric();
  }

  /* ============================================================
     CHART TITLE EXTRACTION
     ============================================================ */

  function getChartTitle(el, index) {
    // Look for a heading preceding or inside the element
    const heading = el.querySelector('h1, h2, h3, h4, h5, [class*="title"], [class*="heading"]');
    if (heading && heading.textContent.trim()) {
      return sanitizeFilename(heading.textContent.trim());
    }

    // aria-label or title attribute
    if (el.getAttribute('aria-label')) return sanitizeFilename(el.getAttribute('aria-label'));
    if (el.getAttribute('title')) return sanitizeFilename(el.getAttribute('title'));
    if (el.getAttribute('data-title')) return sanitizeFilename(el.getAttribute('data-title'));

    // Look at the previous sibling or parent heading
    let sibling = el.previousElementSibling;
    for (let i = 0; i < 3 && sibling; i++, sibling = sibling.previousElementSibling) {
      const text = sibling.textContent.trim();
      if (text && text.length < 80) return sanitizeFilename(text);
    }

    // Walk up and find preceding heading
    let parent = el.parentElement;
    for (let depth = 0; depth < 5 && parent; depth++, parent = parent.parentElement) {
      const h = parent.querySelector('h1, h2, h3, h4');
      if (h && h.textContent.trim() && !el.contains(h)) {
        return sanitizeFilename(h.textContent.trim());
      }
    }

    return `chart-${String(index + 1).padStart(2, '0')}`;
  }

  function sanitizeFilename(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'chart';
  }

  /* ============================================================
     CAPTURE — html2canvas
     ============================================================ */

  /**
   * Render a DOM element to a PNG data URL using html2canvas.
   *
   * WHY html2canvas instead of SVG foreignObject:
   *   foreignObject taints the canvas via ANY cross-origin resource —
   *   images, web fonts, filter URLs, etc. Every fix uncovered another
   *   source. html2canvas draws via Canvas 2D API calls directly against
   *   the live DOM, so there is no taint surface. Cross-origin images are
   *   skipped (allowTaint: false) rather than blocking the export.
   */
  async function captureElement(el) {
    const canvas = await window.html2canvas(el, {
      useCORS: true,        // attempt CORS fetch for same-origin images
      allowTaint: false,    // skip cross-origin images instead of tainting
      scale: 2,             // 2× retina quality
      backgroundColor: '#ffffff',
      logging: false,
      removeContainer: true // clean up temp DOM nodes html2canvas creates
    });
    return canvas.toDataURL('image/png');
  }

  /* ============================================================
     MESSAGE HANDLER
     ============================================================ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'CAPTURE_CHARTS') return;

    (async () => {
      try {
        const chartEls = detectCharts();

        if (chartEls.length === 0) {
          sendResponse({ error: 'No charts detected on the report page.' });
          return;
        }

        const rawNames = chartEls.map((el, i) => getChartTitle(el, i));

        // Deduplicate: suffix repeated names with -01, -02, etc.
        const nameCount = {};
        rawNames.forEach(n => { nameCount[n] = (nameCount[n] || 0) + 1; });
        const nameUsed = {};
        const uniqueNames = rawNames.map(n => {
          if (nameCount[n] > 1) {
            nameUsed[n] = (nameUsed[n] || 0) + 1;
            return `${n}-${String(nameUsed[n]).padStart(2, '0')}`;
          }
          return n;
        });

        // Tell popup the full list BEFORE captures start (so UI list appears immediately)
        chrome.runtime.sendMessage({ type: 'CHARTS_FOUND', names: uniqueNames })
          .catch(() => {});

        const results = [];
        for (let i = 0; i < chartEls.length; i++) {
          const name = uniqueNames[i];
          try {
            const dataUrl = await captureElement(chartEls[i]);
            results.push({ name, dataUrl, success: true });
            chrome.runtime.sendMessage({
              type: 'CHART_CAPTURED',
              name,
              index: i,
              total: chartEls.length
            }).catch(() => {});
          } catch (err) {
            // Log to the iframe's DevTools console for easier debugging.
            // (Select the iframe context in the DevTools console dropdown to see this.)
            console.error(`[pnger] capture failed for "${name}":`, err);
            results.push({ name, dataUrl: null, success: false, error: err.message });
            chrome.runtime.sendMessage({
              type: 'CHART_ERROR',
              name,
              error: err.message
            }).catch(() => {});
          }
        }

        sendResponse({ results, count: results.length });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();

    return true; // keep message channel open for async response
  });

})();
