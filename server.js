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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 10000;

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

// ========== HELPER FUNCTIONS ==========

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
        file_ready: false,
        download_id: fileId
      }
    });
    
    // Start MP4 download in background
    setTimeout(async () => {
      try {
        console.log(`🔄 Downloading YouTube video ${videoId} as MP4...`);
        const result = await downloadYouTubeVideo(videoId, quality, 'mp4');
        
        // Rename file with proper extension
        const newPath = path.join(downloadsDir, `${fileId}.mp4`);
        if (fs.existsSync(result.filePath)) {
          fs.renameSync(result.filePath, newPath);
        }
        
        console.log(`✅ MP4 download complete: ${newPath}`);
      } catch (error) {
        console.error('MP4 download failed:', error);
      }
    }, 100);
    
  } catch (error) {
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message
    });
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
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message
    });
  }
});

// Get scraping job status
app.get('/api/scrape/status/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDir = path.join(scrapedDataDir, jobId);
    
    if (!fs.existsSync(jobDir)) {
      return res.status(404).json({
        status: 404,
        success: false,
        creator: "Bera",
        error: 'Job not found'
      });
    }
    
    const configPath = path.join(jobDir, 'config.json');
    const progressPath = path.join(jobDir, 'progress.json');
    const resultPath = path.join(jobDir, 'result.json');
    
    let response = {
      status: 200,
      success: true,
      creator: "Bera",
      jobId
    };
    
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
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message
    });
  }
});

// Download scraped file
app.get('/api/scrape/download/:jobId/:filename', (req, res) => {
  try {
    const { jobId, filename } = req.params;
    const filePath = path.join(scrapedDataDir, jobId, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        status: 404,
        success: false,
        creator: "Bera",
        error: 'File not found'
      });
    }
    
    const stats = fs.statSync(filePath);
    
    let contentType = 'application/octet-stream';
    if (filename.endsWith('.mp4')) contentType = 'video/mp4';
    if (filename.endsWith('.mp3')) contentType = 'audio/mpeg';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size);
    
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    
  } catch (error) {
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message
    });
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
      return res.status(404).json({
        status: 404,
        success: false,
        creator: "Bera",
        error: 'File not found'
      });
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
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message
    });
  }
});

// Audio streaming endpoint
app.get('/api/stream/:fileId', (req, res) => {
  try {
    const { fileId } = req.params;
    const files = fs.readdirSync(downloadsDir);
    const file = files.find(f => f.startsWith(fileId) && f.endsWith('.mp3'));
    
    if (!file) {
      return res.status(404).json({
        status: 404,
        success: false,
        creator: "Bera",
        error: 'File not found'
      });
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
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message
    });
  }
});

// Video streaming endpoint
app.get('/api/stream/video/:fileId', (req, res) => {
  try {
    const { fileId } = req.params;
    const files = fs.readdirSync(downloadsDir);
    const file = files.find(f => f.startsWith(fileId) && f.endsWith('.mp4'));
    
    if (!file) {
      return res.status(404).json({
        status: 404,
        success: false,
        creator: "Bera",
        error: 'File not found'
      });
    }
    
    const filePath = path.join(downloadsDir, file);
    const stats = fs.statSync(filePath);
    
    const range = req.headers.range;
    
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      
      const chunksize = (end - start) + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4'
      });
      
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': 'video/mp4'
      });
      
      fs.createReadStream(filePath).pipe(res);
    }
    
  } catch (error) {
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message
    });
  }
});

// ========== SIMPLE DASHBOARD ==========

