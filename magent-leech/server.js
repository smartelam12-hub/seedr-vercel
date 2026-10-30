const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const ARIA2_PORT = process.env.ARIA2_PORT || 6800;
const ARIA2_SECRET = process.env.ARIA2_SECRET || ('tc_local_secret_' + crypto.randomBytes(8).toString('hex'));
const WORKSPACE_DIR = __dirname;
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(WORKSPACE_DIR, 'downloads');
const DATA_DIR = process.env.DATA_DIR || path.join(WORKSPACE_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(WORKSPACE_DIR, 'public');

// Cross-platform Aria2 binary location (Windows local bin, or system 'aria2c' on Linux/Docker)
const isWindows = process.platform === 'win32';
const ARIA2_BIN = isWindows 
  ? (fs.existsSync(path.join(WORKSPACE_DIR, 'bin', 'aria2c.exe')) ? path.join(WORKSPACE_DIR, 'bin', 'aria2c.exe') : 'aria2c')
  : (process.env.ARIA2_BIN || 'aria2c');

// Ensure directories exist
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Top public high-speed trackers for fast peer discovery & metadata resolving
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.tracker.vraphim.com:6969/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://movies.zsw.ca:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'https://tracker.tamersunion.org:443/announce'
];

// In-memory state and persistent DB
let db = {
  tasks: [], // { id, magnet, infoHash, name, gid, activeGid, status, totalSize, downloadedSize, speed, peers, addedAt, completedAt, files: [] }
  settings: {
    maxDownloadSpeed: '0',
    maxUploadSpeed: '1M',
    seedrEmail: '',
    seedrPassword: '',
    engineMode: 'seedr' // 'seedr' | 'direct'
  }
};

// Seedr REST API Caller
function seedrRequest(endpoint, method = 'GET', postData = null, email = null, password = null) {
  const userEmail = email || db.settings.seedrEmail;
  const userPass = password || db.settings.seedrPassword;
  if (!userEmail || !userPass) {
    return Promise.reject(new Error('Seedr account not connected. Please enter your free Seedr email and password.'));
  }

  const authHeader = 'Basic ' + Buffer.from(`${userEmail}:${userPass}`).toString('base64');
  return new Promise((resolve, reject) => {
    const urlObj = new URL('https://www.seedr.cc' + endpoint);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Authorization': authHeader,
        'User-Agent': 'Mozilla/5.0'
      }
    };

    if (postData) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      // If HTTP redirect (301, 302, 303, 307, 308) e.g. from /rest/file/{id} -> direct CDN link
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve({ result: true, url: res.headers.location, redirectUrl: res.headers.location });
      }

      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          resolve({ raw: body, statusCode: res.statusCode });
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// Poll Seedr for completed transfers & fetch authentic ff_get direct links
async function pollSeedrTransfer(task) {
  try {
    const folderRes = await seedrRequest('/rest/folder');
    if (!folderRes) return;

    // Check active transfers currently downloading in Seedr cloud
    if (folderRes.torrents && folderRes.torrents.length > 0) {
      const active = folderRes.torrents.find(t => 
        (task.transferId && t.id == task.transferId) ||
        (task.name && t.name && (t.name.toLowerCase().includes(task.name.toLowerCase()) || task.name.toLowerCase().includes(t.name.toLowerCase())))
      );
      if (active) {
        task.status = 'downloading';
        task.progress = Math.round(parseFloat(active.progress || '0'));
        task.name = active.name || task.name;
        task.totalSize = active.size || task.totalSize;
        task.speed = active.speed || 0;
        saveDB();
        return;
      }
    }

    // Check folders in Seedr account
    if (folderRes.folders && folderRes.folders.length > 0) {
      let targetFolder = null;
      if (folderRes.folders.length === 1) {
        targetFolder = folderRes.folders[0];
      } else {
        targetFolder = folderRes.folders.find(f => 
          (task.name && f.name && (f.name.toLowerCase().includes(task.name.toLowerCase()) || task.name.toLowerCase().includes(f.name.toLowerCase())))
        ) || folderRes.folders[0];
      }

      if (targetFolder) {
        // Query files inside folder
        const contents = await seedrRequest(`/rest/folder/${targetFolder.id}`);
        if (contents && contents.files && contents.files.length > 0) {
          const files = [];
          for (const f of contents.files) {
            let directSeedrUrl = '';
            try {
              const linkRes = await seedrRequest(`/rest/file/${f.id}`);
              directSeedrUrl = linkRes.url || linkRes.redirectUrl || '';
            } catch (e) {}

            const ext = path.extname(f.name).toLowerCase();
            const isVideo = ['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext);
            const isAudio = ['.mp3', '.m4a', '.flac', '.wav'].includes(ext);

            files.push({
              index: files.length,
              name: f.name,
              seedrFileId: f.id,
              path: directSeedrUrl,
              directUrl: directSeedrUrl,
              size: f.size,
              completed: f.size,
              selected: true,
              isVideo,
              isAudio,
              isMedia: isVideo || isAudio
            });
          }

          if (files.length > 0 && files[0].directUrl) {
            task.status = 'converted';
            task.isSeedr = true;
            task.isDirectCloudUrl = true;
            task.directUrl = files[0].directUrl;
            task.name = targetFolder.name || files[0].name;
            task.totalSize = targetFolder.size || files[0].size;
            task.progress = 100;
            task.files = files;
            saveDB();
            return;
          }
        }
      }
    }

    // Check root files in Seedr
    if (folderRes.files && folderRes.files.length > 0) {
      let targetFile = null;
      if (folderRes.files.length === 1) {
        targetFile = folderRes.files[0];
      } else {
        targetFile = folderRes.files.find(f => 
          (task.name && f.name && (f.name.toLowerCase().includes(task.name.toLowerCase()) || task.name.toLowerCase().includes(f.name.toLowerCase())))
        ) || folderRes.files[0];
      }

      if (targetFile) {
        let directSeedrUrl = '';
        try {
          const linkRes = await seedrRequest(`/rest/file/${targetFile.id}`);
          directSeedrUrl = linkRes.url || linkRes.redirectUrl || '';
        } catch (e) {}

        if (directSeedrUrl) {
          const ext = path.extname(targetFile.name).toLowerCase();
          const isVideo = ['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext);
          const isAudio = ['.mp3', '.m4a', '.flac', '.wav'].includes(ext);

          task.status = 'converted';
          task.isSeedr = true;
          task.isDirectCloudUrl = true;
          task.directUrl = directSeedrUrl;
          task.name = targetFile.name;
          task.totalSize = targetFile.size;
          task.progress = 100;
          task.files = [{
            index: 0,
            name: targetFile.name,
            seedrFileId: targetFile.id,
            path: directSeedrUrl,
            directUrl: directSeedrUrl,
            size: targetFile.size,
            completed: targetFile.size,
            selected: true,
            isVideo,
            isAudio,
            isMedia: isVideo || isAudio
          }];
          saveDB();
          return;
        }
      }
    }
  } catch (err) {
    // console.error('Seedr poll error:', err.message);
  }
}

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = Object.assign(db, data);
    }
  } catch (e) {
    console.error('Error loading db:', e);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving db:', e);
  }
}

