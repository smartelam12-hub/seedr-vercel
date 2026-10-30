# ⚡ TorrentCheap - Magnet to Direct Link Converter & Cloud Streamer

A cloud-torrent and magnet-to-direct-link conversion web application inspired by **TorrentCheap**, **Seedr**, and **Real-Debrid**.

> **"Download to the cloud and watch anywhere. Paste a magnet link, we download it on our servers, and you stream or save it on any device — free."**

---

## ✨ Features

- 🚀 **Quick Magnet Converting**: Injects top high-speed public BitTorrent trackers into every magnet link for instantaneous DHT peer discovery and metadata resolution.
- ⚡ **Direct HTTP Download Links**: Generates instant, multi-threaded direct HTTP download URLs compatible with download accelerators (IDM, FDM, aria2, curl, browser).
- 🎬 **In-Browser Cloud Streaming**: Streams video (`.mp4`, `.mkv`, `.webm`, etc.) and audio (`.mp3`, `.flac`) directly in the browser with full **HTTP 206 Partial Content (Range)** support for zero-lag scrubbing and seeking.
- 📺 **MiniPlayerMount & Theater Mode**: Floating mini player in the bottom-right corner (just like TorrentCheap) plus a full theater video player modal.
- 🌓 **Dark & Light Mode**: Clean glassmorphic UI with automatic theme detection and local storage persistence (`tc-theme`).
- 📊 **Real-time Live Stats**: Shows real-time download speeds, connected peer count, progress bar, ETA, and file tree.
- 💾 **Instant Cache**: Remembers previously converted torrents for zero-second conversion.

---

## 🚀 How to Run

### Method 1: One-Click Launcher (Windows)
Double-click:
```
start.bat
```
This automatically starts the server and opens `http://localhost:3000` in your default browser.

### Method 2: Command Line
From the project folder:
```powershell
.\bin\node.exe server.js
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

---

## 🛠️ Project Structure

```
d:\M to D link\
├── bin\
│   ├── node.exe         # Portable Node.js runtime (no installer required)
│   └── aria2c.exe       # High-speed BitTorrent / DHT multi-thread engine
├── downloads\           # Converted and downloaded media files
├── data\
│   └── db.json          # Persistent task database
├── public\
│   ├── index.html       # TorrentCheap responsive frontend UI
│   ├── style.css        # Glassmorphic styles & animations
│   └── app.js           # Real-time polling & media player logic
├── server.js            # Node.js backend & aria2c JSON-RPC manager
├── start.bat            # 1-Click launcher
└── README.md            # Documentation
```

---

## 🌐 Deploying to a Cloud VPS (Ubuntu / Linux)

To run this publicly on a VPS (DigitalOcean, Hetzner, AWS, etc.):
1. Install Node.js & Aria2:
   ```bash
   sudo apt update && sudo apt install -y nodejs npm aria2
   ```
2. Clone or copy these project files.
3. Start the server:
   ```bash
   node server.js
   ```
4. (Optional) Put behind Nginx with SSL (Let's Encrypt) and point your domain (e.g., `https://your-domain.com`).
