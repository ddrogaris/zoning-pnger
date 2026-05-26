/* popup.js — popup controller
 *
 * Message flow:
 *  PING  → chrome.tabs.sendMessage → content.js → {ready, jurisdictionId}
 *  START_EXPORT → chrome.runtime.sendMessage → background.js (with tabId)
 *  CHART_CAPTURED / CHART_ERROR → broadcast from capture.js via runtime → popup
 *  EXPORT_COMPLETE / EXPORT_FAILED → broadcast from background.js → popup
 */

const exportBtn  = document.getElementById('export-btn');
const statusText = document.getElementById('status-text');
const statusBox  = document.getElementById('status-box');
const spinner    = document.getElementById('spinner');
const chartList  = document.getElementById('chart-list');

let activeTabId = null;
let jurisdictionId = null;

/* ------------------------------------------------------------------ */
/* UI helpers                                                           */
/* ------------------------------------------------------------------ */

function setStatus(msg, type = '', spinning = false) {
  statusText.textContent = msg;
  statusBox.className = ['error', 'success', 'working'].includes(type) ? type : '';
  spinner.classList.toggle('visible', spinning);
}

function addChartRow(name) {
  if (document.getElementById(`ci-${CSS.escape(name)}`)) return;
  const row = document.createElement('div');
  row.className = 'chart-list-item';
  row.id = `ci-${name}`;

  const dot = document.createElement('div');
  dot.className = 'dot';
  dot.id = `dot-${name}`;

  const lbl = document.createElement('span');
  lbl.textContent = name;

  row.appendChild(dot);
  row.appendChild(lbl);
  chartList.appendChild(row);
}

function markDot(name, state) {
  const dot = document.getElementById(`dot-${name}`);
  if (dot) dot.className = `dot ${state}`;
}

/* ------------------------------------------------------------------ */
/* On open: check current tab                                          */
/* ------------------------------------------------------------------ */

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) { setStatus('No active tab found.', 'error'); return; }

  activeTabId = tab.id;
  const url = tab.url || '';

  if (!url.includes('zoningatlas.org/snapshots')) {
    setStatus('Navigate to zoningatlas.org/snapshots?jurisdiction=… to begin.', 'error');
    return;
  }

  // Extract jurisdiction ID from URL
  try {
    const params = new URLSearchParams(new URL(url).search);
    jurisdictionId = params.get('jurisdiction') || null;
  } catch (_) {}

  // PING the content script to check if the report iframe is loaded
  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      // Content script may not be injected yet (page still loading)
      setStatus('Page still loading — wait a moment and re-open this popup.', 'working');
      return;
    }
    if (resp.ready) {
      jurisdictionId = resp.jurisdictionId || jurisdictionId;
      setStatus(`Jurisdiction ${jurisdictionId || '?'} snapshot loaded. Ready to export.`);
      exportBtn.disabled = false;
    } else {
      setStatus('Snapshot not loaded yet. Select a jurisdiction on the page first.', 'working');
    }
  });
});

/* ------------------------------------------------------------------ */
/* Export button                                                        */
/* ------------------------------------------------------------------ */

exportBtn.addEventListener('click', () => {
  if (!activeTabId) return;
  exportBtn.disabled = true;
  chartList.innerHTML = '';
  setStatus('Starting export…', 'working', true);

  chrome.runtime.sendMessage(
    { type: 'START_EXPORT', tabId: activeTabId, jurisdictionId },
    (ack) => {
      if (chrome.runtime.lastError) {
        setStatus('Background error: ' + chrome.runtime.lastError.message, 'error');
        exportBtn.disabled = false;
        return;
      }
      if (ack?.error) {
        setStatus('Error: ' + ack.error, 'error');
        exportBtn.disabled = false;
      }
      // Otherwise we wait for broadcast messages (CHART_CAPTURED, EXPORT_COMPLETE, etc.)
    }
  );
});

/* ------------------------------------------------------------------ */
/* Incoming broadcast messages from capture.js / background.js         */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'CHARTS_FOUND':
      // Background found and named all charts — populate the list
      if (Array.isArray(msg.names)) {
        chartList.innerHTML = '';
        msg.names.forEach(name => addChartRow(name));
        setStatus(`Capturing ${msg.names.length} chart(s)…`, 'working', true);
      }
      break;

    case 'CHART_CAPTURED':
      markDot(msg.name, 'done');
      setStatus(`Captured ${msg.index + 1} / ${msg.total}…`, 'working', true);
      break;

    case 'CHART_ERROR':
      markDot(msg.name, 'error');
      break;

    case 'EXPORT_COMPLETE':
      spinner.classList.remove('visible');
      setStatus(`✓ Downloaded ${msg.count} chart(s) as ZIP`, 'success');
      exportBtn.disabled = false;
      break;

    case 'EXPORT_FAILED':
      spinner.classList.remove('visible');
      setStatus('Export failed: ' + (msg.error || 'unknown error'), 'error');
      exportBtn.disabled = false;
      break;
  }
});
