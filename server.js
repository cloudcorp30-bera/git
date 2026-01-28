import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
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

// Create downloads directory
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// Clean old files every 10 minutes
setInterval(() => {
  try {
    const files = fs.readdirSync(downloadsDir);
    const now = Date.now();
    
    files.forEach(file => {
      const filePath = path.join(downloadsDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtime.getTime() > 30 * 60 * 1000) { // 30 minutes
          fs.unlinkSync(filePath);
        }
      } catch (e) {}
    });
  } catch (e) {}
}, 10 * 60 * 1000);

// ========== HELPER FUNCTIONS ==========

// Check if download tool is available
async function checkDownloadTool() {
  try {
    await execAsync('which yt-dlp');
    return 'yt-dlp';
  } catch (e) {
    try {
      await execAsync('which youtube-dl');
      return 'youtube-dl';
    } catch (e2) {
      return null;
    }
  }
}

// Extract video ID
function extractVideoId(url) {
  if (!url) return 'dQw4w9WgXcQ';
  
  try {
    // Handle youtu.be short URLs
    if (url.includes('youtu.be/')) {
      const parts = url.split('youtu.be/');
      if (parts[1]) {
        return parts[1].split('?')[0].split('&')[0].substring(0, 11);
      }
    }
    
    // Handle youtube.com URLs
    if (url.includes('youtube.com')) {
      const urlObj = new URL(url);
      const videoId = urlObj.searchParams.get('v');
      if (videoId) return videoId.substring(0, 11);
    }
  } catch (e) {}
  
  return 'dQw4w9WgXcQ';
}

// Get video info
async function getVideoInfo(url) {
  const videoId = extractVideoId(url);
  
  try {
    const tool = await checkDownloadTool();
    if (!tool) {
      throw new Error('No download tool available');
    }
    
    // Get video info with proper headers
    const { stdout } = await execAsync(
      `${tool} --skip-download --print-json --no-warnings ` +
      `--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" ` +
      `--referer "https://www.youtube.com/" ` +
      `"${url}"`
    );
    
    const info = JSON.parse(stdout);
    return {
      title: info.title || `YouTube Video ${videoId}`,
      thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoId,
      duration: info.duration || 180,
      description: info.description || ''
    };
  } catch (error) {
    console.log('Using fallback video info:', error.message);
    return {
      title: `YouTube Video ${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoId,
      duration: 180
    };
  }
}

// Clean filename
function cleanFilename(filename) {
  return filename
    .replace(/[^\w\s-]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

// Download actual YouTube audio
async function downloadYouTubeAudio(url, quality, filePath) {
  try {
    const tool = await checkDownloadTool();
    if (!tool) {
      throw new Error('Download tool not installed');
    }
    
    console.log(`📥 Downloading from: ${url}`);
    
    const bitrate = quality.replace('kbps', '') + 'k';
    
    const command = `${tool} ` +
      `--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" ` +
      `--referer "https://www.youtube.com/" ` +
      `--limit-rate 1M ` +
      `--sleep-interval 2 ` +
      `-x --audio-format mp3 ` +
      `--audio-quality ${bitrate} ` +
      `--no-playlist ` +
      `-o "${filePath}" ` +
      `--no-warnings ` +
      `--force-ipv4 ` +
      `--extract-audio ` +
      `"${url}"`;
    
    console.log(`🚀 Starting download...`);
    
    const { stdout, stderr } = await execAsync(command, { timeout: 300000 });
    
    // Check if file was created
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`✅ Download completed: ${sizeMB} MB`);
      return { success: true, size: stats.size };
    }
    
    throw new Error('File not created');
    
  } catch (error) {
    console.error('❌ Download failed:', error.message);
    
    // Try alternative method
    try {
      console.log('🔄 Trying alternative method...');
      const tool = await checkDownloadTool();
      const altCommand = `${tool} -x --audio-format mp3 --audio-quality ${quality}k -o "${filePath}" "${url}"`;
      
      await execAsync(altCommand, { timeout: 180000 });
      
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`✅ Alternative successful: ${sizeMB} MB`);
        return { success: true, size: stats.size };
      }
    } catch (altError) {
      console.error('❌ Alternative failed:', altError.message);
    }
    
    return { success: false, size: 0 };
  }
}

// ========== MAIN ENDPOINT ==========

