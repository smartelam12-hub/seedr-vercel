// Seedr 4GB Cloud Engine Application Logic

let activeTasks = [];
let currentMedia = null; // { streamUrl, title, downloadUrl, isVideo }
let currentSort = 'date'; // 'name' | 'size' | 'date'
let searchQuery = '';

// Initialize Lucide icons
function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Toast helper
function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-message');
  if (!toast || !toastMsg) return;
  toastMsg.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, duration);
}

// Format bytes
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Format Speed
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === 0) return '0 KB/s';
  return formatBytes(bytesPerSec) + '/s';
}

// Copy to Clipboard
function copyToClipboard(text, msg = 'Copied direct link to clipboard!') {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(msg);
    }).catch(() => {
      prompt('Copy link:', text);
    });
  } else {
    prompt('Copy link:', text);
  }
}

// Theme Toggle
const themeToggle = document.getElementById('theme-toggle');
themeToggle?.addEventListener('click', () => {
  const isDark = document.documentElement.classList.contains('dark');
  if (isDark) {
    document.documentElement.classList.remove('dark');
    localStorage.setItem('seedr-theme', 'light');
  } else {
    document.documentElement.classList.add('dark');
    localStorage.setItem('seedr-theme', 'dark');
  }
  refreshIcons();
});

// Paste button
const btnPaste = document.getElementById('btn-paste');
const magnetInput = document.getElementById('magnet-input');
const magnetHint = document.getElementById('magnet-hint');

// Live Input Validation & Feedback
function validateMagnetInput(raw) {
  if (!magnetHint) return;
  const val = (raw || '').trim().replace(/^["']|["']$/g, '');
  if (!val) {
    magnetHint.classList.add('hidden');
    return;
  }

  // Check if it's a direct cloud link (Seedr, TorrentCheap, HTTP/HTTPS)
  if (val.startsWith('http://') || val.startsWith('https://')) {
    magnetHint.classList.remove('hidden');
    if (val.includes('torrentcheap.com')) {
      magnetHint.className = 'text-xs px-3 py-2 rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 flex items-center gap-2';
      magnetHint.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 flex-shrink-0"></i> <span>Direct TorrentCheap Cloud Download Link detected. Ready to convert!</span>`;
    } else if (val.includes('seedr.cc/ff_get') || /\.(mkv|mp4|webm|avi|mov|zip|rar|7z|mp3|flac|iso|torrent)/i.test(val)) {
      magnetHint.className = 'text-xs px-3 py-2 rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 flex items-center gap-2';
      magnetHint.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 flex-shrink-0"></i> <span>Direct Seedr / Cloud Download Link detected. Ready to convert!</span>`;
    } else {
      magnetHint.className = 'text-xs px-3 py-2 rounded-xl bg-cyan-500/10 text-cyan-500 border border-cyan-500/20 flex items-center gap-2';
      magnetHint.innerHTML = `<i data-lucide="link" class="w-4 h-4 flex-shrink-0"></i> <span>Direct Cloud Download Link detected. Ready to convert!</span>`;
    }
    refreshIcons();
    return;
  }

  // Extract hash
  let hash = '';
  if (/^[0-9a-fA-F]{40}$/.test(val) || /^[2-7a-zA-Z]{32}$/.test(val)) {
    hash = val;
  } else if (val.startsWith('magnet:?')) {
    const match = val.match(/urn:btih:([a-zA-Z0-9]+)/i);
    if (match) hash = match[1];
  }

  magnetHint.classList.remove('hidden');

  if (!hash) {
    magnetHint.className = 'text-xs px-3 py-2 rounded-xl bg-red-500/10 text-red-500 border border-red-500/20 flex items-center gap-2';
    magnetHint.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4 flex-shrink-0"></i> <span>No BitTorrent infohash found. Link should start with <strong>magnet:?xt=urn:btih:...</strong></span>`;
  } else if (hash.length === 40 && /^[0-9a-fA-F]{40}$/.test(hash)) {
    magnetHint.className = 'text-xs px-3 py-2 rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 flex items-center gap-2';
    magnetHint.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 flex-shrink-0"></i> <span>Valid 40-character BitTorrent Hash (${hash.slice(0, 10)}...). Ready to convert!</span>`;
  } else if (hash.length === 32 && /^[2-7a-zA-Z]{32}$/.test(hash)) {
    magnetHint.className = 'text-xs px-3 py-2 rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 flex items-center gap-2';
    magnetHint.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 flex-shrink-0"></i> <span>Valid 32-character Base32 BitTorrent Hash. Ready to convert!</span>`;
  } else {
    const missing = 40 - hash.length;
    magnetHint.className = 'text-xs px-3 py-2 rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20 flex items-center gap-2';
    magnetHint.innerHTML = `<i data-lucide="alert-triangle" class="w-4 h-4 flex-shrink-0"></i> <span>Incomplete hash: <strong>${hash.length}/40 characters</strong>. ${missing > 0 ? `Missing ${missing} characters at the end.` : 'Invalid hash length.'}</span>`;
  }
  refreshIcons();
}

magnetInput?.addEventListener('input', () => {
  validateMagnetInput(magnetInput.value);
});

btnPaste?.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      magnetInput.value = text.trim();
      magnetInput.focus();
      validateMagnetInput(magnetInput.value);
      showToast('Pasted from clipboard!');
    }
  } catch (err) {
    magnetInput.focus();
  }
});