loadDB();

// MIME type dictionary
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.iso': 'application/x-iso9660-image'
};

// Spawn aria2c RPC daemon
let aria2Process = null;

let isShuttingDown = false;

function cleanExit() {
  isShuttingDown = true;
  if (aria2Process) {
    try { aria2Process.kill(); } catch (e) {}
  }
  process.exit(0);
}

process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
process.on('exit', () => {
  if (aria2Process) {
    try { aria2Process.kill(); } catch (e) {}
  }
});

function startAria2() {
  if (isShuttingDown) return;
  if ((ARIA2_BIN.includes('/') || ARIA2_BIN.includes('\\')) && !fs.existsSync(ARIA2_BIN)) {
    console.error('Aria2 binary not found at:', ARIA2_BIN);
    return;
  }

  const args = [
    '--enable-rpc',
    `--rpc-listen-port=${ARIA2_PORT}`,
    `--rpc-secret=${ARIA2_SECRET}`,
    '--rpc-listen-all=false',
    '--rpc-allow-origin-all=true',
    `--dir=${DOWNLOADS_DIR}`,
    '--bt-enable-lpd=true',
    '--enable-dht=true',
    '--enable-peer-exchange=true',
    '--bt-max-peers=120',
    '--bt-request-peer-speed-limit=10M',
    '--seed-time=0',
    '--max-connection-per-server=16',
    '--split=16',
    '--min-split-size=1M',
    '--summary-interval=2',
    '--follow-torrent=mem',
    '--pause-metadata=false',
    '--bt-save-metadata=true',
    '--listen-port=6881-6999',
    '--dht-listen-port=6881-6999',
    '--file-allocation=none',
    '--check-integrity=false'
  ];

  console.log('Starting aria2c daemon on port', ARIA2_PORT);
  aria2Process = spawn(ARIA2_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  aria2Process.stdout.on('data', (d) => {
    // console.log('[aria2]', d.toString().trim());
  });

  aria2Process.stderr.on('data', (d) => {
    console.error('[aria2 err]', d.toString().trim());
  });

  aria2Process.on('exit', (code) => {
    if (isShuttingDown) return;
    console.log('Aria2 exited with code', code, '- restarting in 3s...');
    setTimeout(startAria2, 3000);
  });
}

startAria2();

// Aria2 JSON-RPC caller
function aria2Rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: `aria2.${method}`,
      params: [`token:${ARIA2_SECRET}`, ...params]
    });

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: ARIA2_PORT,
        path: '/jsonrpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) return reject(new Error(parsed.error.message || 'RPC Error'));
            resolve(parsed.result);
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Inspect remote direct URL for filename, content-type and size
function inspectDirectUrl(targetUrl) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        timeout: 4000
      };

      const req = lib.request(options, (res) => {
        let disposition = res.headers['content-disposition'] || '';
        let contentType = res.headers['content-type'] || '';
        let contentLength = parseInt(res.headers['content-length'] || '0', 10);
        let fileName = '';

        if (disposition) {
          const matchUtf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
          const matchNormal = disposition.match(/filename="?([^";]+)"?/i);
          if (matchUtf) {
            try { fileName = decodeURIComponent(matchUtf[1]); } catch(e) { fileName = matchUtf[1]; }
          } else if (matchNormal) {
            fileName = matchNormal[1];
          }
        }

        resolve({
          statusCode: res.statusCode,
          fileName,
          contentType,
          contentLength,
          location: res.headers.location
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (e) {
      resolve(null);
    }
  });
}