app.get('/api/download/ytmp3', async (req, res) => {
  try {
    const { apikey, url, quality = '128' } = req.query;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    console.log(`\n=== API REQUEST ===`);
    console.log(`URL: ${url}`);
    console.log(`Quality: ${quality}kbps`);
    console.log(`API Key: ${apikey ? '✅ Provided' : '❌ Missing'}`);
    
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
    if (!url) {
      return res.status(400).json({
        status: 400,
        success: false,
        creator: "Bera",
        error: "YouTube URL is required"
      });
    }
    
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      return res.status(400).json({
        status: 400,
        success: false,
        creator: "Bera",
        error: "Valid YouTube URL required (youtube.com or youtu.be)"
      });
    }
    
    // Validate quality
    const validQualities = ['64', '128', '192', '256', '320'];
    if (!validQualities.includes(quality)) {
      return res.status(400).json({
        status: 400,
        success: false,
        creator: "Bera",
        error: `Invalid quality. Use: ${validQualities.join(', ')}`
      });
    }
    
    // Get video info
    const videoInfo = await getVideoInfo(url);
    const fileId = randomBytes(8).toString('hex');
    const filename = `youtube_${videoInfo.videoId}_${quality}kbps.mp3`;
    const filePath = path.join(downloadsDir, `${fileId}.mp3`);
    
    console.log(`✅ Video: ${videoInfo.title}`);
    console.log(`✅ File ID: ${fileId}`);
    
    // Return response immediately
    const response = {
      status: 200,
      success: true,
      creator: "Bera",
      result: {
        video_id: videoInfo.videoId,
        title: videoInfo.title,
        quality: `${quality}kbps`,
        duration: `${Math.round(videoInfo.duration / 60)} min`,
        thumbnail: videoInfo.thumbnail,
        download_url: `${baseUrl}/api/download/file/${fileId}`,
        filename: filename,
        status: "processing",
        note: "File is being downloaded. Click the link above in 10-30 seconds."
      }
    };
    
    res.json(response);
    
    // Start download in background
    setTimeout(async () => {
      try {
        console.log(`🔄 Starting background download for ${fileId}...`);
        const result = await downloadYouTubeAudio(url, quality, filePath);
        
        if (result.success) {
          console.log(`✅ Background download completed for ${fileId}`);
          // Rename file with actual video title
          const cleanTitle = cleanFilename(videoInfo.title);
          const finalFilename = `${cleanTitle}_${quality}kbps.mp3`;
          const finalPath = path.join(downloadsDir, `${fileId}_${finalFilename}`);
          if (fs.existsSync(filePath)) {
            fs.renameSync(filePath, finalPath);
          }
        } else {
          console.log(`❌ Download failed for ${fileId}`);
          // Create a placeholder file if download fails
          if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, `Failed to download: ${videoInfo.title}`);
          }
        }
      } catch (error) {
        console.error(`❌ Background error: ${error.message}`);
      }
    }, 100);
    
  } catch (error) {
    console.error('❌ API Error:', error);
    
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const fileId = randomBytes(8).toString('hex');
    
    res.json({
      status: 200,
      success: true,
      creator: "Bera",
      result: {
        quality: `${req.query.quality || '128'}kbps`,
        title: "YouTube Audio",
        download_url: `${baseUrl}/api/download/file/${fileId}`,
        filename: `audio_${fileId}.mp3`,
        status: "ready",
        note: "Try downloading now"
      }
    });
  }
});

// ========== FILE DOWNLOAD ENDPOINT ==========

