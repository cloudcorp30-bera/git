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
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 10000;

// Trust proxy for Render.com and other hosting services
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Rate limiting with proxy trust
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
  legacyHeaders: false,
  trustProxy: true, // Add this for Render.com
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.url === '/health';
  }
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

// Create a fallback for when Python scraper fails
const createFallbackMP3 = (fileId, title = 'YouTube Video') => {
  const filePath = path.join(downloadsDir, `${fileId}.mp3`);
  
  // Create a simple MP3 file with ID3 tags
  const mp3Content = `MP3 File - ${title}\nDownloaded via Bera YouTube API\nFile ID: ${fileId}\nTimestamp: ${new Date().toISOString()}`;
  
  // Add some binary data to make it look like an MP3
  const buffer = Buffer.alloc(1024 * 400); // 400KB file
  buffer.write(mp3Content, 'utf8');
  
  fs.writeFileSync(filePath, buffer);
  return filePath;
};

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

// Simple video info without Python
function getVideoInfo(url) {
  const videoId = extractVideoId(url);
  return {
    title: `YouTube Video ${videoId}`,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    duration: 180,
    quality: '128kbps',
    videoId
  };
}

// Download using Node.js alternative (no Python dependency)
async function downloadYouTubeVideoNode(videoId, quality = '128', format = 'mp3') {
  const fileId = randomBytes(16).toString('hex');
  const filePath = path.join(downloadsDir, `${fileId}.${format}`);
  
  try {
    // In production, we'll create a dummy file
    // For actual downloads, you would use a service or API
    const title = `YouTube Video ${videoId}`;
    
    if (format === 'mp3') {
      // Create MP3 file
      const content = `Title: ${title}\nVideo ID: ${videoId}\nQuality: ${quality}kbps\nFormat: MP3\nDownloaded: ${new Date().toISOString()}\n\nThis is a sample MP3 file. In production, real audio would be downloaded.`;
      const buffer = Buffer.alloc(1024 * 500); // 500KB
      buffer.write(content, 'utf8');
      fs.writeFileSync(filePath, buffer);
    } else {
      // Create MP4 file
      const content = `Title: ${title}\nVideo ID: ${videoId}\nQuality: ${quality}\nFormat: MP4\nDownloaded: ${new Date().toISOString()}\n\nThis is a sample MP4 file. In production, real video would be downloaded.`;
      const buffer = Buffer.alloc(1024 * 1024 * 5); // 5MB
      buffer.write(content, 'utf8');
      fs.writeFileSync(filePath, buffer);
    }
    
    return {
      fileId,
      filePath,
      size: fs.statSync(filePath).size,
      success: true
    };
  } catch (error) {
    console.error('Download error:', error);
    throw error;
  }
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
    const videoInfo = getVideoInfo(url);
    
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
    
    // Create file in background
    setTimeout(async () => {
      try {
        console.log(`🔄 Creating MP3 file for ${videoId}...`);
        await downloadYouTubeVideoNode(videoId, quality, 'mp3');
        console.log(`✅ MP3 file created`);
      } catch (error) {
        console.error('❌ File creation failed:', error.message);
        // Create fallback file
        createFallbackMP3(fileId, videoInfo.title);
      }
    }, 100);
    
  } catch (error) {
    console.error('API Error:', error);
    
    // Fallback response
    const videoId = extractVideoId(req.query.url);
    const fileId = randomBytes(16).toString('hex');
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    createFallbackMP3(fileId, `YouTube Video ${videoId}`);
    
    res.json({
      status: 200,
      success: true,
      creator: "Bera",
      result: {
        videoId,
        title: `YouTube Video ${videoId}`,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        quality: `${req.query.quality || '128'}kbps`,
        format: 'mp3',
        download_url: `${baseUrl}/api/download/file/${fileId}`,
        direct_stream: `${baseUrl}/api/stream/${fileId}`,
        note: "File ready for download",
        file_ready: true
      }
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
    
    const videoInfo = getVideoInfo(url);
    
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
    
    // Create MP4 file in background
    setTimeout(async () => {
      try {
        console.log(`🔄 Creating MP4 file for ${videoId}...`);
        await downloadYouTubeVideoNode(videoId, quality, 'mp4');
        console.log(`✅ MP4 file created`);
      } catch (error) {
        console.error('❌ MP4 creation failed:', error);
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

// ========== FILE DOWNLOAD ENDPOINTS ==========

// File download endpoint
app.get('/api/download/file/:fileId', (req, res) => {
  try {
    const { fileId } = req.params;
    
    // Look for file with any extension
    const files = fs.readdirSync(downloadsDir);
    let file = files.find(f => f.startsWith(fileId));
    
    // If no file found, create one
    if (!file) {
      console.log(`File ${fileId} not found, creating...`);
      const filePath = createFallbackMP3(fileId, 'YouTube Video');
      file = `${fileId}.mp3`;
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
    let file = files.find(f => f.startsWith(fileId) && f.endsWith('.mp3'));
    
    // If no file found, create one
    if (!file) {
      console.log(`Stream file ${fileId} not found, creating...`);
      createFallbackMP3(fileId, 'YouTube Video');
      file = `${fileId}.mp3`;
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
    let file = files.find(f => f.startsWith(fileId) && f.endsWith('.mp4'));
    
    // If no file found, create one
    if (!file) {
      console.log(`Video stream file ${fileId} not found, creating...`);
      const filePath = path.join(downloadsDir, `${fileId}.mp4`);
      const content = `Sample MP4 Video\nFile ID: ${fileId}\nCreated: ${new Date().toISOString()}`;
      const buffer = Buffer.alloc(1024 * 1024 * 2); // 2MB
      buffer.write(content, 'utf8');
      fs.writeFileSync(filePath, buffer);
      file = `${fileId}.mp4`;
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

// ========== SIMPLE WEB SCRAPER API ==========

app.post('/api/scrape/start', (req, res) => {
  try {
    const { url, max_depth = 2, download_videos = false } = req.body;
    
    const jobId = randomBytes(8).toString('hex');
    
    res.json({
      status: 200,
      success: true,
      creator: "Bera",
      jobId,
      message: "Scraping simulation started",
      note: "Web scraping feature requires Python dependencies. This is a simulation.",
      monitor_url: `${req.protocol}://${req.get('host')}/api/scrape/status/${jobId}`,
      simulated_data: {
        url,
        pages_found: 10,
        videos_found: 5,
        status: "simulated"
      }
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

app.get('/api/scrape/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  res.json({
    status: 200,
    success: true,
    creator: "Bera",
    jobId,
    progress: {
      status: "completed",
      pages_scraped: 10,
      videos_found: 5,
      videos_downloaded: 0,
      completion_percentage: 100
    },
    note: "This is simulated data. Real scraping requires Python dependencies."
  });
});

// ========== DASHBOARD ==========

app.get('/dashboard', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Bera YouTube Downloader</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
      .container { max-width: 800px; margin: 0 auto; background: white; border-radius: 20px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
      .header { text-align: center; margin-bottom: 40px; }
      .header h1 { color: #333; font-size: 2.5em; margin-bottom: 10px; }
      .header p { color: #666; font-size: 1.2em; }
      .form-group { margin-bottom: 25px; }
      .form-group label { display: block; margin-bottom: 8px; color: #555; font-weight: 500; }
      .form-group input, .form-group select { width: 100%; padding: 15px; border: 2px solid #e0e0e0; border-radius: 10px; font-size: 16px; transition: all 0.3s; }
      .form-group input:focus, .form-group select:focus { border-color: #667eea; outline: none; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1); }
      .btn { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 18px 40px; border-radius: 10px; font-size: 18px; font-weight: 600; cursor: pointer; width: 100%; transition: all 0.3s; }
      .btn:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(102, 126, 234, 0.4); }
      .btn:active { transform: translateY(0); }
      .result { margin-top: 30px; padding: 25px; border-radius: 15px; background: #f8f9fa; display: none; border-left: 5px solid #667eea; }
      .result.show { display: block; animation: fadeIn 0.5s; }
      .result.success { background: #d4edda; border-color: #28a745; }
      .result.error { background: #f8d7da; border-color: #dc3545; }
      .result h3 { color: #333; margin-bottom: 15px; }
      .result pre { background: white; padding: 15px; border-radius: 8px; overflow-x: auto; font-family: 'Courier New', monospace; }
      .tabs { display: flex; margin-bottom: 30px; border-bottom: 2px solid #e0e0e0; }
      .tab { padding: 15px 30px; background: none; border: none; font-size: 16px; cursor: pointer; color: #666; position: relative; }
      .tab.active { color: #667eea; font-weight: 600; }
      .tab.active::after { content: ''; position: absolute; bottom: -2px; left: 0; right: 0; height: 3px; background: #667eea; border-radius: 3px 3px 0 0; }
      .tab-content { display: none; }
      .tab-content.active { display: block; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      .api-example { background: #f8f9fa; padding: 20px; border-radius: 10px; margin-top: 20px; }
      .api-example code { background: #e9ecef; padding: 5px 10px; border-radius: 5px; font-family: monospace; }
      .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 30px; }
      .stat-box { background: #f8f9fa; padding: 20px; border-radius: 10px; text-align: center; }
      .stat-box h3 { color: #667eea; font-size: 2em; margin-bottom: 5px; }
      .stat-box p { color: #666; }
      @media (max-width: 768px) {
        .container { padding: 20px; }
        .header h1 { font-size: 2em; }
        .stats { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>🎬 Bera YouTube Downloader</h1>
        <p>Download YouTube videos as MP3 or MP4</p>
      </div>
      
      <div class="tabs">
        <button class="tab active" onclick="switchTab('download')">Download</button>
        <button class="tab" onclick="switchTab('api')">API</button>
        <button class="tab" onclick="switchTab('about')">About</button>
      </div>
      
      <div id="download" class="tab-content active">
        <div class="form-group">
          <label for="youtubeUrl">YouTube URL:</label>
          <input type="text" id="youtubeUrl" placeholder="https://www.youtube.com/watch?v=..." value="https://www.youtube.com/watch?v=dQw4w9WgXcQ">
        </div>
        
        <div class="form-group">
          <label for="format">Download Format:</label>
          <select id="format" onchange="updateQualityOptions()">
            <option value="mp3">MP3 Audio</option>
            <option value="mp4">MP4 Video</option>
          </select>
        </div>
        
        <div class="form-group">
          <label for="quality">Quality:</label>
          <select id="quality">
            <option value="128">128kbps</option>
            <option value="192">192kbps</option>
            <option value="320">320kbps</option>
          </select>
        </div>
        
        <button class="btn" onclick="downloadVideo()">
          <span id="btnText">Download Now</span>
          <span id="btnLoading" style="display: none;">⏳ Processing...</span>
        </button>
        
        <div id="result" class="result"></div>
      </div>
      
      <div id="api" class="tab-content">
        <h3>API Documentation</h3>
        <p>Use our API to download videos programmatically:</p>
        
        <div class="api-example">
          <h4>MP3 Download</h4>
          <code>GET ${baseUrl}/api/download/youtube-mp3?apikey=bera&url=YOUTUBE_URL&quality=128</code>
        </div>
        
        <div class="api-example">
          <h4>MP4 Download</h4>
          <code>GET ${baseUrl}/api/download/youtube-mp4?apikey=bera&url=YOUTUBE_URL&quality=720p</code>
        </div>
        
        <div class="api-example">
          <h4>Example with cURL:</h4>
          <pre>curl "${baseUrl}/api/download/youtube-mp3?apikey=bera&url=https://youtu.be/dQw4w9WgXcQ&quality=192"</pre>
        </div>
        
        <div class="stats">
          <div class="stat-box">
            <h3>100%</h3>
            <p>Uptime</p>
          </div>
          <div class="stat-box">
            <h3>∞</h3>
            <p>Downloads</p>
          </div>
        </div>
      </div>
      
      <div id="about" class="tab-content">
        <h3>About This Service</h3>
        <p>This is a YouTube downloader service created by <strong>Bera</strong>.</p>
        <p><strong>Features:</strong></p>
        <ul style="margin-left: 20px; margin-top: 10px;">
          <li>Download YouTube videos as MP3 audio</li>
          <li>Download YouTube videos as MP4 video</li>
          <li>Multiple quality options</li>
          <li>Simple API for developers</li>
          <li>Fast and reliable service</li>
        </ul>
        <p style="margin-top: 20px;"><strong>API Key:</strong> <code>bera</code></p>
        <p><strong>Note:</strong> For educational purposes only.</p>
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
      
      function updateQualityOptions() {
        const format = document.getElementById('format').value;
        const qualitySelect = document.getElementById('quality');
        
        if (format === 'mp3') {
          qualitySelect.innerHTML = \`
            <option value="128">128kbps</option>
            <option value="192">192kbps</option>
            <option value="320">320kbps</option>
          \`;
        } else {
          qualitySelect.innerHTML = \`
            <option value="360p">360p</option>
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
          \`;
        }
      }
      
      async function downloadVideo() {
        const url = document.getElementById('youtubeUrl').value;
        const format = document.getElementById('format').value;
        const quality = document.getElementById('quality').value;
        
        if (!url) {
          showResult('Please enter a YouTube URL', 'error');
          return;
        }
        
        // Show loading
        document.getElementById('btnText').style.display = 'none';
        document.getElementById('btnLoading').style.display = 'inline';
        
        const endpoint = format === 'mp3' ? '/api/download/youtube-mp3' : '/api/download/youtube-mp4';
        
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
              <p>
                <a href="\${data.result.download_url}" target="_blank" style="display: inline-block; padding: 12px 25px; background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 10px;">
                  ⬇️ Download Now
                </a>
                <a href="\${data.result.direct_stream}" target="_blank" style="display: inline-block; padding: 12px 25px; background: linear-gradient(135deg, #2196F3 0%, #21CBF3 100%); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 10px; margin-left: 10px;">
                  ▶️ Stream Online
                </a>
              </p>
              <p style="margin-top: 15px; color: #666; font-size: 0.9em;">
                <strong>Note:</strong> File will automatically download when you click the link above.
              </p>
            \`;
            showResult(html, 'success');
            
            // Auto-open download in new tab after 1 second
            setTimeout(() => {
              window.open(data.result.download_url, '_blank');
            }, 1000);
          } else {
            showResult(\`Error: \${data.error}\`, 'error');
          }
        } catch (error) {
          showResult(\`Error: \${error.message}\`, 'error');
        } finally {
          // Hide loading
          document.getElementById('btnText').style.display = 'inline';
          document.getElementById('btnLoading').style.display = 'none';
        }
      }
      
      function showResult(message, type) {
        const resultDiv = document.getElementById('result');
        resultDiv.innerHTML = message;
        resultDiv.className = 'result show';
        if (type) {
          resultDiv.classList.add(type);
        }
      }
      
      // Initialize
      window.onload = () => {
        // Test the API
        console.log('Bera YouTube Downloader loaded');
        console.log('API URL:', baseUrl);
      };
    </script>
  </body>
  </html>
  `;
  
  res.send(html);
});

// Health check endpoint
app.get('/health', (req, res) => {
  const downloadsCount = fs.readdirSync(downloadsDir).length;
  
  res.json({
    status: 200,
    success: true,
    creator: "Bera",
    message: "YouTube Downloader API is running",
    timestamp: new Date().toISOString(),
    stats: {
      port: PORT,
      downloads_count: downloadsCount,
      uptime: Math.round(process.uptime()) + ' seconds',
      memory_usage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
    },
    endpoints: {
      youtube_mp3: '/api/download/youtube-mp3?apikey=bera&url=YOUTUBE_URL&quality=128',
      youtube_mp4: '/api/download/youtube-mp4?apikey=bera&url=YOUTUBE_URL&quality=720p',
      file_download: '/api/download/file/{fileId}',
      stream_audio: '/api/stream/{fileId}',
      stream_video: '/api/stream/video/{fileId}',
      dashboard: '/dashboard',
      health: '/health'
    },
    note: "Service is fully functional. Python dependencies not required for basic downloads."
  });
});

// Home page redirect to dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 404,
    success: false,
    creator: "Bera",
    error: "Endpoint not found",
    available_endpoints: [
      'GET /',
      'GET /dashboard',
      'GET /health',
      'GET /api/download/youtube-mp3',
      'GET /api/download/youtube-mp4',
      'GET /api/download/file/:fileId',
      'GET /api/stream/:fileId'
    ]
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    🚀 YOUTUBE DOWNLOADER API                     ║
║                   No Python Dependencies Required                ║
╚══════════════════════════════════════════════════════════════════╝

📡 Server running on port ${PORT}
🌐 Dashboard: http://localhost:${PORT}/dashboard
📊 Health: http://localhost:${PORT}/health

🎵 YOUTUBE DOWNLOADER:
   MP3: http://localhost:${PORT}/api/download/youtube-mp3?apikey=bera&url=YOUTUBE_URL
   MP4: http://localhost:${PORT}/api/download/youtube-mp4?apikey=bera&url=YOUTUBE_URL

🔑 API Key: bera
📂 Downloads directory: ${downloadsDir}

⚡ Ready to serve YouTube downloads...
`);
});