// Full-Window Drag and Drop for .torrent files (Seedr - Drop TO Add -)
const linkDropper = document.getElementById('link-dropper');
let dragCounter = 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  linkDropper?.classList.remove('hidden');
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    linkDropper?.classList.add('hidden');
  }
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  linkDropper?.classList.add('hidden');
  const files = e.dataTransfer?.files;
  if (files && files[0]) {
    handleTorrentFileUpload(files[0]);
  }
});

// Torrent File Picker Trigger
const btnUploadTorrent = document.getElementById('btn-upload-torrent');
const torrentFileInput = document.getElementById('torrent-file-input');

btnUploadTorrent?.addEventListener('click', () => {
  torrentFileInput?.click();
});

torrentFileInput?.addEventListener('change', () => {
  if (torrentFileInput.files && torrentFileInput.files[0]) {
    handleTorrentFileUpload(torrentFileInput.files[0]);
  }
});

async function handleTorrentFileUpload(file) {
  if (!file.name.toLowerCase().endsWith('.torrent')) {
    showToast('⚠️ Please upload a valid .torrent file');
    return;
  }

  showToast(`Uploading and converting ${file.name}...`);

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64 = reader.result.split(',')[1];
      const res = await fetch('/api/upload-torrent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ torrentBase64: base64, filename: file.name })
      });

      const data = await res.json();
      if (data.error) {
        if (data.error.includes('exceeds 4 GB')) {
          showLimitModal(data.error);
        } else {
          showToast('❌ ' + data.error, 5000);
        }
      } else {
        showToast('🚀 Torrent file added! Direct links ready.');
        fetchTasks();
      }
    } catch (err) {
      showToast('❌ Upload error: ' + err.message);
    } finally {
      if (torrentFileInput) torrentFileInput.value = '';
      refreshIcons();
    }
  };
  reader.readAsDataURL(file);
}

// Convert Form Submit
const convertForm = document.getElementById('convert-form');
const btnConvert = document.getElementById('btn-convert');
const convertBtnText = document.getElementById('convert-btn-text');

convertForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const magnet = magnetInput.value.trim();
  if (!magnet) return;

  btnConvert.disabled = true;
  convertBtnText.textContent = 'Connecting...';

  try {
    const res = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet })
    });

    const data = await res.json();
    if (data.error) {
      if (data.error.includes('4 GB') || data.error.includes('not_enough_space')) {
        showLimitModal(data.error);
      } else {
        showToast('❌ ' + data.error, 6000);
      }
      if (magnetHint) {
        magnetHint.className = 'text-xs px-3 py-2 rounded-xl bg-red-500/10 text-red-500 border border-red-500/20 flex items-center gap-2';
        magnetHint.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4 flex-shrink-0"></i> <span>${data.error}</span>`;
        magnetHint.classList.remove('hidden');
      }
    } else {
      showToast(data.cached ? '⚡ Torrent already converted! Ready instantly.' : '🚀 Added to Seedr cloud! Generating direct links...');
      magnetInput.value = '';
      if (magnetHint) magnetHint.classList.add('hidden');
      fetchTasks();
    }
  } catch (err) {
    showToast('❌ Connection error: ' + err.message);
  } finally {
    btnConvert.disabled = false;
    convertBtnText.textContent = 'Add to Seedr (Free)';
    refreshIcons();
  }
});

function showLimitModal(msg) {
  const modal = document.getElementById('limit-modal');
  const msgEl = document.getElementById('limit-modal-message');
  if (msgEl) msgEl.textContent = msg || 'This file exceeds the 4.00 GB free storage limit.';
  modal?.classList.remove('hidden');
}

// Fetch Tasks
async function fetchTasks() {
  try {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    activeTasks = data.tasks || [];
    renderTasks();
    updateStats();
    updateProgressDisplay();
  } catch (err) {}
}

// Update Active Converting Overlay Display (#link-progress-display)
function updateProgressDisplay() {
  const display = document.getElementById('link-progress-display');
  const titleEl = document.getElementById('link-progress-title');
  const sizeEl = document.getElementById('link-progress-size');
  const statusEl = document.getElementById('link-progress-status');
  const speedEl = document.getElementById('link-progress-speed');
  const meterEl = document.getElementById('link-progress-meter');

  const activeTask = activeTasks.find(t => t.status === 'fetching_metadata' || t.status === 'downloading');

  if (activeTask && display) {
    display.classList.remove('hidden');
    if (titleEl) titleEl.textContent = activeTask.name || 'Transferring to Seedr Cloud...';
    if (sizeEl) sizeEl.textContent = activeTask.totalSize ? formatBytes(activeTask.totalSize) : 'Resolving Size...';
    if (statusEl) {
      statusEl.textContent = activeTask.isSeedr 
        ? `Seedr Cloud: ${activeTask.progress || 0}% completed` 
        : `Connecting to DHT peers (${activeTask.peers || 0} peers connected)...`;
    }
    if (speedEl) speedEl.textContent = activeTask.speed ? formatSpeed(activeTask.speed) : 'Instant Link';
    if (meterEl) meterEl.style.width = Math.max(15, activeTask.progress || 25) + '%';
  } else if (display) {
    display.classList.add('hidden');
  }
}

// Update Storage Usage Meter (Seedr #top-storage-div: 4.00 GB Free)
async function updateStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();

    const topSpan = document.getElementById('top-storage-span');
    const topPercent = document.getElementById('top-storage-percent');
    const topMeter = document.getElementById('top-storage-meter');
    const mobileSpan = document.getElementById('mobile-storage-span');
    const mobilePercent = document.getElementById('mobile-storage-percent');

    const formatted = `${stats.spaceUsedFormatted || '0 B'} / 4.00 GB`;
    const percent = stats.spacePercent || 0;

    if (topSpan) topSpan.textContent = formatted;
    if (topPercent) topPercent.textContent = `${percent}%`;
    if (mobileSpan) mobileSpan.textContent = formatted;
    if (mobilePercent) mobilePercent.textContent = `${percent}%`;

    if (topMeter) {
      topMeter.style.width = `${percent}%`;
      if (percent >= 90) {
        topMeter.className = 'h-full bg-red-500 transition-all duration-500 rounded-full';
      } else if (percent >= 70) {
        topMeter.className = 'h-full bg-amber-500 transition-all duration-500 rounded-full';
      } else {
        topMeter.className = 'h-full bg-emerald-500 transition-all duration-500 rounded-full';
      }
    }
  } catch (e) {}
}