// Parse Magnet URI with robust cleaning & validation
function parseMagnetURI(rawInput) {
  if (!rawInput) return { error: 'Please enter a magnet link or torrent hash' };
  let clean = rawInput.trim().replace(/^["']|["']$/g, '');

  // Support direct cloud download URLs (TorrentCheap, Seedr, HTTP/HTTPS direct media links)
  if (/^https?:\/\//i.test(clean) && !/^https?:\/\/.*\.torrent(\?.*)?$/i.test(clean)) {
    let fileName = 'Direct Cloud Download';
    try {
      const urlObj = new URL(clean);
      const parts = urlObj.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        const lastPart = decodeURIComponent(parts[parts.length - 1]);
        if (/\.[a-zA-Z0-9]{2,5}$/.test(lastPart)) {
          fileName = lastPart;
        } else if (/torrentcheap\.com/i.test(urlObj.hostname)) {
          fileName = 'TorrentCheap File (' + lastPart.slice(0, 8) + ')';
        } else {
          fileName = lastPart;
        }
      }
    } catch (e) {}

    const infoHash = crypto.createHash('sha1').update(clean).digest('hex');
    return {
      valid: true,
      isDirectCloudUrl: true,
      directUrl: clean,
      infoHash,
      name: fileName,
      enhancedMagnet: clean,
      rawMagnet: clean
    };
  }

  // Support direct http/https .torrent links
  if (/^https?:\/\/.*\.torrent(\?.*)?$/i.test(clean)) {
    const infoHash = crypto.createHash('sha1').update(clean).digest('hex');
    return {
      valid: true,
      infoHash,
      name: path.basename(clean.split('?')[0]) || 'Torrent File',
      enhancedMagnet: clean,
      rawMagnet: clean
    };
  }

  // If user pasted just the infohash (40 hex or 32 base32)
  if (/^[0-9a-fA-F]{40}$/.test(clean) || /^[2-7a-zA-Z]{32}$/.test(clean)) {
    clean = 'magnet:?xt=urn:btih:' + clean;
  }

  // Extract hash using universal regex
  const hashMatch = clean.match(/(?:urn:btih:|btih=)([a-zA-Z0-9]+)/i);
  if (!hashMatch) {
    return { error: 'Could not find a BitTorrent infohash. Please ensure your link begins with "magnet:?xt=urn:btih:" or upload a .torrent file.' };
  }

  const infoHash = hashMatch[1].toLowerCase();

  // Validate infohash length
  const isHex = /^[0-9a-fA-F]{40}$/.test(infoHash);
  const isBase32 = /^[2-7a-zA-Z]{32}$/.test(infoHash);

  if (!isHex && !isBase32 && infoHash.length !== 64) {
    return {
      error: `Incomplete link (${infoHash.length}/40 characters). BitTorrent hashes require 40 characters. When copying magnet links from web pages, please right-click the button and select "Copy link address" (or upload the .torrent file below).`
    };
  }

  // Extract name if present
  let dn = '';
  const dnMatch = clean.match(/[?&]dn=([^&]+)/i);
  if (dnMatch) {
    try { dn = decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')); } catch (e) { dn = dnMatch[1]; }
  }

  // Extract trackers if present
  const trMatches = [...clean.matchAll(/[?&]tr=([^&]+)/gi)];
  const customTrackers = trMatches.map(m => {
    try { return decodeURIComponent(m[1]); } catch(e) { return m[1]; }
  });

  const allTrackers = Array.from(new Set([...customTrackers, ...DEFAULT_TRACKERS]));
  const enhancedMagnet = `magnet:?xt=urn:btih:${infoHash}${dn ? '&dn=' + encodeURIComponent(dn) : ''}${allTrackers.map((t) => '&tr=' + encodeURIComponent(t)).join('')}`;

  return {
    valid: true,
    infoHash,
    name: dn || 'Torrent (' + infoHash.slice(0, 8) + ')',
    trackers: allTrackers,
    enhancedMagnet,
    rawMagnet: clean
  };
}

// Check existing downloaded files in folder
function scanDownloadedFiles(taskDir) {
  if (!fs.existsSync(taskDir)) return [];
  const results = [];

  function walk(currentDir, relDir = '') {
    const items = fs.readdirSync(currentDir);
    for (const item of items) {
      if (item.endsWith('.aria2')) continue;
      const fullPath = path.join(currentDir, item);
      const relPath = path.join(relDir, item).replace(/\\/g, '/');
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        const ext = path.extname(item).toLowerCase();
        const isMedia = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.m4a', '.flac', '.wav'].includes(ext);
        const isVideo = ['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext);
        const isAudio = ['.mp3', '.m4a', '.flac', '.wav'].includes(ext);
        results.push({
          name: item,
          relPath,
          fullPath,
          size: stat.size,
          ext,
          isVideo,
          isAudio,
          isMedia
        });
      }
    }
  }

  try {
    walk(taskDir);
  } catch (e) {
    console.error('Walk error:', e);
  }
  return results;
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

// Format ETA
function formatEta(seconds) {
  if (!seconds || seconds === Infinity || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// Background sync loop: updates task status from Aria2c or Seedr without auto-downloading payload
async function syncTasksWithAria2() {
  for (const task of db.tasks) {
    if (task.status === 'failed') continue;

    // Handle Seedr cloud conversion tasks
    if (task.isSeedr && task.status !== 'converted') {
      await pollSeedrTransfer(task);
      continue;
    }

    const gidToCheck = task.activeGid || task.gid;
    if (!gidToCheck) continue;

    try {
      const status = await aria2Rpc('tellStatus', [gidToCheck]);
      if (!status) continue;

      // Handle child GID when metadata resolution finishes (followedBy)
      if (status.followedBy && status.followedBy.length > 0) {
        task.activeGid = status.followedBy[0];
        console.log(`Task ${task.id} metadata resolved! Content GID: ${task.activeGid}`);
        try {
          const contentStatus = await aria2Rpc('tellStatus', [task.activeGid]);
          if (contentStatus && contentStatus.files) {
            task.totalSize = parseInt(contentStatus.totalLength || '0', 10);
            if (contentStatus.bittorrent && contentStatus.bittorrent.info && contentStatus.bittorrent.info.name) {
              task.name = contentStatus.bittorrent.info.name;
            }
            task.files = contentStatus.files.map((f, idx) => {
              const filePath = f.path;
              const fileName = path.basename(filePath);
              const ext = path.extname(fileName).toLowerCase();
              const isVideo = ['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext);
              const isAudio = ['.mp3', '.m4a', '.flac', '.wav'].includes(ext);
              return {
                index: idx,
                name: fileName,
                path: filePath,
                size: parseInt(f.length || '0', 10),
                completed: parseInt(f.completedLength || '0', 10),
                selected: true,
                isVideo,
                isAudio,
                isMedia: isVideo || isAudio
              };
            });
            task.downloadedSize = parseInt(contentStatus.completedLength || '0', 10);
            task.speed = parseInt(contentStatus.downloadSpeed || '0', 10);
            task.peers = parseInt(contentStatus.connections || '0', 10);
            task.progress = task.totalSize > 0 ? Math.round((task.downloadedSize / task.totalSize) * 100) : 0;
            task.status = task.downloadedSize >= task.totalSize && task.totalSize > 0 ? 'completed' : 'downloading';
          }
        } catch (e) {}
        continue;
      }

      // If still in metadata phase, keep peers and status updated
      const isMetadataFile = status.files && status.files.some(f => f.path && f.path.startsWith('[METADATA]'));
      if (isMetadataFile) {
        task.status = 'fetching_metadata';
        task.peers = parseInt(status.connections || '0', 10);
        task.speed = parseInt(status.downloadSpeed || '0', 10);
        continue; // Let aria2 finish downloading metadata, DO NOT PAUSE!
      }

      // Update name if BitTorrent info contains name
      if (status.bittorrent && status.bittorrent.info && status.bittorrent.info.name) {
        task.name = status.bittorrent.info.name;
      }

      task.totalSize = parseInt(status.totalLength || '0', 10);
      task.downloadedSize = parseInt(status.completedLength || '0', 10);
      task.peers = parseInt(status.numPieces ? status.connections : status.connections || '0', 10);

      // Check real files (not [METADATA])
      if (status.files && status.files.length > 0 && !isMetadataFile) {
        task.files = status.files.map((f, idx) => {
          const filePath = f.path;
          const fileName = path.basename(filePath);
          const ext = path.extname(fileName).toLowerCase();
          const isVideo = ['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext);
          const isAudio = ['.mp3', '.m4a', '.flac', '.wav'].includes(ext);
          return {
            index: idx,
            name: fileName,
            path: filePath,
            size: parseInt(f.length || '0', 10),
            completed: parseInt(f.completedLength || '0', 10),
            selected: f.selected === 'true',
            isVideo,
            isAudio,
            isMedia: isVideo || isAudio
          };
        });

        task.speed = parseInt(status.downloadSpeed || '0', 10);
        task.progress = task.totalSize > 0 ? Math.round((task.downloadedSize / task.totalSize) * 100) : 0;
        task.status = (task.downloadedSize >= task.totalSize && task.totalSize > 0) ? 'completed' : 'downloading';
      }

      if (status.status === 'error') {
        task.status = 'failed';
        task.errorMessage = status.errorMessage || 'Conversion error';
      }
    } catch (err) {
      // ignore transient RPC errors
    }
  }

  saveDB();
}

// Poll aria2 status every 1.2 seconds
setInterval(syncTasksWithAria2, 1200);

// HTTP Request Handler
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API: CONVERT MAGNET LINK ---
  if (req.method === 'POST' && pathname === '/api/convert') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { magnet, customName } = JSON.parse(body || '{}');
        if (!magnet) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Magnet link or torrent URL is required' }));
        }

        const parsed = parseMagnetURI(magnet);
        if (parsed.error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: parsed.error }));
        }

        const infoHash = parsed.infoHash;

        // Check if already in DB
        const existing = db.tasks.find((t) => t.infoHash === infoHash);
        if (existing) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, task: existing, cached: true }));
        }

        const taskId = 'tc_' + crypto.randomBytes(6).toString('hex');

        // Instant Direct Cloud URL conversion (TorrentCheap, Seedr, HTTP direct link)
        if (parsed.isDirectCloudUrl) {
          let resolvedName = parsed.name;
          let totalSize = 0;
          let isVideo = false;
          let isAudio = false;

          try {
            const inspected = await inspectDirectUrl(parsed.directUrl);
            if (inspected) {
              if (inspected.fileName) resolvedName = inspected.fileName;
              if (inspected.contentLength) totalSize = inspected.contentLength;
              if (inspected.contentType) {
                if (inspected.contentType.includes('video')) isVideo = true;
                if (inspected.contentType.includes('audio')) isAudio = true;
              }
            }
          } catch (e) {}

          const ext = path.extname(resolvedName.split('?')[0]).toLowerCase();
          if (['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext)) isVideo = true;
          if (['.mp3', '.m4a', '.flac', '.wav'].includes(ext)) isAudio = true;
          if (!ext || /torrentcheap\.com|seedr\.cc/i.test(parsed.directUrl)) {
            if (!isAudio) isVideo = true;
          }

          const newTask = {
            id: taskId,
            isDirectCloudUrl: true,
            directUrl: parsed.directUrl,
            infoHash,
            name: customName || resolvedName,
            gid: null,
            activeGid: null,
            status: 'converted',
            totalSize,
            downloadedSize: totalSize,
            speed: 0,
            peers: 0,
            progress: 100,
            addedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            files: [
              {
                index: 0,
                name: resolvedName,
                path: parsed.directUrl,
                directUrl: parsed.directUrl,
                size: totalSize,
                completed: totalSize,
                selected: true,
                isVideo,
                isAudio,
                isMedia: isVideo || isAudio
              }
            ]
          };

          db.tasks.unshift(newTask);
          saveDB();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, task: newTask, cached: false }));
        }

        // If Seedr mode is enabled and account configured, convert via Seedr Cloud API
        if (db.settings.seedrEmail && db.settings.seedrPassword) {
          try {
            console.log(`Sending magnet ${parsed.infoHash} to Seedr cloud...`);
            const seedrPostData = `magnet=${encodeURIComponent(parsed.enhancedMagnet || magnet)}`;
            const seedrRes = await seedrRequest('/rest/transfer/magnet', 'POST', seedrPostData);

            if (seedrRes && seedrRes.result) {
              const newTask = {
                id: taskId,
                isSeedr: true,
                isDirectCloudUrl: true,
                transferId: seedrRes.transfer_id,
                infoHash,
                name: seedrRes.title || parsed.name,
                status: 'fetching_metadata',
                totalSize: 0,
                downloadedSize: 0,
                speed: 0,
                peers: 0,
                progress: 0,
                addedAt: new Date().toISOString(),
                completedAt: null,
                files: []
              };

              db.tasks.unshift(newTask);
              saveDB();

              // Immediately do a poll check (if already cached on Seedr, completes in 1 second)
              pollSeedrTransfer(newTask).catch(() => {});

              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ success: true, task: newTask, seedr: true }));
            } else if (seedrRes && seedrRes.error) {
              console.warn('Seedr transfer error:', seedrRes.error);
              if (seedrRes.error === 'not_enough_space') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Seedr Cloud storage full (Free accounts have 2GB limit). Please free up space on your Seedr account or delete old files.' }));
              }
            }
          } catch (seedrErr) {
            console.warn('Seedr API failed, falling back to local on-demand engine:', seedrErr.message);
          }
        }

        const taskDir = path.join(DOWNLOADS_DIR, taskId);
        if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });

        // Add to Aria2 (try enhancedMagnet first, fallback to rawMagnet)
        let gid = null;
        try {
          gid = await aria2Rpc('addUri', [[parsed.enhancedMagnet], { dir: taskDir }]);
        } catch (ariaErr) {
          console.warn('Aria2 enhanced addUri failed, trying raw magnet:', ariaErr.message);
          try {
            gid = await aria2Rpc('addUri', [[parsed.rawMagnet], { dir: taskDir }]);
          } catch (fallbackErr) {
            console.error('Aria2 fallback addUri failed:', fallbackErr);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Download engine error: ' + fallbackErr.message }));
          }
        }

        const newTask = {
          id: taskId,
          magnet: parsed.enhancedMagnet,
          rawMagnet: magnet,
          infoHash,
          name: customName || parsed.name,
          gid,
          activeGid: gid,
          status: 'fetching_metadata',
          totalSize: 0,
          downloadedSize: 0,
          speed: 0,
          peers: 0,
          progress: 0,
          addedAt: new Date().toISOString(),
          completedAt: null,
          files: []
        };

        db.tasks.unshift(newTask);
        saveDB();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, task: newTask, cached: false }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- API: UPLOAD .TORRENT FILE ---
  if (req.method === 'POST' && pathname === '/api/upload-torrent') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { torrentBase64, filename } = JSON.parse(body || '{}');
        if (!torrentBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No .torrent file data received' }));
        }

        const torrentBuffer = Buffer.from(torrentBase64, 'base64');
        const infoHash = crypto.createHash('sha1').update(torrentBuffer).digest('hex');

        // Check if already in DB
        const existing = db.tasks.find((t) => t.infoHash === infoHash);
        if (existing) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, task: existing, cached: true }));
        }

        const taskId = 'tc_' + crypto.randomBytes(6).toString('hex');
        const taskDir = path.join(DOWNLOADS_DIR, taskId);
        if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });

        // Save .torrent file to disk as well
        fs.writeFileSync(path.join(taskDir, 'source.torrent'), torrentBuffer);

        let gid = null;
        let files = [];
        let totalSize = 0;
        let resolvedName = (filename || 'Torrent File').replace(/\.torrent$/i, '');

        try {
          gid = await aria2Rpc('addTorrent', [torrentBase64, [], { dir: taskDir, pause: 'true' }]);
          const status = await aria2Rpc('tellStatus', [gid]);
          if (status) {
            totalSize = parseInt(status.totalLength || '0', 10);
            if (status.bittorrent && status.bittorrent.info && status.bittorrent.info.name) {
              resolvedName = status.bittorrent.info.name;
            }
            if (status.files) {
              files = status.files.map((f, idx) => {
                const filePath = f.path;
                const fileName = path.basename(filePath);
                const ext = path.extname(fileName).toLowerCase();
                const isVideo = ['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext);
                const isAudio = ['.mp3', '.m4a', '.flac', '.wav'].includes(ext);
                return {
                  index: idx,
                  name: fileName,
                  path: filePath,
                  size: parseInt(f.length || '0', 10),
                  completed: 0,
                  selected: true,
                  isVideo,
                  isAudio,
                  isMedia: isVideo || isAudio
                };
              });
            }
          }
        } catch (ariaErr) {
          console.error('Aria2 addTorrent failed:', ariaErr);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Download engine error: ' + ariaErr.message }));
        }

        const newTask = {
          id: taskId,
          magnet: '',
          rawMagnet: '',
          infoHash,
          name: resolvedName,
          gid,
          activeGid: gid,
          status: 'converted',
          totalSize,
          downloadedSize: 0,
          speed: 0,
          peers: 0,
          progress: 100,
          addedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          files
        };

        db.tasks.unshift(newTask);
        saveDB();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, task: newTask, cached: false }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- API: SEEDR ACCOUNT CONNECT & STATUS ---
  if (req.method === 'POST' && pathname === '/api/seedr/account') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { email, password } = JSON.parse(body || '{}');
        if (!email || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Seedr email and password are required' }));
        }

        // Test credentials with Seedr REST API
        const testRes = await seedrRequest('/rest/folder', 'GET', null, email.trim(), password);
        if (testRes && testRes.result === false) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid Seedr login credentials. Please check your email and password.' }));
        }

        db.settings.seedrEmail = email.trim();
        db.settings.seedrPassword = password;
        db.settings.engineMode = 'seedr';
        saveDB();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          email: db.settings.seedrEmail,
          space_used: testRes.space_used || 0,
          space_max: testRes.space_max || (2 * 1024 * 1024 * 1024)
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to verify Seedr account: ' + err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/seedr/account') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: Boolean(db.settings.seedrEmail && db.settings.seedrPassword),
      email: db.settings.seedrEmail || ''
    }));
    return;
  }

  // --- API: LIST TASKS ---
  if (req.method === 'GET' && pathname === '/api/tasks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: db.tasks }));
    return;
  }

  // --- API: GET SPECIFIC TASK ---
  if (req.method === 'GET' && pathname.startsWith('/api/tasks/')) {
    const taskId = pathname.replace('/api/tasks/', '');
    const task = db.tasks.find((t) => t.id === taskId);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Task not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task }));
    return;
  }

  // --- API: DELETE / CANCEL TASK ---
  if (req.method === 'DELETE' && pathname.startsWith('/api/tasks/')) {
    const taskId = pathname.replace('/api/tasks/', '');
    const idx = db.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Task not found' }));
    }

    const task = db.tasks[idx];
    const gidToRemove = task.activeGid || task.gid;
    if (gidToRemove) {
      try {
        await aria2Rpc('remove', [gidToRemove]);
      } catch (e) {}
    }

    // Optionally delete folder
    const taskDir = path.join(DOWNLOADS_DIR, task.id);
    if (fs.existsSync(taskDir)) {
      try {
        fs.rmSync(taskDir, { recursive: true, force: true });
      } catch (e) {}
    }

    db.tasks.splice(idx, 1);
    saveDB();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // --- API: SYSTEM & STORAGE STATS ---
  if (req.method === 'GET' && pathname === '/api/stats') {
    const MAX_FREE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB Free File Limit
    let spaceUsed = 0;
    for (const t of db.tasks) {
      spaceUsed += (t.totalSize || t.downloadedSize || 0);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        activeDownloads: db.tasks.filter((t) => t.status === 'downloading' || t.status === 'fetching_metadata').length,
        completedDownloads: db.tasks.filter((t) => t.status === 'converted' || t.status === 'completed').length,
        totalFiles: db.tasks.reduce((acc, t) => acc + (t.files ? t.files.length : 0), 0),
        spaceMaxBytes: MAX_FREE_BYTES,
        spaceMaxFormatted: '4.00 GB',
        spaceUsedBytes: spaceUsed,
        spaceUsedFormatted: formatBytes(spaceUsed),
        spaceAvailableBytes: Math.max(0, MAX_FREE_BYTES - spaceUsed),
        spaceAvailableFormatted: formatBytes(Math.max(0, MAX_FREE_BYTES - spaceUsed)),
        spacePercent: Math.min(100, Math.round((spaceUsed / MAX_FREE_BYTES) * 100)),
        totalDownloadedBytes: spaceUsed,
        totalDownloadedFormatted: formatBytes(spaceUsed)
      })
    );
    return;
  }

  // --- DIRECT DOWNLOAD ENDPOINT ---
  if (req.method === 'GET' && pathname.startsWith('/download/')) {
    const parts = pathname.split('/').filter(Boolean); // ['download', taskId, fileIndex]
    const taskId = parts[1];
    const fileIndex = parseInt(parts[2] || '0', 10);

    const task = db.tasks.find((t) => t.id === taskId);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Task not found');
    }

    // Direct Cloud URL redirect (Seedr, etc.)
    if (task.isDirectCloudUrl && task.directUrl) {
      res.writeHead(302, { Location: task.directUrl });
      return res.end();
    }

    // Locate the file on disk
    let targetFilePath = null;
    let fileName = 'download';

    if (task.files && task.files[fileIndex]) {
      const fileObj = task.files[fileIndex];
      targetFilePath = fileObj.path;
      fileName = fileObj.name || path.basename(targetFilePath);
    }

    // Fallback: search task directory
    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      const taskFolder = path.join(DOWNLOADS_DIR, taskId);
      const onDisk = scanDownloadedFiles(taskFolder);
      if (onDisk[fileIndex]) {
        targetFilePath = onDisk[fileIndex].fullPath;
        fileName = onDisk[fileIndex].name;
      }
    }

    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('File not ready or downloading');
    }

    const fileObj = (task.files && task.files[fileIndex]) ? task.files[fileIndex] : null;
    const expectedSize = (fileObj && fileObj.size > 0) ? fileObj.size : (task.totalSize || 0);

    const gid = task.activeGid || task.gid;
    if (gid) {
      aria2Rpc('unpause', [gid]).catch(() => {});
    }

    const stat = fs.existsSync(targetFilePath) ? fs.statSync(targetFilePath) : { size: 0 };
    const fileSize = expectedSize > 0 ? expectedSize : stat.size;
    const ext = path.extname(fileName).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Support range requests for high-speed download managers (IDM, FDM)
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      const file = fs.createReadStream(targetFilePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`
      });
      fs.createReadStream(targetFilePath).pipe(res);
    }
    return;
  }

  // --- STREAMING ENDPOINT (HTML5 Video / Audio player with Range headers) ---
  if (req.method === 'GET' && pathname.startsWith('/stream/')) {
    const parts = pathname.split('/').filter(Boolean); // ['stream', taskId, fileIndex]
    const taskId = parts[1];
    const fileIndex = parseInt(parts[2] || '0', 10);

    const task = db.tasks.find((t) => t.id === taskId);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Task not found');
    }

    // Direct Cloud URL redirect (Seedr, etc.)
    if (task.isDirectCloudUrl && task.directUrl) {
      res.writeHead(302, { Location: task.directUrl });
      return res.end();
    }

    let targetFilePath = null;
    let fileName = 'media';

    if (task.files && task.files[fileIndex]) {
      const fileObj = task.files[fileIndex];
      targetFilePath = fileObj.path;
      fileName = fileObj.name || path.basename(targetFilePath);
    }

    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      const taskFolder = path.join(DOWNLOADS_DIR, taskId);
      const onDisk = scanDownloadedFiles(taskFolder);
      if (onDisk[fileIndex]) {
        targetFilePath = onDisk[fileIndex].fullPath;
        fileName = onDisk[fileIndex].name;
      }
    }

    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Media file is still downloading or not available yet');
    }

    const fileObj = (task.files && task.files[fileIndex]) ? task.files[fileIndex] : null;
    const expectedSize = (fileObj && fileObj.size > 0) ? fileObj.size : (task.totalSize || 0);

    const gid = task.activeGid || task.gid;
    if (gid) {
      aria2Rpc('unpause', [gid]).catch(() => {});
    }

    const stat = fs.existsSync(targetFilePath) ? fs.statSync(targetFilePath) : { size: 0 };
    const fileSize = expectedSize > 0 ? expectedSize : stat.size;
    const ext = path.extname(fileName).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'video/mp4';

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      const file = fs.createReadStream(targetFilePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`
      });
      fs.createReadStream(targetFilePath).pipe(res);
    }
    return;
  }

  // --- STATIC FILE SERVING (public/ folder) ---
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Fallback to index.html for SPA routes
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(indexPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 TorrentCheap - Magnet to Direct Link Converter`);
  console.log(`🌐 Web Interface: http://localhost:${PORT}`);
  console.log(`⚡ Aria2 Engine: Port ${ARIA2_PORT} (Secret: Protected)`);
  console.log(`📁 Downloads Dir: ${DOWNLOADS_DIR}`);
  console.log(`=======================================================`);
});
