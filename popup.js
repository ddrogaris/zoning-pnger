/* popup.js — popup controller */

const exportBtn = document.getElementById('export-btn');
const statusText = document.getElementById('status-text');
const statusBox = document.getElementById('status-box');
const spinner = document.getElementById('spinner');
const chartList = document.getElementById('chart-list');

function setStatus(msg, type = 'info', spinning = false) {
  statusText.textContent = msg;
  statusBox.className = type === 'error' ? 'error' :
                        type === 'success' ? 'success' :
                        type === 'working' ? 'working' : '';
  spinner.classList.toggle('visible', spinning);
}

function addChartItem(name, state = 'pending') {
  const item = document.createElement('div');
  item.className = 'chart-list-item';
  item.id = `chart-item-${name}`;
  const dot = document.createElement('div');
  dot.className = `dot ${state === 'done' ? 'done' : state === 'error' ? 'error' : ''}`;
  item.appendChild(dot);
  const label = document.createElement('span');
  label.textContent = name;
  item.appendChild(label);
  chartList.appendChild(item);
  return { dot };
}

// Check if we're on the right page
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;

  const url = tab.url || '';
  if (!url.includes('zoningatlas.org/snapshots')) {
    setStatus('Navigate to zoningatlas.org/snapshots?jurisdiction=… first.', 'error');
    return;
  }

  // Check if the report iframe has loaded
  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      setStatus('Page loading… refresh and try again.', 'error');
      return;
    }
    if (resp.ready) {
      setStatus(`Report loaded for jurisdiction ${resp.jurisdictionId || '?'}. Ready to export.`);
      exportBtn.disabled = false;
    } else {
      setStatus('Waiting for snapshot report to load. Select a jurisdiction first.', 'working');
    }
  });
});

// Export button click
exportBtn.addEventListener('click', () => {
  exportBtn.disabled = true;
  chartList.innerHTML = '';
  setStatus('Capturing charts…', 'working', true);

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, { type: 'EXPORT_CHARTS' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        setStatus('Could not reach the page. Try refreshing.', 'error');
        exportBtn.disabled = false;
        return;
      }

      if (resp.error) {
        setStatus(`Error: ${resp.error}`, 'error');
        exportBtn.disabled = false;
        return;
      }

      // Show chart list
      if (resp.charts) {
        resp.charts.forEach(name => addChartItem(name));
      }
    });
  });
});

// Listen for progress messages from background/content
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CHART_CAPTURED') {
    const item = document.getElementById(`chart-item-${msg.name}`);
    if (item) item.querySelector('.dot').className = 'dot done';
    setStatus(`Captured ${msg.index + 1} / ${msg.total} charts…`, 'working', true);
  }

  if (msg.type === 'CHART_ERROR') {
    const item = document.getElementById(`chart-item-${msg.name}`);
    if (item) item.querySelector('.dot').className = 'dot error';
  }

  if (msg.type === 'EXPORT_COMPLETE') {
    spinner.classList.remove('visible');
    setStatus(`Downloaded ${msg.count} charts as ZIP ✓`, 'success');
    exportBtn.disabled = false;
  }

  if (msg.type === 'EXPORT_FAILED') {
    spinner.classList.remove('visible');
    setStatus(`Export failed: ${msg.error}`, 'error');
    exportBtn.disabled = false;
  }
});