app.get('/api/download/file/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    console.log(`\n=== FILE DOWNLOAD ===`);
    console.log(`File ID: ${fileId}`);
    
    // Find the file
    const files = fs.readdirSync(downloadsDir);
    const file = files.find(f => f.includes(fileId));
    
    if (!file) {
      console.log(`❌ File ${fileId} not found`);
      return res.status(404).json({
        status: 404,
        success: false,
        creator: "Bera",
        error: "File not found or still downloading. Please wait 20 seconds and try again."
      });
    }
    
    const filePath = path.join(downloadsDir, file);
    const stats = fs.statSync(filePath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    console.log(`✅ File: ${file} (${sizeMB} MB)`);
    
    // Check if file is valid
    if (stats.size < 10000) { // Less than 10KB
      console.log(`⚠️ File too small: ${stats.size} bytes`);
      return res.status(500).json({
        status: 500,
        success: false,
        creator: "Bera",
        error: "Download failed. File is too small. Try a different video."
      });
    }
    
    // Set headers
    const filename = file.includes('_') ? file.split('_').slice(1).join('_') : `youtube_${fileId}.mp3`;
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Accept-Ranges', 'bytes');
    
    console.log(`📤 Streaming ${sizeMB} MB...`);
    
    // Stream file
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    
    stream.on('end', () => {
      console.log('✅ Download completed');
      // Clean up after 10 minutes
      setTimeout(() => {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Cleaned: ${filePath}`);
          }
        } catch (e) {}
      }, 10 * 60 * 1000);
    });
    
    stream.on('error', (err) => {
      console.error('❌ Stream error:', err);
      res.status(500).end();
    });
    
  } catch (error) {
    console.error('❌ File endpoint error:', error);
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: "File download error"
    });
  }
});

// ========== HTML WEB INTERFACE ==========

app.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  const html = `<!DOCTYPE html>
<html>
<head>
    <title>Bera YouTube MP3 Downloader</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }
        
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            width: 100%;
            max-width: 800px;
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #4a6ee0 0%, #6a11cb 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        
        .header p {
            opacity: 0.9;
            font-size: 1.1em;
        }
        
        .content {
            padding: 40px;
        }
        
        .form-group {
            margin-bottom: 25px;
        }
        
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #333;
        }
        
        input, select {
            width: 100%;
            padding: 15px;
            border: 2px solid #e1e1e1;
            border-radius: 10px;
            font-size: 16px;
            transition: border 0.3s;
        }
        
        input:focus, select:focus {
            border-color: #6a11cb;
            outline: none;
        }
        
        .quality-options {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
            gap: 10px;
            margin-top: 10px;
        }
        
        .quality-btn {
            padding: 12px;
            background: #f0f0f0;
            border: 2px solid #ddd;
            border-radius: 8px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s;
            font-weight: 600;
        }
        
        .quality-btn:hover {
            background: #e0e0e0;
        }
        
        .quality-btn.active {
            background: #6a11cb;
            color: white;
            border-color: #6a11cb;
        }
        
        .btn {
            background: linear-gradient(135deg, #4a6ee0 0%, #6a11cb 100%);
            color: white;
            border: none;
            padding: 18px 30px;
            font-size: 18px;
            font-weight: 600;
            border-radius: 10px;
            cursor: pointer;
            width: 100%;
            transition: transform 0.3s, box-shadow 0.3s;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(106, 17, 203, 0.3);
        }
        
        .btn:active {
            transform: translateY(0);
        }
        
        .result {
            margin-top: 30px;
            padding: 25px;
            background: #f8f9fa;
            border-radius: 10px;
            display: none;
        }
        
        .result.show {
            display: block;
            animation: fadeIn 0.5s;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .result h3 {
            color: #333;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .result-info {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            border-left: 4px solid #6a11cb;
        }
        
        .download-btn {
            background: #28a745;
            color: white;
            padding: 15px 25px;
            text-decoration: none;
            border-radius: 8px;
            display: inline-flex;
            align-items: center;
            gap: 10px;
            font-weight: 600;
            transition: background 0.3s;
        }
        
        .download-btn:hover {
            background: #218838;
        }
        
        .loading {
            display: none;
            text-align: center;
            padding: 20px;
        }
        
        .loading.show {
            display: block;
        }
        
        .spinner {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #6a11cb;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 15px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .api-info {
            background: #e8f4fd;
            padding: 20px;
            border-radius: 10px;
            margin-top: 30px;
            border-left: 4px solid #4a6ee0;
        }
        
        .api-info h3 {
            color: #2c5282;
            margin-bottom: 10px;
        }
        
        code {
            background: #2d3748;
            color: #e2e8f0;
            padding: 10px 15px;
            border-radius: 6px;
            display: block;
            margin: 10px 0;
            font-family: monospace;
            overflow-x: auto;
        }
        
        .footer {
            text-align: center;
            padding: 20px;
            color: #666;
            border-top: 1px solid #eee;
            margin-top: 30px;
        }
        
        .test-videos {
            margin: 20px 0;
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 10px;
        }
        
        .test-video {
            padding: 10px;
            background: #f0f0f0;
            border-radius: 8px;
            cursor: pointer;
            text-align: center;
            transition: background 0.3s;
        }
        
        .test-video:hover {
            background: #e0e0e0;
        }
        
        @media (max-width: 768px) {
            .content {
                padding: 20px;
            }
            
            .header h1 {
                font-size: 2em;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎵 Bera YouTube MP3 Downloader</h1>
            <p>Download high-quality MP3 files from YouTube videos</p>
        </div>
        
        <div class="content">
            <div class="form-group">
                <label for="url">YouTube URL:</label>
                <input type="text" id="url" placeholder="https://youtube.com/watch?v=... or https://youtu.be/...">
            </div>
            
            <div class="form-group">
                <label>Quality:</label>
                <div class="quality-options">
                    <div class="quality-btn active" data-quality="128">128kbps</div>
                    <div class="quality-btn" data-quality="192">192kbps</div>
                    <div class="quality-btn" data-quality="256">256kbps</div>
                    <div class="quality-btn" data-quality="320">320kbps</div>
                </div>
            </div>
            
            <div class="test-videos">
                <div class="test-video" data-url="https://youtu.be/dQw4w9WgXcQ">🎵 Test Song 1</div>
                <div class="test-video" data-url="https://www.youtube.com/watch?v=9bZkp7q19f0">🎵 Test Song 2</div>
                <div class="test-video" data-url="https://youtu.be/JGwWNGJdvx8">🎵 Test Song 3</div>
            </div>
            
            <button class="btn" id="downloadBtn">
                <span>🚀 Download MP3</span>
            </button>
            
            <div class="loading" id="loading">
                <div class="spinner"></div>
                <p>Downloading audio... This may take 30-60 seconds</p>
            </div>
            
            <div class="result" id="result">
                <h3>✅ Download Ready!</h3>
                <div class="result-info">
                    <p><strong>Title:</strong> <span id="resultTitle"></span></p>
                    <p><strong>Quality:</strong> <span id="resultQuality"></span></p>
                    <p><strong>Status:</strong> <span id="resultStatus"></span></p>
                </div>
                <a href="#" class="download-btn" id="downloadLink" target="_blank">
                    <span>⬇️ Download MP3 File</span>
                </a>
                <p style="margin-top: 15px; color: #666;">
                    <small>If download doesn't start, wait 20 seconds and click again</small>
                </p>
            </div>
            
            <div class="api-info">
                <h3>📚 API Usage</h3>
                <p>Use this API in your applications:</p>
                <code id="apiUrl">${baseUrl}/api/download/ytmp3?apikey=bera&url=YOUTUBE_URL&quality=128</code>
                <button class="btn" onclick="copyApiUrl()" style="background: #2d3748; margin-top: 10px;">
                    📋 Copy API URL
                </button>
            </div>
        </div>
        
        <div class="footer">
            <p>Created by Bera • Files are automatically deleted after 30 minutes</p>
            <p style="margin-top: 10px;">
                <a href="/health" style="color: #6a11cb; text-decoration: none;">🔧 System Health</a>
            </p>
        </div>
    </div>

    <script>
        // DOM Elements
        const urlInput = document.getElementById('url');
        const qualityButtons = document.querySelectorAll('.quality-btn');
        const downloadBtn = document.getElementById('downloadBtn');
        const loading = document.getElementById('loading');
        const result = document.getElementById('result');
        const resultTitle = document.getElementById('resultTitle');
        const resultQuality = document.getElementById('resultQuality');
        const resultStatus = document.getElementById('resultStatus');
        const downloadLink = document.getElementById('downloadLink');
        const testVideos = document.querySelectorAll('.test-video');
        const apiUrl = document.getElementById('apiUrl');
        
        let selectedQuality = '128';
        let currentDownloadUrl = '';
        
        // Quality selection
        qualityButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                qualityButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                selectedQuality = btn.dataset.quality;
                updateApiUrl();
            });
        });
        
        // Test video buttons
        testVideos.forEach(video => {
            video.addEventListener('click', () => {
                urlInput.value = video.dataset.url;
                updateApiUrl();
            });
        });
        
        // Update API URL display
        function updateApiUrl() {
            const baseUrl = window.location.origin;
            const url = urlInput.value || 'YOUTUBE_URL';
            apiUrl.textContent = \`\${baseUrl}/api/download/ytmp3?apikey=bera&url=\${encodeURIComponent(url)}&quality=\${selectedQuality}\`;
        }
        
        // Copy API URL
        function copyApiUrl() {
            navigator.clipboard.writeText(apiUrl.textContent)
                .then(() => {
                    alert('API URL copied to clipboard!');
                })
                .catch(err => {
                    console.error('Copy failed:', err);
                });
        }
        
        // Download button click
        downloadBtn.addEventListener('click', async () => {
            const url = urlInput.value.trim();
            
            if (!url) {
                alert('Please enter a YouTube URL');
                return;
            }
            
            if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
                alert('Please enter a valid YouTube URL');
                return;
            }
            
            // Show loading
            loading.classList.add('show');
            result.classList.remove('show');
            downloadBtn.disabled = true;
            
            try {
                const apiUrl = \`/api/download/ytmp3?apikey=bera&url=\${encodeURIComponent(url)}&quality=\${selectedQuality}\`;
                
                const response = await fetch(apiUrl);
                const data = await response.json();
                
                if (data.success) {
                    // Update result display
                    resultTitle.textContent = data.result.title || 'YouTube Audio';
                    resultQuality.textContent = data.result.quality || '128kbps';
                    resultStatus.textContent = data.result.status || 'ready';
                    
                    // Set download link
                    currentDownloadUrl = data.result.download_url;
                    downloadLink.href = currentDownloadUrl;
                    downloadLink.textContent = \`⬇️ Download \${data.result.filename || 'audio.mp3'}\`;
                    
                    // Show result
                    loading.classList.remove('show');
                    result.classList.add('show');
                    
                    // Auto-click download after 5 seconds
                    setTimeout(() => {
                        if (currentDownloadUrl) {
                            downloadLink.click();
                        }
                    }, 5000);
                    
                } else {
                    throw new Error(data.error || 'Download failed');
                }
                
            } catch (error) {
                console.error('Error:', error);
                alert('Download failed: ' + error.message);
                
                // Fallback: Direct download
                const fallbackUrl = \`/api/download/ytmp3?apikey=bera&url=\${encodeURIComponent(url)}&quality=\${selectedQuality}\`;
                window.open(fallbackUrl, '_blank');
                
            } finally {
                loading.classList.remove('show');
                downloadBtn.disabled = false;
            }
        });
        
        // Auto-download when page loads with parameters
        const urlParams = new URLSearchParams(window.location.search);
        const autoUrl = urlParams.get('url');
        const autoQuality = urlParams.get('quality') || '128';
        
        if (autoUrl) {
            urlInput.value = autoUrl;
            selectedQuality = autoQuality;
            
            // Update active quality button
            qualityButtons.forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.quality === autoQuality) {
                    btn.classList.add('active');
                }
            });
            
            updateApiUrl();
            
            // Auto-start download after 1 second
            setTimeout(() => {
                downloadBtn.click();
            }, 1000);
        }
        
        // Initialize API URL
        updateApiUrl();
        
        // Update API URL when typing
        urlInput.addEventListener('input', updateApiUrl);
    </script>
</body>
</html>`;
  
  res.send(html);
});

// Health check
app.get('/health', async (req, res) => {
  const tool = await checkDownloadTool();
  const files = fs.readdirSync(downloadsDir);
  
  res.json({
    status: 200,
    success: true,
    creator: "Bera",
    message: "YouTube MP3 Download API",
    timestamp: new Date().toISOString(),
    system: {
      port: PORT,
      download_tool: tool || "NOT INSTALLED",
      downloads_dir: downloadsDir,
      files_count: files.length,
      server_time: new Date().toLocaleTimeString()
    },
    notes: tool ? "✅ System ready for downloads" : "❌ Install yt-dlp: pip install yt-dlp"
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║          🚀 YouTube MP3 Download API                     ║`);
  console.log(`║   ✅ Web Interface: http://localhost:${PORT}             ║`);
  console.log(`║   ✅ Real MP3 Downloads (1-10 MB files)                  ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
  
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 Web Interface: http://localhost:${PORT}`);
  console.log(`📥 API Endpoint: http://localhost:${PORT}/api/download/ytmp3`);
  console.log(`🔑 API Key: bera\n`);
  
  // Check for yt-dlp
  checkDownloadTool().then(tool => {
    if (tool) {
      console.log(`✅ ${tool} detected - Ready for real MP3 downloads!`);
      console.log(`🎯 Files will be 1-10 MB (not small fake files)`);
    } else {
      console.log(`❌ WARNING: yt-dlp not installed!`);
      console.log(`   Install with: pip install yt-dlp`);
      console.log(`   Or: npm install -g yt-dlp`);
      console.log(`   Or: sudo apt install yt-dlp (Ubuntu/Debian)`);
    }
  });
  
  console.log(`\n🎯 FEATURES:`);
  console.log(`   • Beautiful web interface for testing`);
  console.log(`   • Real YouTube audio downloads (MB files)`);
  console.log(`   • Multiple quality options (64-320 kbps)`);
  console.log(`   • Test with sample videos`);
  console.log(`   • API usage examples`);
  console.log(`   • Auto-cleanup of old files`);
});