// Delete Task
async function deleteTask(taskId) {
  if (!confirm('Are you sure you want to remove this file from Seedr?')) return;
  try {
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    showToast('File removed');
    fetchTasks();
  } catch (err) {
    showToast('Error removing file');
  }
}

// Search and Sorting handlers
document.getElementById('files-search-input')?.addEventListener('input', (e) => {
  searchQuery = (e.target.value || '').toLowerCase().trim();
  renderTasks();
});

document.getElementById('sort-name')?.addEventListener('click', () => {
  setSort('name');
});

document.getElementById('sort-size')?.addEventListener('click', () => {
  setSort('size');
});

document.getElementById('sort-date')?.addEventListener('click', () => {
  setSort('date');
});

function setSort(type) {
  currentSort = type;
  ['sort-name', 'sort-size', 'sort-date'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      if (id === `sort-${type}`) {
        btn.className = 'px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-semibold transition-colors';
      } else {
        btn.className = 'px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 font-semibold text-gray-700 dark:text-gray-200 transition-colors';
      }
    }
  });
  renderTasks();
}

// Render Tasks in Seedr Table Format (#file-browser)
function renderTasks() {
  const container = document.getElementById('tasks-container');
  const emptyFolder = document.getElementById('folder-empty');
  if (!container) return;

  // Filter
  let filtered = activeTasks;
  if (searchQuery) {
    filtered = filtered.filter(t => (t.name || '').toLowerCase().includes(searchQuery));
  }

  // Sort
  filtered.sort((a, b) => {
    if (currentSort === 'name') return (a.name || '').localeCompare(b.name || '');
    if (currentSort === 'size') return (b.totalSize || 0) - (a.totalSize || 0);
    return new Date(b.addedAt || 0) - new Date(a.addedAt || 0);
  });

  if (filtered.length === 0) {
    container.innerHTML = '';
    emptyFolder?.classList.remove('hidden');
    refreshIcons();
    return;
  }

  emptyFolder?.classList.add('hidden');
  const origin = window.location.origin;

  container.innerHTML = filtered.map((task) => {
    const hasRealFiles = task.files && task.files.length > 0 && !task.files[0].name.startsWith('[METADATA]');
    const isReady = (task.status === 'converted' || task.status === 'completed') && hasRealFiles;
    const isFetching = task.status === 'fetching_metadata' || !hasRealFiles;

    const primaryFile = (task.files && task.files[0]) || {};
    const directUrl = primaryFile.directUrl || (task.isDirectCloudUrl && task.directUrl ? task.directUrl : `${origin}/download/${task.id}/0`);
    const streamUrl = primaryFile.directUrl || (task.isDirectCloudUrl && task.directUrl ? task.directUrl : `${origin}/stream/${task.id}/0`);
    const isMedia = primaryFile.isMedia || primaryFile.isVideo || primaryFile.isAudio;
    const isVideo = primaryFile.isVideo || /\.(mkv|mp4|webm|avi|mov)$/i.test(task.name);

    // Date formatting
    const addedDate = task.addedAt ? new Date(task.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Just now';

    // File type icon
    let icon = 'file';
    if (isVideo) icon = 'film';
    else if (primaryFile.isAudio || /\.(mp3|flac|wav|m4a)$/i.test(task.name)) icon = 'music';
    else if (/\.(zip|rar|7z|tar|gz)$/i.test(task.name)) icon = 'archive';

    return `
      <div class="hover:bg-emerald-50/40 dark:hover:bg-gray-800/60 transition-colors p-3.5 sm:px-4">
        
        <!-- Main Row -->
        <div class="grid grid-cols-12 items-center gap-2">
          
          <!-- Name & Icon -->
          <div class="col-span-7 sm:col-span-6 flex items-center gap-3 overflow-hidden">
            <div class="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center flex-shrink-0">
              <i data-lucide="${icon}" class="w-4 h-4"></i>
            </div>
            <div class="overflow-hidden">
              <div 
                class="font-bold text-xs sm:text-sm text-gray-900 dark:text-gray-100 truncate cursor-pointer hover:text-emerald-500" 
                title="${task.name}"
                onclick="${isMedia ? `playMedia('${streamUrl}', '${encodeURIComponent(task.name)}', '${directUrl}', ${isVideo})` : `window.open('${directUrl}')`}"
              >
                ${task.name}
              </div>
              <div class="flex items-center gap-2 text-[10px] text-gray-400 mt-0.5">
                ${task.status === 'downloading' ? `<span class="text-emerald-500 font-semibold flex items-center gap-0.5"><i data-lucide="loader" class="w-3 h-3 animate-spin"></i> Downloading ${task.progress || 0}% (${formatSpeed(task.speed || 0)})</span>` : (isReady ? '<span class="text-emerald-500 font-semibold flex items-center gap-0.5"><i data-lucide="check" class="w-3 h-3"></i> Direct Link Ready</span>' : '<span class="text-amber-500 font-semibold flex items-center gap-0.5 animate-pulse"><i data-lucide="loader" class="w-3 h-3 animate-spin"></i> Converting...</span>')}
                <span>•</span>
                <span class="font-mono">${task.infoHash ? task.infoHash.slice(0, 8) : 'Direct'}</span>
                ${task.peers ? `<span>•</span><span>${task.peers} peers</span>` : ''}
              </div>
            </div>
          </div>

          <!-- Size -->
          <div class="col-span-2 sm:col-span-2 text-right sm:text-left text-xs font-semibold text-gray-700 dark:text-gray-300">
            ${task.status === 'downloading' && task.downloadedSize > 0 && task.totalSize > 0 ? `${formatBytes(task.downloadedSize)} / ${formatBytes(task.totalSize)}` : formatBytes(task.totalSize || task.downloadedSize || (primaryFile && primaryFile.size) || 0)}
          </div>

          <!-- Date -->
          <div class="hidden sm:block col-span-2 text-xs text-gray-400">
            ${addedDate}
          </div>

          <!-- Actions -->
          <div class="col-span-3 sm:col-span-2 flex items-center justify-end gap-1.5 flex-shrink-0">
            ${isMedia ? `
              <button 
                onclick="playMedia('${streamUrl}', '${encodeURIComponent(task.name)}', '${directUrl}', ${isVideo})" 
                class="p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-600 hover:text-white dark:text-emerald-400 dark:hover:text-white transition-all" 
                title="Stream Online"
              >
                <i data-lucide="play" class="w-4 h-4"></i>
              </button>
            ` : ''}

            <a 
              href="${directUrl}" 
              download 
              class="p-1.5 rounded-lg bg-gray-100 hover:bg-emerald-600 text-gray-700 dark:text-gray-300 hover:text-white dark:bg-gray-800 transition-all" 
              title="Direct Download"
            >
              <i data-lucide="download" class="w-4 h-4"></i>
            </a>

            <button 
              onclick="copyToClipboard('${directUrl}')" 
              class="p-1.5 rounded-lg bg-gray-100 hover:bg-emerald-600 text-gray-700 dark:text-gray-300 hover:text-white dark:bg-gray-800 transition-all" 
              title="Copy Direct Link"
            >
              <i data-lucide="copy" class="w-4 h-4"></i>
            </button>

            <button 
              onclick="deleteTask('${task.id}')" 
              class="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-500/10 transition-colors" 
              title="Remove File"
            >
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>

        </div>

        <!-- Direct Link Input Box for instant copying -->
        ${isReady ? `
          <div class="mt-2.5 pt-2 border-t border-gray-100 dark:border-gray-800/60 flex items-center gap-2">
            <span class="text-[10px] font-bold text-gray-400 uppercase tracking-wider flex-shrink-0 flex items-center gap-1">
              <i data-lucide="link" class="w-3 h-3 text-emerald-500"></i> Direct Link:
            </span>
            <input 
              type="text" 
              readonly 
              value="${directUrl}" 
              class="flex-1 bg-gray-50 dark:bg-gray-900 px-2.5 py-1 rounded-md text-[11px] font-mono text-emerald-600 dark:text-emerald-400 border border-gray-200 dark:border-gray-800 select-all outline-none"
            />
            <button 
              onclick="copyToClipboard('${directUrl}')" 
              class="px-2 py-1 rounded-md bg-emerald-500/10 hover:bg-emerald-500 text-emerald-600 hover:text-white dark:text-emerald-400 dark:hover:text-white text-[11px] font-semibold transition-all flex items-center gap-1 flex-shrink-0"
            >
              <i data-lucide="copy" class="w-3 h-3"></i> Copy
            </button>
          </div>
        ` : ''}

      </div>
    `;
  }).join('');

  refreshIcons();
}

// Media Player Logic (#video-modal)
const playerModal = document.getElementById('player-modal');
const playerTitle = document.getElementById('player-title');
const mainVideo = document.getElementById('main-video');
const mainAudio = document.getElementById('main-audio');
const playerCloseBtn = document.getElementById('player-close-btn');
const playerMinimizeBtn = document.getElementById('player-minimize-btn');
const playerCopyLinkBtn = document.getElementById('player-copy-link-btn');
const playerDownloadBtn = document.getElementById('player-download-btn');

// Mini Player
const miniPlayer = document.getElementById('mini-player');
const miniPlayerTitle = document.getElementById('mini-player-title');
const miniVideo = document.getElementById('mini-video');
const miniPlayerMaximize = document.getElementById('mini-player-maximize');
const miniPlayerClose = document.getElementById('mini-player-close');

function playMedia(streamUrl, rawTitle, downloadUrl, isVideo = true) {
  const title = decodeURIComponent(rawTitle);
  currentMedia = { streamUrl, title, downloadUrl, isVideo };

  playerTitle.textContent = title;
  playerDownloadBtn.href = downloadUrl;

  playerCopyLinkBtn.onclick = () => {
    copyToClipboard(streamUrl, 'Copied streaming link!');
  };

  if (isVideo) {
    mainAudio.classList.add('hidden');
    mainAudio.pause();
    mainVideo.classList.remove('hidden');
    mainVideo.src = streamUrl;
    mainVideo.play().catch(() => {});
  } else {
    mainVideo.classList.add('hidden');
    mainVideo.pause();
    mainAudio.classList.remove('hidden');
    mainAudio.src = streamUrl;
    mainAudio.play().catch(() => {});
  }

  // Hide mini player if open
  miniPlayer.classList.add('hidden');
  miniVideo.pause();

  playerModal.classList.remove('hidden');
  refreshIcons();
}

playerCloseBtn?.addEventListener('click', () => {
  playerModal.classList.add('hidden');
  mainVideo.pause();
  mainAudio.pause();
});

playerMinimizeBtn?.addEventListener('click', () => {
  if (!currentMedia) return;
  const currentTime = mainVideo.currentTime;
  const isPlaying = !mainVideo.paused;

  playerModal.classList.add('hidden');
  mainVideo.pause();

  miniPlayerTitle.textContent = currentMedia.title;
  miniVideo.src = currentMedia.streamUrl;
  miniVideo.currentTime = currentTime;
  miniPlayer.classList.remove('hidden');

  if (isPlaying) miniVideo.play().catch(() => {});
  refreshIcons();
});

miniPlayerMaximize?.addEventListener('click', () => {
  if (!currentMedia) return;
  const currentTime = miniVideo.currentTime;
  const isPlaying = !miniVideo.paused;

  miniPlayer.classList.add('hidden');
  miniVideo.pause();

  mainVideo.currentTime = currentTime;
  playerModal.classList.remove('hidden');
  if (isPlaying) mainVideo.play().catch(() => {});
});

miniPlayerClose?.addEventListener('click', () => {
  miniPlayer.classList.add('hidden');
  miniVideo.pause();
});

// Seedr Account Modal
const seedrModal = document.getElementById('seedr-modal');
const btnOpenSeedrModal = document.getElementById('btn-open-seedr-modal');
const closeSeedrModal = document.getElementById('close-seedr-modal');
const seedrAccountForm = document.getElementById('seedr-account-form');
const seedrEmailInput = document.getElementById('seedr-email');
const seedrPasswordInput = document.getElementById('seedr-password');
const seedrModalMsg = document.getElementById('seedr-modal-msg');
const btnSaveSeedr = document.getElementById('btn-save-seedr');
const saveSeedrBtnText = document.getElementById('save-seedr-btn-text');
const seedrBtnLabel = document.getElementById('seedr-btn-label');

function openSeedrModal() {
  seedrModal?.classList.remove('hidden');
  seedrModalMsg?.classList.add('hidden');
  refreshIcons();
}

function hideSeedrModal() {
  seedrModal?.classList.add('hidden');
}

btnOpenSeedrModal?.addEventListener('click', openSeedrModal);
closeSeedrModal?.addEventListener('click', hideSeedrModal);
seedrModal?.addEventListener('click', (e) => {
  if (e.target === seedrModal) hideSeedrModal();
});

async function checkSeedrStatus() {
  try {
    const res = await fetch('/api/seedr/account');
    const data = await res.json();
    if (data.connected && data.email) {
      if (seedrBtnLabel) seedrBtnLabel.textContent = `Seedr: ${data.email} ✅`;
      if (seedrEmailInput) seedrEmailInput.value = data.email;
    } else {
      if (seedrBtnLabel) seedrBtnLabel.textContent = 'Seedr Account';
    }
  } catch (err) {}
}

seedrAccountForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = seedrEmailInput?.value.trim();
  const password = seedrPasswordInput?.value;
  if (!email || !password) return;

  btnSaveSeedr.disabled = true;
  saveSeedrBtnText.textContent = 'Verifying Account...';
  seedrModalMsg.classList.add('hidden');

  try {
    const res = await fetch('/api/seedr/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.error) {
      seedrModalMsg.className = 'text-xs p-2.5 rounded-lg bg-red-500/10 text-red-500 border border-red-500/20 flex items-center gap-2';
      seedrModalMsg.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4 flex-shrink-0"></i> <span>${data.error}</span>`;
      seedrModalMsg.classList.remove('hidden');
    } else {
      seedrModalMsg.className = 'text-xs p-2.5 rounded-lg bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 flex items-center gap-2';
      seedrModalMsg.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 flex-shrink-0"></i> <span>Connected to Seedr (${data.email})!</span>`;
      seedrModalMsg.classList.remove('hidden');
      showToast('⚡ Seedr account connected!');
      checkSeedrStatus();
      setTimeout(hideSeedrModal, 1200);
    }
  } catch (err) {
    seedrModalMsg.className = 'text-xs p-2.5 rounded-lg bg-red-500/10 text-red-500 border border-red-500/20 flex items-center gap-2';
    seedrModalMsg.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4 flex-shrink-0"></i> <span>Connection failed: ${err.message}</span>`;
    seedrModalMsg.classList.remove('hidden');
  } finally {
    btnSaveSeedr.disabled = false;
    saveSeedrBtnText.textContent = 'Connect & Sync Seedr';
    refreshIcons();
  }
});

// Refresh button
document.getElementById('btn-refresh')?.addEventListener('click', () => {
  fetchTasks();
  showToast('Refreshed file list');
});

// Initial startup
checkSeedrStatus();
fetchTasks();
setInterval(fetchTasks, 1500);
refreshIcons();
