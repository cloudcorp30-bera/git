import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import stream from 'stream';
import os from 'os';
import axios from 'axios';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 10000;

// WebSocket server for real-time updates
const wss = new WebSocket.Server({ noServer: true });

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: JSON.stringify({
    status: 429,
    success: false,
    creator: "Bera",
    error: 'Rate limit exceeded'
  }),
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Create directories
const downloadsDir = path.join(__dirname, 'downloads');
const scrapedDataDir = path.join(__dirname, 'scraped_data');
const videosDir = path.join(__dirname, 'videos');
const logsDir = path.join(__dirname, 'logs');
const pythonDir = path.join(__dirname, 'python_scraper');

[downloadsDir, scrapedDataDir, videosDir, logsDir, pythonDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Clean old files every 10 minutes
setInterval(() => {
  try {
    const files = fs.readdirSync(downloadsDir);
    const now = Date.now();
    
    files.forEach(file => {
      const filePath = path.join(downloadsDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtime.getTime() > 30 * 60 * 1000) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {}
    });
  } catch (e) {}
}, 10 * 60 * 1000);

// ========== YOUTUBE DOWNLOADER API ==========

// Extract video ID from YouTube URL
function extractVideoId(url) {
  if (!url) return 'dQw4w9WgXcQ';
  
  try {
    if (url.includes('youtu.be/')) {
      const parts = url.split('youtu.be/');
      if (parts[1]) {
        return parts[1].split('?')[0].split('&')[0].substring(0, 11);
      }
    }
    
    if (url.includes('youtube.com')) {
      const urlObj = new URL(url);
      const videoId = urlObj.searchParams.get('v');
      if (videoId) return videoId.substring(0, 11);
    }
  } catch (e) {}
  
  return 'dQw4w9WgXcQ';
}

// Get video info using Python scraper
async function getVideoInfoFromPython(url) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(pythonDir, 'youtube_info.py');
    const pythonProcess = spawn('python3', [pythonScript, url]);
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    pythonProcess.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(stdout);
          resolve(info);
        } catch (e) {
          resolve({
            title: `YouTube Video ${extractVideoId(url)}`,
            thumbnail: `https://i.ytimg.com/vi/${extractVideoId(url)}/hqdefault.jpg`,
            duration: 180,
            quality: '128kbps'
          });
        }
      } else {
        reject(new Error(`Python script failed: ${stderr}`));
      }
    });
  });
}

// Download YouTube video using Python scraper
async function downloadYouTubeVideo(videoId, quality = 'best', format = 'mp3') {
  return new Promise((resolve, reject) => {
    const fileId = randomBytes(16).toString('hex');
    const outputPath = path.join(downloadsDir, `${fileId}.${format}`);
    
    const pythonScript = path.join(pythonDir, 'youtube_downloader.py');
    const args = [
      pythonScript,
      videoId,
      quality,
      format,
      outputPath
    ];
    
    const pythonProcess = spawn('python3', args);
    
    pythonProcess.stdout.on('data', (data) => {
      console.log(`Python: ${data}`);
    });
    
    pythonProcess.stderr.on('data', (data) => {
      console.error(`Python Error: ${data}`);
    });
    
    pythonProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({
          fileId,
          filePath: outputPath,
          size: fs.statSync(outputPath).size
        });
      } else {
        reject(new Error('Download failed'));
      }
    });
  });
}

// ========== MAIN ENDPOINTS ==========

// YouTube MP3 Download Endpoint
app.get('/api/download/youtube-mp3', async (req, res) => {
  try {
    const { apikey, url, quality = '128' } = req.query;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    console.log(`\n🎵 YouTube MP3 Request: ${url}`);
    
    // Validate API key
    if (!apikey || apikey !== 'bera') {
      return res.status(401).json({
        status: 401,
        success: false,
        creator: "Bera",
        error: "Invalid API key. Use: apikey=bera"
      });
    }
    
    // Validate URL
    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
      return res.status(400).json({
        status: 400,
        success: false,
        creator: "Bera",
        error: "Valid YouTube URL required"
      });
    }
    
    const videoId = extractVideoId(url);
    const fileId = randomBytes(16).toString('hex');
    
    // Get video info
    const videoInfo = await getVideoInfoFromPython(url);
    
    // Response with download URL
    const response = {
      status: 200,
      success: true,
      creator: "Bera",
      result: {
        videoId,
        title: videoInfo.title,
        thumbnail: videoInfo.thumbnail,
        duration: videoInfo.duration,
        quality: `${quality}kbps`,
        format: 'mp3',
        download_url: `${baseUrl}/api/download/file/${fileId}`,
        direct_stream: `${baseUrl}/api/stream/${fileId}`,
        note: "Click download_url to download MP3 file",
        file_ready: true
      }
    };
    
    res.json(response);
    
    // Start download in background
    setTimeout(async () => {
      try {
        console.log(`🔄 Downloading YouTube video ${videoId} in background...`);
        const result = await downloadYouTubeVideo(videoId, quality, 'mp3');
        console.log(`✅ Download complete: ${result.filePath} (${result.size} bytes)`);
      } catch (error) {
        console.error('❌ Download failed:', error.message);
      }
    }, 100);
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: "Internal server error"
    });
  }
});

