/* content.js — injected into www.zoningatlas.org/snapshots*
 *
 * Sole job: answer PING from popup.js, reporting whether the
 * #report-frame iframe has a live report loaded.
 * (The actual chart capture happens in capture.js, inside the iframe.)
 */

(function () {
  'use strict';

  let reportFrameReady = false;

  /* ------------------------------------------------------------------ */
  /* Watch #report-frame for load                                        */
  /* ------------------------------------------------------------------ */

  const PLACEHOLDER_SRCS = new Set(['//:0', 'about:blank', '', window.location.href]);

  function isRealSrc(src) {
    return src && !PLACEHOLDER_SRCS.has(src) && src.startsWith('http');
  }

  function markReady(iframe) {
    if (!iframe) return;
    const src = iframe.getAttribute('src') || iframe.src || '';
    if (isRealSrc(src)) reportFrameReady = true;
  }

  function attachLoadListener(iframe) {
    if (iframe._pngerWatched) return;
    iframe._pngerWatched = true;
    iframe.addEventListener('load', () => markReady(iframe));
    // Mark ready immediately if already has a live src
    markReady(iframe);
  }

  // Attach to existing iframe (if page already loaded when script ran)
  const existing = document.getElementById('report-frame');
  if (existing) attachLoadListener(existing);

  // Watch for DOM changes (iframe added or src changed dynamically)
  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      if (mut.type === 'childList') {
        mut.addedNodes.forEach(node => {
          if (node.id === 'report-frame') attachLoadListener(node);
        });
      } else if (mut.type === 'attributes' && mut.target.id === 'report-frame') {
        markReady(mut.target);
      }
    }
  });
  observer.observe(document.body || document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src']
  });

  /* ------------------------------------------------------------------ */
  /* Resolve jurisdiction ID                                             */
  /* ------------------------------------------------------------------ */

  function getJurisdictionId() {
    // From URL query param (e.g. ?jurisdiction=8998)
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('jurisdiction');
    if (fromUrl) return fromUrl;

    // Fallback: parse from the iframe's src
    const iframe = document.getElementById('report-frame');
    if (iframe) {
      const src = iframe.getAttribute('src') || iframe.src || '';
      const m = src.match(/\/(\d+)\/?(\?.*)?$/);
      if (m) return m[1];
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Message handler                                                     */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'PING') return; // only handles PING

    // Re-check iframe state at message time (handles case where iframe
    // loaded before content script attached its listener)
    const iframe = document.getElementById('report-frame');
    if (iframe) {
      const src = iframe.getAttribute('src') || iframe.src || '';
      if (isRealSrc(src)) reportFrameReady = true;
    }

    sendResponse({
      ready: reportFrameReady,
      jurisdictionId: getJurisdictionId()
    });

    return false; // synchronous response
  });

})();
