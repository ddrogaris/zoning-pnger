/* content.js — injected into www.zoningatlas.org/snapshots*
 *
 * Responsibilities:
 *  1. Monitor #report-frame so we know when the snapshot report is loaded
 *  2. Relay PING checks from the popup
 *  3. On EXPORT_CHARTS: tell background.js which frameId to inject into,
 *     then relay results back to the popup
 */

(function () {
  'use strict';

  let reportFrameReady = false;
  let reportFrameId = null;  // Chrome frameId of the iframe, resolved via background

  /* ------------------------------------------------------------------ */
  /* 1. Watch #report-frame for load                                      */
  /* ------------------------------------------------------------------ */

  function getReportFrame() {
    return document.getElementById('report-frame');
  }

  function onIframeLoad() {
    const iframe = getReportFrame();
    if (!iframe) return;
    const src = iframe.src;
    // Ignore the placeholder src="//:0"
    if (!src || src === 'about:blank' || src.endsWith('//:0') || src === window.location.href) return;
    reportFrameReady = true;
  }

  function watchFrame() {
    const iframe = getReportFrame();
    if (iframe) {
      // Already present
      iframe.addEventListener('load', onIframeLoad);
      // If iframe already has real content, mark ready
      try {
        if (iframe.src && iframe.src !== 'about:blank' && !iframe.src.endsWith('//:0')) {
          reportFrameReady = true;
        }
      } catch (_) {}
    }

    // Also watch DOM mutations in case iframe is inserted/src-changed after our script runs
    const observer = new MutationObserver(() => {
      const el = getReportFrame();
      if (el && !el._pngerWatched) {
        el._pngerWatched = true;
        el.addEventListener('load', onIframeLoad);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  }

  watchFrame();

  /* ------------------------------------------------------------------ */
  /* 2. Determine jurisdiction ID from URL or select element             */
  /* ------------------------------------------------------------------ */

  function getJurisdictionId() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('jurisdiction')) return params.get('jurisdiction');
    // Fallback: read iframe src
    const iframe = getReportFrame();
    if (iframe && iframe.src) {
      const m = iframe.src.match(/\/(\d+)\/?$/);
      if (m) return m[1];
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 3. Message handler                                                   */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ready: reportFrameReady, jurisdictionId: getJurisdictionId() });
      return true;
    }

    if (msg.type === 'EXPORT_CHARTS') {
      if (!reportFrameReady) {
        sendResponse({ error: 'Report iframe not loaded. Please wait for the snapshot to appear.' });
        return true;
      }

      // Ask background to find the frameId of #report-frame and run capture.js
      chrome.runtime.sendMessage(
        { type: 'START_EXPORT', tabId: null /* background knows the tab */, jurisdictionId: getJurisdictionId() },
        (bgResp) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }
          // bgResp.charts is the list of chart names found (for popup list display)
          sendResponse(bgResp);
        }
      );
      return true; // keep channel open for async response
    }
  });

})();