app.get('/dashboard', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Video Download & Scraping System</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
      .container { max-width: 1200px; margin: 0 auto; }
      .header { text-align: center; color: white; padding: 40px 20px; }
      .header h1 { font-size: 3em; margin-bottom: 10px; }
      .header p { font-size: 1.2em; opacity: 0.9; }
      .card { background: white; border-radius: 15px; padding: 30px; margin-bottom: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
      .section-title { color: #333; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 2px solid #667eea; }
      .form-group { margin-bottom: 20px; }
      .form-group label { display: block; margin-bottom: 8px; color: #555; font-weight: 500; }
      .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 12px 15px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; transition: border 0.3s; }
      .form-group input:focus, .form-group select:focus { border-color: #667eea; outline: none; }
      .btn { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 15px 30px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; display: inline-block; text-decoration: none; }
      .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4); }
      .btn-secondary { background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); }
      .result { margin-top: 20px; padding: 20px; border-radius: 8px; background: #f8f9fa; display: none; }
      .result.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; display: block; }
      .result.error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; display: block; }
      .result pre { background: white; padding: 15px; border-radius: 5px; overflow-x: auto; margin-top: 10px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; }
      .api-box { background: #f8f9fa; padding: 20px; border-radius: 10px; border-left: 4px solid #667eea; }
      .api-box h3 { color: #333; margin-bottom: 10px; }
      .api-box code { background: #e9ecef; padding: 5px 10px; border-radius: 4px; font-family: monospace; }
      .tab-container { margin-top: 30px; }
      .tabs { display: flex; background: white; border-radius: 10px 10px 0 0; overflow: hidden; }
      .tab { padding: 15px 30px; background: #f8f9fa; border: none; font-size: 16px; cursor: pointer; flex: 1; text-align: center; }
      .tab.active { background: white; font-weight: 600; color: #667eea; }
      .tab-content { display: none; background: white; padding: 30px; border-radius: 0 0 10px 10px; }
      .tab-content.active { display: block; }
      .status-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 10px; }
      .status-online { background: #4CAF50; }
      .status-offline { background: #f44336; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>🎬 Video Download & Scraping System</h1>
        <p>Download YouTube videos and scrape websites with ease</p>
        <div style="margin-top: 20px;">
          <span class="status-indicator status-online"></span>
          <span>System Status: Online</span>
        </div>
      </div>
      
      <div class="tab-container">
        <div class="tabs">
          <button class="tab active" onclick="switchTab('youtube')">YouTube Downloader</button>
          <button class="tab" onclick="switchTab('scraper')">Web Scraper</button>
          <button class="tab" onclick="switchTab('api')">API Documentation</button>
        </div>
        
        <div id="youtube" class="tab-content active">
          <div class="card">
            <h2 class="section-title">YouTube Video Downloader</h2>
            <div class="grid">
              <div>
                <h3>MP3 Audio Download</h3>
                <div class="form-group">
                  <label for="youtubeUrlMp3">YouTube URL:</label>
                  <input type="text" id="youtubeUrlMp3" placeholder="https://www.youtube.com/watch?v=...">
                </div>
                <div class="form-group">
                  <label for="qualityMp3">Audio Quality:</label>
                  <select id="qualityMp3">
                    <option value="128">128kbps</option>
                    <option value="192" selected>192kbps</option>
                    <option value="320">320kbps</option>
                  </select>
                </div>
                <button class="btn" onclick="downloadYouTube('mp3')">Download MP3</button>
              </div>
              
              <div>
                <h3>MP4 Video Download</h3>
                <div class="form-group">
                  <label for="youtubeUrlMp4">YouTube URL:</label>
                  <input type="text" id="youtubeUrlMp4" placeholder="https://www.youtube.com/watch?v=...">
                </div>
                <div class="form-group">
                  <label for="qualityMp4">Video Quality:</label>
                  <select id="qualityMp4">
                    <option value="360p">360p</option>
                    <option value="480p">480p</option>
                    <option value="720p" selected>720p</option>
                    <option value="1080p">1080p</option>
                  </select>
                </div>
                <button class="btn btn-secondary" onclick="downloadYouTube('mp4')">Download MP4</button>
              </div>
            </div>
            <div id="youtubeResult" class="result"></div>
          </div>
        </div>
        
        <div id="scraper" class="tab-content">
          <div class="card">
            <h2 class="section-title">Web Scraper</h2>
            <div class="form-group">
              <label for="scrapeUrl">Website URL:</label>
              <input type="text" id="scrapeUrl" placeholder="https://ssvid.net">
            </div>
            <div class="grid">
              <div class="form-group">
                <label for="maxDepth">Max Depth:</label>
                <input type="number" id="maxDepth" value="2" min="1" max="5">
              </div>
              <div class="form-group">
                <label for="qualityScrape">Video Quality:</label>
                <select id="qualityScrape">
                  <option value="360p">360p</option>
                  <option value="720p" selected>720p</option>
                  <option value="1080p">1080p</option>
                  <option value="best">Best Available</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label style="display: inline-flex; align-items: center; gap: 10px;">
                <input type="checkbox" id="downloadVideos" checked> Download Videos
              </label>
            </div>
            <button class="btn" onclick="startScraping()">Start Scraping</button>
            <div id="scrapeResult" class="result"></div>
          </div>
        </div>
        
        <div id="api" class="tab-content">
          <div class="card">
            <h2 class="section-title">API Documentation</h2>
            <div class="grid">
              <div class="api-box">
                <h3>YouTube MP3 Download</h3>
                <p><strong>Endpoint:</strong> GET /api/download/youtube-mp3</p>
                <p><strong>Parameters:</strong></p>
                <code>apikey=bera&url=YOUTUBE_URL&quality=128</code>
                <p><strong>Example:</strong></p>
                <code>${baseUrl}/api/download/youtube-mp3?apikey=bera&url=https://youtu.be/dQw4w9WgXcQ&quality=192</code>
              </div>
              
              <div class="api-box">
                <h3>YouTube MP4 Download</h3>
                <p><strong>Endpoint:</strong> GET /api/download/youtube-mp4</p>
                <p><strong>Parameters:</strong></p>
                <code>apikey=bera&url=YOUTUBE_URL&quality=720p</code>
                <p><strong>Example:</strong></p>
                <code>${baseUrl}/api/download/youtube-mp4?apikey=bera&url=https://youtu.be/dQw4w9WgXcQ&quality=720p</code>
              </div>
              
              <div class="api-box">
                <h3>Start Scraping Job</h3>
                <p><strong>Endpoint:</strong> POST /api/scrape/start</p>
                <p><strong>Body (JSON):</strong></p>
                <code>{"url":"https://ssvid.net","download_videos":true}</code>
              </div>
              
              <div class="api-box">
                <h3>Check Job Status</h3>
                <p><strong>Endpoint:</strong> GET /api/scrape/status/:jobId</p>
                <p><strong>Example:</strong></p>
                <code>${baseUrl}/api/scrape/status/JOB_ID</code>
              </div>
            </div>
            
            <div style="margin-top: 30px; padding: 20px; background: #f8f9fa; border-radius: 10px;">
              <h3>Quick Test</h3>
              <p>Test the system with a sample YouTube video:</p>
              <button class="btn" onclick="testSystem()">Test System</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <script>
      const baseUrl = '${baseUrl}';
      
      function switchTab(tabName) {
        // Hide all tabs
        document.querySelectorAll('.tab-content').forEach(tab => {
          tab.classList.remove('active');
        });
        document.querySelectorAll('.tab').forEach(tab => {
          tab.classList.remove('active');
        });
        
        // Show selected tab
        document.getElementById(tabName).classList.add('active');
        document.querySelectorAll('.tab').forEach(tab => {
          if (tab.textContent.toLowerCase().includes(tabName)) {
            tab.classList.add('active');
          }
        });
      }
      
      async function downloadYouTube(format) {
        const urlInput = format === 'mp3' ? 'youtubeUrlMp3' : 'youtubeUrlMp4';
        const qualityInput = format === 'mp3' ? 'qualityMp3' : 'qualityMp4';
        
        const url = document.getElementById(urlInput).value;
        const quality = document.getElementById(qualityInput).value;
        
        if (!url) {
          showResult('youtubeResult', 'Please enter a YouTube URL', 'error');
          return;
        }
        
        const endpoint = format === 'mp3' ? '/api/download/youtube-mp3' : '/api/download/youtube-mp4';
        const resultDiv = document.getElementById('youtubeResult');
        
        showResult('youtubeResult', 'Downloading...', '');
        
        try {
          const response = await fetch(
            \`\${baseUrl}\${endpoint}?apikey=bera&url=\${encodeURIComponent(url)}&quality=\${quality}\`
          );
          const data = await response.json();
          
          if (data.success) {
            const html = \`
              <h3>✅ Download Ready!</h3>
              <p><strong>Title:</strong> \${data.result.title}</p>
              <p><strong>Format:</strong> \${data.result.format.toUpperCase()}</p>
              <p><strong>Quality:</strong> \${data.result.quality}</p>
              <p><strong>Download:</strong> 
                <a href="\${data.result.download_url}" target="_blank" class="btn" style="padding: 8px 15px; font-size: 14px; margin-left: 10px;">Download Now</a>
              </p>
              <p><strong>Stream:</strong> 
                <a href="\${data.result.direct_stream}" target="_blank" style="color: #667eea;">Play Online</a>
              </p>
              <p><small>Note: File will auto-delete after 5 minutes</small></p>
            \`;
            showResult('youtubeResult', html, 'success');
            
            // Auto-open download after 2 seconds
            setTimeout(() => {
              window.open(data.result.download_url, '_blank');
            }, 2000);
          } else {
            showResult('youtubeResult', \`Error: \${data.error}\`, 'error');
          }
        } catch (error) {
          showResult('youtubeResult', \`Error: \${error.message}\`, 'error');
        }
      }
      
      async function startScraping() {
        const url = document.getElementById('scrapeUrl').value;
        const maxDepth = document.getElementById('maxDepth').value;
        const quality = document.getElementById('qualityScrape').value;
        const downloadVideos = document.getElementById('downloadVideos').checked;
        
        if (!url) {
          showResult('scrapeResult', 'Please enter a website URL', 'error');
          return;
        }
        
        const resultDiv = document.getElementById('scrapeResult');
        showResult('scrapeResult', 'Starting scraping job...', '');
        
        try {
          const response = await fetch(baseUrl + '/api/scrape/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url,
              max_depth: parseInt(maxDepth),
              download_videos: downloadVideos,
              quality: quality,
              use_proxies: false
            })
          });
          
          const data = await response.json();
          
          if (data.success) {
            const html = \`
              <h3>✅ Scraping Job Started</h3>
              <p><strong>Job ID:</strong> \${data.jobId}</p>
              <p><strong>Monitor URL:</strong> 
                <a href="\${data.monitor_url}" target="_blank">View Progress</a>
              </p>
              <p><strong>Status:</strong> 
                <a href="#" onclick="checkJobStatus('\${data.jobId}'); return false;" style="color: #667eea;">Check Status Now</a>
              </p>
              <p><small>Note: Scraping may take several minutes depending on website size</small></p>
            \`;
            showResult('scrapeResult', html, 'success');
          } else {
            showResult('scrapeResult', \`Error: \${data.error}\`, 'error');
          }
        } catch (error) {
          showResult('scrapeResult', \`Error: \${error.message}\`, 'error');
        }
      }
      
      async function checkJobStatus(jobId) {
        const resultDiv = document.getElementById('scrapeResult');
        showResult('scrapeResult', 'Checking job status...', '');
        
        try {
          const response = await fetch(baseUrl + '/api/scrape/status/' + jobId);
          const data = await response.json();
          
          if (data.success) {
            let html = \`<h3>🔍 Job Status: \${data.result?.status || data.progress?.status || 'unknown'}</h3>\`;
            
            if (data.progress) {
              html += \`
                <p><strong>Pages Scraped:</strong> \${data.progress.pages_scraped || 0}</p>
                <p><strong>Videos Found:</strong> \${data.progress.videos_found || 0}</p>
                <p><strong>Videos Downloaded:</strong> \${data.progress.videos_downloaded || 0}</p>
                <p><strong>Status:</strong> \${data.progress.status || 'running'}</p>
              \`;
            }
            
            if (data.files && data.files.length > 0) {
              html += \`<h4>Downloaded Files:</h4><ul>\`;
              data.files.forEach(file => {
                html += \`<li><a href="\${file.url}" target="_blank">\${file.name}</a> (\${formatFileSize(file.size)})</li>\`;
              });
              html += \`</ul>\`;
            }
            
            showResult('scrapeResult', html, 'success');
          } else {
            showResult('scrapeResult', \`Error: \${data.error}\`, 'error');
          }
        } catch (error) {
          showResult('scrapeResult', \`Error: \${error.message}\`, 'error');
        }
      }
      
      async function testSystem() {
        // Test with Rick Astley - Never Gonna Give You Up
        document.getElementById('youtubeUrlMp3').value = 'https://youtu.be/dQw4w9WgXcQ';
        document.getElementById('youtubeUrlMp4').value = 'https://youtu.be/dQw4w9WgXcQ';
        document.getElementById('scrapeUrl').value = 'https://ssvid.net';
        
        switchTab('youtube');
        showResult('youtubeResult', 'Testing system with sample video...', '');
        
        // Test MP3 download
        setTimeout(() => {
          downloadYouTube('mp3');
        }, 1000);
      }
      
      function showResult(elementId, message, type) {
        const element = document.getElementById(elementId);
        element.innerHTML = message;
        element.className = 'result';
        if (type) {
          element.classList.add(type);
        }
        element.style.display = 'block';
      }
      
      function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' bytes';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      }
      
      // Initialize with some example URLs
      window.onload = () => {
        document.getElementById('youtubeUrlMp3').value = 'https://youtu.be/dQw4w9WgXcQ';
        document.getElementById('youtubeUrlMp4').value = 'https://youtu.be/dQw4w9WgXcQ';
      };
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
    },
    endpoints: {
      youtube_mp3: `/api/download/youtube-mp3?apikey=bera&url=YOUTUBE_URL`,
      youtube_mp4: `/api/download/youtube-mp4?apikey=bera&url=YOUTUBE_URL`,
      scrape_start: `POST /api/scrape/start`,
      scrape_status: `GET /api/scrape/status/:jobId`,
      file_download: `GET /api/download/file/:fileId`
    }
  });
});

// Home page
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
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

📂 Directories created:
   Downloads: ${downloadsDir}
   Scraped Data: ${scrapedDataDir}
   Python Scraper: ${pythonDir}

⚡ Ready to process requests...
`);
});
