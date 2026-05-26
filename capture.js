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

  /* ============================================================
     CROSS-ORIGIN IMAGE INLINING
     Any <img src> or CSS background-image that points to a
     cross-origin URL will taint the canvas and block toDataURL().
     We fetch each one and replace it with a base64 data: URL before
     the clone is serialised into the SVG blob.
     ============================================================ */

  /** Fetch a URL and return it as a base64 data: URL. */
  async function fetchAsDataUrl(url) {
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Walk a cloned element and replace every external image reference
   * (<img src>, CSS background-image) with an inlined data: URL.
   * Silently clears any src/background that can't be fetched so the
   * resource is simply absent rather than tainting the canvas.
   */
  async function inlineImages(root) {
    const tasks = [];

    // 1. <img src="…">
    root.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) return;
      tasks.push(
        fetchAsDataUrl(src)
          .then(d => img.setAttribute('src', d))
          .catch(() => { img.setAttribute('src', ''); img.style.display = 'none'; })
      );
    });

    // 2. Inline style background-image on every element
    root.querySelectorAll('*').forEach(el => {
      const bg = el.style.backgroundImage;
      if (!bg) return;
      const match = bg.match(/url\(['"]?([^'")\s]+)['"]?\)/);
      if (!match || !match[1] || match[1].startsWith('data:')) return;
      const url = match[1];
      tasks.push(
        fetchAsDataUrl(url)
          .then(d => { el.style.backgroundImage = `url('${d}')`; })
          .catch(() => { el.style.backgroundImage = 'none'; })
      );
    });

    await Promise.allSettled(tasks);
  }

  /**
   * Capture a div/SVG element via SVG foreignObject → canvas → PNG dataURL.
   * Images are inlined as data: URLs before serialisation so the canvas
   * never becomes tainted.
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

    // Inline all images as data: URLs — prevents canvas taint
    await inlineImages(clone);

    // Force explicit dimensions on the clone root
    clone.style.width = width + 'px';
    clone.style.height = height + 'px';
    clone.style.overflow = 'hidden';
    clone.style.position = 'relative';

    // Serialize to XHTML inside foreignObject
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
        // Wrap toDataURL in try/catch: if a resource we couldn't inline
        // still taints the canvas, reject cleanly instead of hanging.
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch (secErr) {
          reject(secErr);
        }
      };

      img.onerror = () => {
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
