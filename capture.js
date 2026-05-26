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
     CHART DETECTION
     Try selectors in priority order, dedup, filter noise
     ============================================================ */

  const MIN_WIDTH = 120;
  const MIN_HEIGHT = 100;

  // Selectors that are almost certainly chart wrappers
  const CHART_SELECTORS = [
    // Class-name fragments (case-insensitive handled via querySelectorAll patterns)
    '[class*="chart"]',
    '[class*="graph"]',
    '[class*="viz"]',
    '[class*="visualization"]',
    '[class*="snapshot"]',
    '[class*="stat-block"]',
    '[class*="stat_block"]',
    '[class*="figure"]',
    // Data attributes
    '[data-chart]',
    '[data-graph]',
    '[data-highcharts-chart]',
    // Common framework containers
    '.recharts-wrapper',
    '.vega-embed',
    '.plotly',
    '.highcharts-container',
    '.apexcharts-canvas',
    // Native chart elements
    'canvas',
    'svg:not([aria-hidden="true"]):not([width="0"])',
  ];

  // Tags we should never capture (structural/decorative)
  const EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'HTML',
    'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'META', 'LINK']);

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
  }

  function isExcluded(el) {
    if (EXCLUDED_TAGS.has(el.tagName)) return true;
    // Check if it's inside a header/footer/nav
    if (el.closest('header, footer, nav, aside')) return true;
    return false;
  }

  /**
   * Heuristic fallback: find large block-level elements that look like charts.
   * Avoids generic containers that just happen to be large.
   */
  function heuristicChartContainers() {
    const candidates = [];
    const allBlocks = document.querySelectorAll(
      'div, section, article, figure, table'
    );
    for (const el of allBlocks) {
      if (isExcluded(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 250 || rect.height < 150) continue;

      // Skip elements that contain other large block children
      // (we want the leaf-level chart container, not its wrapper)
      const largeChildren = Array.from(el.children).filter(child => {
        const cr = child.getBoundingClientRect();
        return cr.width >= 200 && cr.height >= 120;
      });
      if (largeChildren.length > 0) continue;

      // A chart is likely to contain at least one of: canvas, svg, or many
      // similarly-classed child divs (bar chart segments, etc.)
      const hasCanvas = el.querySelector('canvas');
      const hasSvg = el.querySelector('svg');
      const hasManyDivChildren = el.querySelectorAll(':scope > div').length >= 3;

      if (hasCanvas || hasSvg || hasManyDivChildren) {
        candidates.push(el);
      }
    }
    return candidates;
  }

  function detectCharts() {
    const seen = new Set();
    const charts = [];

    function addIfNew(el) {
      if (!el || seen.has(el)) return;
      if (isExcluded(el)) return;
      if (!isVisible(el)) return;
      seen.add(el);
      charts.push(el);
    }

    // Priority 1: explicit selectors
    for (const sel of CHART_SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach(addIfNew);
      } catch (_) {}
    }

    // Priority 2: heuristic large blocks (only if we found nothing)
    if (charts.length === 0) {
      heuristicChartContainers().forEach(addIfNew);
    }

    // Deduplicate: if an element is an ancestor of another, keep only the inner one
    const finalCharts = charts.filter(el =>
      !charts.some(other => other !== el && el.contains(other))
    );

    return finalCharts;
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
     SVG FOREIGN-OBJECT CAPTURE (div-based charts)
     ============================================================ */

  /**
   * Recursively inline all computed styles onto cloned nodes.
   * This ensures the element renders correctly inside an isolated SVG blob.
   */
  function inlineComputedStyles(source, target) {
    if (source.nodeType !== Node.ELEMENT_NODE) return;

    const computed = window.getComputedStyle(source);
    const style = [];
    for (let i = 0; i < computed.length; i++) {
      const prop = computed[i];
      const val = computed.getPropertyValue(prop);
      if (val) {
        style.push(`${prop}:${val}`);
      }
    }
    target.setAttribute('style', style.join(';'));

    // Remove class/id to avoid collisions
    target.removeAttribute('class');

    const srcChildren = source.children;
    const tgtChildren = target.children;
    for (let i = 0; i < srcChildren.length; i++) {
      if (tgtChildren[i]) {
        inlineComputedStyles(srcChildren[i], tgtChildren[i]);
      }
    }
  }

  /**
   * Fix relative URLs (href, src, xlink:href) to absolute so they resolve
   * inside a blob: URL context.
   */
  function resolveUrls(node) {
    const base = document.baseURI || window.location.href;

    function resolve(url) {
      try { return new URL(url, base).href; } catch (_) { return url; }
    }

    const walk = (el) => {
      if (el.nodeType !== Node.ELEMENT_NODE) return;
      ['src', 'href', 'xlink:href', 'action', 'data'].forEach(attr => {
        const val = el.getAttribute(attr);
        if (val && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('javascript:')) {
          el.setAttribute(attr, resolve(val));
        }
      });
      // CSS background-image inline styles
      if (el.style && el.style.backgroundImage) {
        el.style.backgroundImage = el.style.backgroundImage.replace(
          /url\(['"]?([^'")\s]+)['"]?\)/g,
          (_, u) => `url('${resolve(u)}')`
        );
      }
      Array.from(el.children).forEach(walk);
    };
    walk(node);
  }

  /**
   * Capture a div/SVG element via SVG foreignObject → canvas → PNG dataURL
   */
  async function captureViaForeignObject(el) {
    const rect = el.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);

    if (width < 1 || height < 1) throw new Error('Element has no dimensions');

    // Clone and prepare
    const clone = el.cloneNode(true);
    inlineComputedStyles(el, clone);
    resolveUrls(clone);

    // Force explicit dimensions on the clone root
    clone.style.width = width + 'px';
    clone.style.height = height + 'px';
    clone.style.overflow = 'hidden';
    clone.style.position = 'relative';

    // Serialize to XHTML inside foreignObject
    // Use XMLSerializer for proper namespace handling
    const serializer = new XMLSerializer();
    let cloneHtml;
    try {
      cloneHtml = serializer.serializeToString(clone);
    } catch (_) {
      cloneHtml = clone.outerHTML;
    }

    const svgSrc = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
      `<foreignObject x="0" y="0" width="${width}" height="${height}">`,
      cloneHtml,
      `</foreignObject>`,
      `</svg>`
    ].join('');

    const blob = new Blob([svgSrc], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(blob);

    return new Promise((resolve, reject) => {
      const img = new Image(width, height);

      img.onload = () => {
        const dpr = 2; // 2× for retina quality
        const canvas = document.createElement('canvas');
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        // White background (charts often have transparent fills)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(svgUrl);
        resolve(canvas.toDataURL('image/png'));
      };

      img.onerror = (e) => {
        URL.revokeObjectURL(svgUrl);
        reject(new Error('SVG image load failed'));
      };

      img.src = svgUrl;
    });
  }

  /**
   * Capture a native <canvas> element directly.
   */
  function captureCanvas(canvas) {
    try {
      // Try direct toDataURL (works if not tainted)
      const dataUrl = canvas.toDataURL('image/png');
      if (dataUrl && dataUrl !== 'data:,') return Promise.resolve(dataUrl);
      throw new Error('Canvas is empty');
    } catch (e) {
      // Canvas is cross-origin tainted; fall back to foreignObject approach
      return captureViaForeignObject(canvas);
    }
  }

  /**
   * Capture a native <svg> element.
   */
  function captureNativeSvg(svgEl) {
    try {
      const serializer = new XMLSerializer();
      const svgStr = serializer.serializeToString(svgEl);
      const rect = svgEl.getBoundingClientRect();
      const width = Math.ceil(svgEl.width?.baseVal?.value || rect.width);
      const height = Math.ceil(svgEl.height?.baseVal?.value || rect.height);

      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      return new Promise((resolve, reject) => {
        const img = new Image(width, height);
        img.onload = () => {
          const dpr = 2;
          const canvas = document.createElement('canvas');
          canvas.width = width * dpr;
          canvas.height = height * dpr;
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          // Fall back to foreignObject
          captureViaForeignObject(svgEl).then(resolve).catch(reject);
        };
        img.src = url;
      });
    } catch (_) {
      return captureViaForeignObject(svgEl);
    }
  }

  /**
   * Dispatch to the right capture method based on element type.
   */
  async function captureElement(el) {
    const tag = el.tagName.toUpperCase();
    if (tag === 'CANVAS') return captureCanvas(el);
    if (tag === 'SVG') return captureNativeSvg(el);
    return captureViaForeignObject(el);
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