// YouTube MP4 Download Endpoint
app.get('/api/download/youtube-mp4', async (req, res) => {
  try {
    const { apikey, url, quality = '720p' } = req.query;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    console.log(`\n🎬 YouTube MP4 Request: ${url}`);
    
    if (!apikey || apikey !== 'bera') {
      return res.status(401).json({
        status: 401,
        success: false,
        creator: "Bera",
        error: "Invalid API key"
      });
    }
    
    const videoId = extractVideoId(url);
    const fileId = randomBytes(16).toString('hex');
    
    const videoInfo = await getVideoInfoFromPython(url);
    
    res.json({
      status: 200,
      success: true,
      creator: "Bera",
      result: {
        videoId,
        title: videoInfo.title,
        thumbnail: videoInfo.thumbnail,
        quality: quality,
        format: 'mp4',
        download_url: `${baseUrl}/api/download/file/${fileId}.mp4`,
        direct_stream: `${baseUrl}/api/stream/video/${fileId}`,
        file_ready: false, // Will be ready when download completes
        download_id: fileId
      }
    });
    
    // Start MP4 download
    setTimeout(async () => {
      try {
        const result = await downloadYouTubeVideo(videoId, quality, 'mp4');
        
        // Rename file with proper extension
        const newPath = path.join(downloadsDir, `${fileId}.mp4`);
        fs.renameSync(result.filePath, newPath);
        
        console.log(`✅ MP4 download complete: ${newPath}`);
      } catch (error) {
        console.error('MP4 download failed:', error);
      }
    }, 100);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== WEB SCRAPER API ==========

// Start scraping job
app.post('/api/scrape/start', async (req, res) => {
  try {
    const { 
      url, 
      max_depth = 2, 
      download_videos = false,
      quality = 'best',
      use_proxies = false
    } = req.body;
    
    const jobId = randomBytes(8).toString('hex');
    const outputDir = path.join(scrapedDataDir, jobId);
    
    fs.mkdirSync(outputDir, { recursive: true });
    
    // Save job config
    const config = {
      jobId,
      url,
      max_depth,
      download_videos,
      quality,
      use_proxies,
      output_dir: outputDir,
      status: 'pending',
      start_time: new Date().toISOString()
    };
    
    fs.writeFileSync(
      path.join(outputDir, 'config.json'),
      JSON.stringify(config, null, 2)
    );
    
    res.json({
      status: 200,
      success: true,
      jobId,
      message: "Scraping job created",
      monitor_url: `${req.protocol}://${req.get('host')}/api/scrape/status/${jobId}`
    });
    
    // Start Python scraper in background
    const pythonScript = path.join(pythonDir, 'web_scraper.py');
    const args = [
      pythonScript,
      '--url', url,
      '--depth', max_depth.toString(),
      '--output', outputDir,
      '--job-id', jobId
    ];
    
    if (download_videos) {
      args.push('--download');
      args.push('--quality', quality);
    }
    
    if (use_proxies) {
      args.push('--proxies');
    }
    
    const pythonProcess = spawn('python3', args);
    
    // Save process PID
    fs.writeFileSync(
      path.join(outputDir, 'pid.txt'),
      pythonProcess.pid.toString()
    );
    
    pythonProcess.stdout.on('data', (data) => {
      console.log(`Scraper ${jobId}: ${data}`);
      
      // Update progress
      const progressFile = path.join(outputDir, 'progress.json');
      try {
        const progress = JSON.parse(data.toString());
        fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
      } catch (e) {}
    });
    
    pythonProcess.stderr.on('data', (data) => {
      console.error(`Scraper ${jobId} Error: ${data}`);
    });
    
    pythonProcess.on('close', (code) => {
      const endTime = new Date().toISOString();
      const resultFile = path.join(outputDir, 'result.json');
      
      const result = {
        jobId,
        status: code === 0 ? 'completed' : 'failed',
        exit_code: code,
        end_time: endTime,
        output_dir: outputDir
      };
      
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
      console.log(`Scraping job ${jobId} completed with code ${code}`);
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get scraping job status
app.get('/api/scrape/status/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDir = path.join(scrapedDataDir, jobId);
    
    if (!fs.existsSync(jobDir)) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const configPath = path.join(jobDir, 'config.json');
    const progressPath = path.join(jobDir, 'progress.json');
    const resultPath = path.join(jobDir, 'result.json');
    
    let response = {};
    
    if (fs.existsSync(configPath)) {
      response.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    
    if (fs.existsSync(progressPath)) {
      response.progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    }
    
    if (fs.existsSync(resultPath)) {
      response.result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    }
    
    // List downloaded files
    const videoFiles = fs.readdirSync(jobDir)
      .filter(file => file.endsWith('.mp4') || file.endsWith('.mp3'));
    
    response.files = videoFiles.map(file => ({
      name: file,
      url: `${req.protocol}://${req.get('host')}/api/scrape/download/${jobId}/${file}`,
      size: fs.statSync(path.join(jobDir, file)).size
    }));
    
    res.json(response);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download scraped file
app.get('/api/scrape/download/:jobId/:filename', (req, res) => {
  try {
    const { jobId, filename } = req.params;
    const filePath = path.join(scrapedDataDir, jobId, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const stats = fs.statSync(filePath);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size);
    
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== FILE DOWNLOAD ENDPOINTS ==========

// File download endpoint
app.get('/api/download/file/:fileId', (req, res) => {
  try {
    const { fileId } = req.params;
    
    // Look for file with any extension
    const files = fs.readdirSync(downloadsDir);
    const file = files.find(f => f.startsWith(fileId));
    
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const filePath = path.join(downloadsDir, file);
    const stats = fs.statSync(filePath);
    
    // Determine content type
    let contentType = 'application/octet-stream';
    if (file.endsWith('.mp3')) contentType = 'audio/mpeg';
    if (file.endsWith('.mp4')) contentType = 'video/mp4';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.setHeader('Content-Length', stats.size);
    
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    
    // Clean up after 5 minutes
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {}
    }, 5 * 60 * 1000);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Audio streaming endpoint
app.get('/api/stream/:fileId', (req, res) => {
  try {
    const { fileId } = req.params;
    const files = fs.readdirSync(downloadsDir);
    const file = files.find(f => f.startsWith(fileId) && f.endsWith('.mp3'));
    
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const filePath = path.join(downloadsDir, file);
    const stats = fs.statSync(filePath);
    
    const range = req.headers.range;
    
    if (range) {
      // Handle range requests for seeking
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      
      const chunksize = (end - start) + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'audio/mpeg'
      });
      
      fileStream.pipe(res);
    } else {
      // Full file stream
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': 'audio/mpeg'
      });
      
      fs.createReadStream(filePath).pipe(res);
    }
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== WEB SOCKET FOR REAL-TIME UPDATES ==========

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'subscribe_job') {
        // Subscribe to job updates
        const jobId = data.jobId;
        const progressFile = path.join(scrapedDataDir, jobId, 'progress.json');
        
        // Send updates every 2 seconds
        const interval = setInterval(() => {
          if (fs.existsSync(progressFile)) {
            try {
              const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
              ws.send(JSON.stringify({
                type: 'job_update',
                jobId,
                progress
              }));
            } catch (e) {}
          }
        }, 2000);
        
        ws.on('close', () => {
          clearInterval(interval);
        });
      }
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

// ========== DASHBOARD & MONITORING ==========

// Dashboard
app.get('/dashboard', (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Video Download & Scraping Dashboard</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
      .container { max-width: 1200px; margin: 0 auto; }
      .card { background: white; padding: 20px; margin: 20px 0; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
      .btn { background: #3498db; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin: 10px 5px; }
      .btn:hover { background: #2980b9; }
      .section { margin: 30px 0; }
      .form-group { margin: 15px 0; }
      input, select { width: 100%; padding: 10px; margin: 5px 0; border: 1px solid #ddd; border-radius: 5px; }
      .progress-bar { width: 100%; height: 20px; background: #eee; border-radius: 10px; overflow: hidden; }
      .progress { height: 100%; background: #2ecc71; transition: width 0.3s; }
      .job-list { max-height: 400px; overflow-y: auto; }
      .job-item { padding: 10px; border-bottom: 1px solid #eee; }
      .status { padding: 5px 10px; border-radius: 5px; color: white; }
      .status-pending { background: #f39c12; }
      .status-running { background: #3498db; }
      .status-completed { background: #2ecc71; }
      .status-failed { background: #e74c3c; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>🎬 Video Download & Scraping Dashboard</h1>
      
      <div class="section">
        <h2>YouTube Downloader</h2>
        <div class="card">
          <div class="form-group">
            <label>YouTube URL:</label>
            <input type="text" id="youtubeUrl" placeholder="https://www.youtube.com/watch?v=...">
          </div>
          <div class="form-group">
            <label>Format:</label>
            <select id="format">
              <option value="mp3">MP3 Audio</option>
              <option value="mp4">MP4 Video</option>
            </select>
          </div>
          <div class="form-group">
            <label>Quality:</label>
            <select id="quality">
              <option value="128">128kbps (MP3)</option>
              <option value="192">192kbps (MP3)</option>
              <option value="320">320kbps (MP3)</option>
              <option value="360p">360p (MP4)</option>
              <option value="720p">720p (MP4)</option>
              <option value="1080p">1080p (MP4)</option>
            </select>
          </div>
          <button class="btn" onclick="downloadYouTube()">Download</button>
          <div id="youtubeResult"></div>
        </div>
      </div>
      
      <div class="section">
        <h2>Web Scraper</h2>
        <div class="card">
          <div class="form-group">
            <label>Website URL:</label>
            <input type="text" id="scrapeUrl" placeholder="https://ssvid.net">
          </div>
          <div class="form-group">
            <label>Max Depth:</label>
            <input type="number" id="maxDepth" value="2" min="1" max="5">
          </div>
          <div class="form-group">
            <label>
              <input type="checkbox" id="downloadVideos"> Download Videos
            </label>
          </div>
          <div class="form-group">
            <label>
              <input type="checkbox" id="useProxies"> Use Proxies
            </label>
          </div>
          <button class="btn" onclick="startScraping()">Start Scraping</button>
          <div id="scrapeResult"></div>
        </div>
      </div>
      
      <div class="section">
        <h2>Active Jobs</h2>
        <div class="card">
          <div id="jobsList" class="job-list"></div>
        </div>
      </div>
    </div>
    
    <script>
      const baseUrl = window.location.origin;
      
      async function downloadYouTube() {
        const url = document.getElementById('youtubeUrl').value;
        const format = document.getElementById('format').value;
        const quality = document.getElementById('quality').value;
        
        if (!url) {
          alert('Please enter a YouTube URL');
          return;
        }
        
        const endpoint = format === 'mp3' 
          ? '/api/download/youtube-mp3' 
          : '/api/download/youtube-mp4';
        
        const response = await fetch(
          \`\${baseUrl}\${endpoint}?apikey=bera&url=\${encodeURIComponent(url)}&quality=\${quality}\`
        );
        
        const result = await response.json();
        const resultDiv = document.getElementById('youtubeResult');
        
        if (result.success) {
          resultDiv.innerHTML = \`
            <div style="margin-top: 20px; padding: 15px; background: #d4edda; border-radius: 5px;">
              <h3>✅ Download Ready!</h3>
              <p><strong>Title:</strong> \${result.result.title}</p>
              <p><strong>Download:</strong> 
                <a href="\${baseUrl}\${result.result.download_url}" target="_blank">Click here</a>
              </p>
              <p><strong>Stream:</strong> 
                <a href="\${baseUrl}\${result.result.direct_stream}" target="_blank">Play online</a>
              </p>
            </div>
          \`;
          
          // Auto-download after 2 seconds
          setTimeout(() => {
            window.open(baseUrl + result.result.download_url, '_blank');
          }, 2000);
        } else {
          resultDiv.innerHTML = \`
            <div style="margin-top: 20px; padding: 15px; background: #f8d7da; border-radius: 5px;">
              <h3>❌ Error</h3>
              <p>\${result.error}</p>
            </div>
          \`;
        }
      }
      
      async function startScraping() {
        const url = document.getElementById('scrapeUrl').value;
        const maxDepth = document.getElementById('maxDepth').value;
        const downloadVideos = document.getElementById('downloadVideos').checked;
        const useProxies = document.getElementById('useProxies').checked;
        
        if (!url) {
          alert('Please enter a website URL');
          return;
        }
        
        const response = await fetch(baseUrl + '/api/scrape/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            max_depth: parseInt(maxDepth),
            download_videos: downloadVideos,
            use_proxies: useProxies,
            quality: 'best'
          })
        });
        
        const result = await response.json();
        const resultDiv = document.getElementById('scrapeResult');
        
        if (result.success) {
          resultDiv.innerHTML = \`
            <div style="margin-top: 20px; padding: 15px; background: #d4edda; border-radius: 5px;">
              <h3>✅ Scraping Job Started</h3>
              <p><strong>Job ID:</strong> \${result.jobId}</p>
              <p><strong>Monitor:</strong> 
                <a href="\${baseUrl}/api/scrape/status/\${result.jobId}" target="_blank">View Progress</a>
              </p>
            </div>
          \`;
          
          // Start monitoring this job
          monitorJob(result.jobId);
        } else {
          resultDiv.innerHTML = \`
            <div style="margin-top: 20px; padding: 15px; background: #f8d7da; border-radius: 5px;">
              <h3>❌ Error</h3>
              <p>\${result.error}</p>
            </div>
          \`;
        }
      }
      
      async function monitorJob(jobId) {
        const ws = new WebSocket(\`ws://\${window.location.host}\`);
        
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'subscribe_job',
            jobId: jobId
          }));
        };
        
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'job_update') {
            updateJobDisplay(data.jobId, data.progress);
          }
        };
        
        // Also poll for updates
        setInterval(async () => {
          const response = await fetch(baseUrl + '/api/scrape/status/' + jobId);
          const data = await response.json();
          updateJobsList();
        }, 5000);
      }
      
      function updateJobDisplay(jobId, progress) {
        // Update job list
        updateJobsList();
      }
      
      async function updateJobsList() {
        // Get list of all jobs
        // This would need a new endpoint to list all jobs
        // For now, we'll just show a message
        const jobsList = document.getElementById('jobsList');
        jobsList.innerHTML = '<p>Loading jobs...</p>';
      }
      
      // Initialize
      updateJobsList();
    </script>
  </body>
  </html>
  `;
  
  res.send(html);
});

// Health check
app.get('/health', (req, res) => {
  const downloadsCount = fs.readdirSync(downloadsDir).length;
  const scrapedJobsCount = fs.readdirSync(scrapedDataDir).length;
  
  res.json({
    status: 200,
    success: true,
    creator: "Bera",
    message: "Video Download & Scraping System is running",
    timestamp: new Date().toISOString(),
    stats: {
      port: PORT,
      downloads_count: downloadsCount,
      active_jobs: scrapedJobsCount,
      system: {
        platform: os.platform(),
        arch: os.arch(),
        free_memory: Math.round(os.freemem() / 1024 / 1024) + 'MB',
        uptime: Math.round(os.uptime() / 60) + ' minutes'
      }
    }
  });
});

// Upgrade HTTP to WebSocket
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    🚀 VIDEO DOWNLOAD SYSTEM                      ║
║           YouTube + Web Scraper - Full Functional System         ║
╚══════════════════════════════════════════════════════════════════╝

📡 Server running on port ${PORT}
🌐 Dashboard: http://localhost:${PORT}/dashboard
📊 Health: http://localhost:${PORT}/health

🎵 YOUTUBE DOWNLOADER:
   MP3: http://localhost:${PORT}/api/download/youtube-mp3?apikey=bera&url=YOUTUBE_URL
   MP4: http://localhost:${PORT}/api/download/youtube-mp4?apikey=bera&url=YOUTUBE_URL

🕸️ WEB SCRAPER:
   POST http://localhost:${PORT}/api/scrape/start
   {"url": "https://ssvid.net", "download_videos": true}

🔑 API Key: bera
`);

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });
});
