/* background.js — MV3 service worker
 *
 * Message flow:
 *  1. popup.js  → runtime.sendMessage(START_EXPORT, {tabId, jurisdictionId})
 *  2. background → scripting to find report iframe frameId
 *  3. background → tabs.sendMessage(CAPTURE_CHARTS, {frameId}) → capture.js
 *  4. capture.js → runtime.sendMessage(CHART_CAPTURED)  [broadcast to popup too]
 *  5. capture.js → sendResponse({results})
 *  6. background → builds ZIP → downloads → runtime.sendMessage(EXPORT_COMPLETE)
 */

importScripts('lib/jszip.min.js');

/* ------------------------------------------------------------------ */
/* Message listener                                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_EXPORT') {
    const { tabId, jurisdictionId } = msg;

    // Acknowledge immediately so popup knows we started
    sendResponse({ started: true });

    // Run async export in background (don't await here — channel already closed)
    runExport(tabId, jurisdictionId).catch(err => {
      broadcast({ type: 'EXPORT_FAILED', error: err.message });
    });

    return false; // response already sent
  }

  // Relay progress from capture.js to popup
  // (capture.js uses chrome.runtime.sendMessage which already goes to popup
  //  directly, but we still want background to be aware of it)
  if (msg.type === 'CHART_CAPTURED' || msg.type === 'CHART_ERROR') {
    // Nothing to do — these are already broadcast to all extension pages
    return false;
  }
});

/* ------------------------------------------------------------------ */
/* Find the report iframe frameId                                       */
/* ------------------------------------------------------------------ */

async function findReportFrameId(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        url: window.location.href,
        isReport: window.location.href.includes('edit.zoningatlas.org/statsrollup')
      })
    });
  } catch (err) {
    throw new Error('Could not inspect tab frames: ' + err.message);
  }

  for (const r of results) {
    if (r.result && r.result.isReport) {
      return r.frameId;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Main export pipeline                                                 */
/* ------------------------------------------------------------------ */

async function runExport(tabId, jurisdictionId) {
  // 1. Find the iframe's frameId
  const frameId = await findReportFrameId(tabId);

  if (frameId === null) {
    broadcast({
      type: 'EXPORT_FAILED',
      error: 'Snapshot report iframe not found. Make sure the report is visible on the page.'
    });
    return;
  }

  // 2. Send CAPTURE_CHARTS to capture.js in the iframe frame
  let captureResp;
  try {
    captureResp = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'CAPTURE_CHARTS' },
        { frameId },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(resp);
          }
        }
      );
    });
  } catch (err) {
    broadcast({
      type: 'EXPORT_FAILED',
      error: 'Failed to reach capture script in iframe: ' + err.message +
             ' — ensure the snapshot page is fully loaded.'
    });
    return;
  }

  if (!captureResp) {
    broadcast({ type: 'EXPORT_FAILED', error: 'No response from capture script.' });
    return;
  }
  if (captureResp.error) {
    broadcast({ type: 'EXPORT_FAILED', error: captureResp.error });
    return;
  }

  // 3. Build ZIP from captured PNGs
  // (CHARTS_FOUND and CHART_CAPTURED were already broadcast by capture.js)
  const { results } = captureResp;
  if (!results || results.length === 0) {
    broadcast({ type: 'EXPORT_FAILED', error: 'No charts were captured.' });
    return;
  }

  let zip;
  try {
    zip = new JSZip();
  } catch (err) {
    broadcast({ type: 'EXPORT_FAILED', error: 'JSZip init failed: ' + err.message });
    return;
  }

  let successCount = 0;
  for (let i = 0; i < results.length; i++) {
    const { name, dataUrl, success } = results[i];
    if (!success || !dataUrl) continue;
    const base64 = dataUrl.split(',')[1];
    if (!base64) continue;
    const filename = `${String(i + 1).padStart(2, '0')}-${name}.png`;
    zip.file(filename, base64, { base64: true });
    successCount++;
  }

  if (successCount === 0) {
    // Surface the first few individual error messages so the user doesn't need DevTools.
    const errLines = results
      .filter(r => r.error)
      .slice(0, 3)
      .map(r => `• ${r.name}: ${r.error}`);
    const detail = errLines.length
      ? '\n' + errLines.join('\n')
      : ' (no error details available)';
    broadcast({ type: 'EXPORT_FAILED', error: 'All chart captures failed.' + detail });
    return;
  }

  // 4. Generate ZIP blob and download
  let zipB64;
  try {
    zipB64 = await zip.generateAsync({ type: 'base64' });
  } catch (err) {
    broadcast({ type: 'EXPORT_FAILED', error: 'ZIP generation failed: ' + err.message });
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const filename = `zoning-snapshot-${jurisdictionId || 'export'}-${date}.zip`;

  chrome.downloads.download(
    { url: 'data:application/zip;base64,' + zipB64, filename, saveAs: false },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        broadcast({ type: 'EXPORT_FAILED', error: chrome.runtime.lastError.message });
      } else {
        broadcast({ type: 'EXPORT_COMPLETE', count: successCount, downloadId, filename });
      }
    }
  );
}

/* ------------------------------------------------------------------ */
/* Broadcast to all extension pages (popup, etc.)                      */
/* ------------------------------------------------------------------ */

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Popup may be closed — ignore
  });
}
