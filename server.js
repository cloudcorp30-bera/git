import express from 'express';
import play from 'play-dl';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors());

// Rate limiting - 100 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    status: 429,
    success: false,
    creator: "Bera",
    error: 'Too many requests, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create downloads directory
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// Clean old files every 30 minutes
setInterval(() => {
  const files = fs.readdirSync(downloadsDir);
  const now = Date.now();
  
  files.forEach(file => {
    const filePath = path.join(downloadsDir, file);
    try {
      const stats = fs.statSync(filePath);
      // Delete files older than 1 hour
      if (now - stats.mtime.getTime() > 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
        console.log(`Deleted old file: ${file}`);
      }
    } catch (err) {
      console.error(`Error cleaning file ${file}:`, err);
    }
  });
}, 30 * 60 * 1000);

// YouTube Service Functions
async function getVideoInfo(url) {
  try {
    const videoInfo = await play.video_basic_info(url);
    const details = videoInfo.video_details;
    
    return {
      title: details.title || 'Unknown Title',
      duration: details.durationInSec || 0,
      thumbnail: details.thumbnails?.[0]?.url || '',
      videoId: details.id || '',
      author: details.channel?.name || 'Unknown Author'
    };
  } catch (error) {
    throw new Error(`Failed to get video info: ${error.message}`);
  }
}

async function downloadMP3(url, quality = '128', baseUrl) {
  try {
    const info = await getVideoInfo(url);
    
    // Generate unique filename
    const fileId = randomBytes(16).toString('hex');
    const filename = `${fileId}.mp3`;
    const filePath = path.join(downloadsDir, filename);
    
    // Download audio stream
    const stream = await play.stream(url, {
      quality: 140, // 128kbps audio
      discordPlayerCompatibility: false
    });
    
    return new Promise((resolve, reject) => {
      ffmpeg(stream.stream)
        .audioBitrate(parseInt(quality))
        .audioCodec('libmp3lame')
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(new Error('Audio conversion failed'));
        })
        .on('end', () => {
          const result = {
            quality: `${quality}kbps`,
            duration: info.duration,
            title: `${info.title.replace(/[^\w\s-]/gi, '')}.mp3`,
            thumbnail: info.thumbnail,
            download_url: `${baseUrl}/api/download/file/${fileId}`
          };
          resolve(result);
        })
        .save(filePath);
    });
    
  } catch (error) {
    throw new Error(`MP3 download failed: ${error.message}`);
  }
}

async function downloadMP4(url, quality = 'medium', baseUrl) {
  try {
    const info = await getVideoInfo(url);
    const fileId = randomBytes(16).toString('hex');
    const filename = `${fileId}.mp4`;
    const filePath = path.join(downloadsDir, filename);
    
    // Map quality to itag
    const qualityMap = {
      'low': 18,      // 360p
      'medium': 137,  // 1080p (video only)
      'high': 22,     // 720p
      'hd': 137,      // 1080p
      'fullhd': 299   // 1080p60
    };
    
    const itag = qualityMap[quality] || 18;
    
    const stream = await play.stream(url, {
      quality: itag,
      discordPlayerCompatibility: false
    });
    
    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);
      stream.stream.pipe(writeStream);
      
      writeStream.on('finish', () => {
        const result = {
          quality: quality,
          duration: info.duration,
          title: `${info.title.replace(/[^\w\s-]/gi, '')}.mp4`,
          thumbnail: info.thumbnail,
          download_url: `${baseUrl}/api/download/file/${fileId}`
        };
        resolve(result);
      });
      
      writeStream.on('error', (err) => {
        reject(new Error(`File write failed: ${err.message}`));
      });
    });
    
  } catch (error) {
    throw new Error(`MP4 download failed: ${error.message}`);
  }
}

// Middleware
function validateApiKey(req, res, next) {
  const apiKey = req.query.apikey || req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({
      status: 401,
      success: false,
      creator: "Bera",
      error: "API key is required"
    });
  }
  
  if (apiKey !== 'bera') {
    return res.status(403).json({
      status: 403,
      success: false,
      creator: "Bera",
      error: "Invalid API key"
    });
  }
  
  next();
}

function validateYouTubeUrl(req, res, next) {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({
      status: 400,
      success: false,
      creator: "Bera",
      error: "YouTube URL is required"
    });
  }
  
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
  if (!youtubeRegex.test(url)) {
    return res.status(400).json({
      status: 400,
      success: false,
      creator: "Bera",
      error: "Invalid YouTube URL"
    });
  }
  
  next();
}

// API Endpoints

// Main MP3 Endpoint - EXACTLY what you requested
app.get('/api/download/ytmp3', validateApiKey, validateYouTubeUrl, async (req, res) => {
  try {
    const { url, quality = '128' } = req.query;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    // Validate quality
    const validQualities = ['64', '128', '192', '256', '320'];
    if (!validQualities.includes(quality)) {
      return res.status(400).json({
        status: 400,
        success: false,
        creator: "Bera",
        error: `Invalid quality. Choose from: ${validQualities.join(', ')}`
      });
    }
    
    const result = await downloadMP3(url, quality, baseUrl);
    
    res.json({
      status: 200,
      success: true,
      creator: "Bera",
      result: result
    });
    
  } catch (error) {
    console.error('MP3 Download Error:', error);
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message || "Internal server error"
    });
  }
});

// MP4 Endpoint
app.get('/api/download/ytmp4', validateApiKey, validateYouTubeUrl, async (req, res) => {
  try {
    const { url, quality = 'medium' } = req.query;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    const validQualities = ['low', 'medium', 'high', 'hd', 'fullhd'];
    if (!validQualities.includes(quality)) {
      return res.status(400).json({
        status: 400,
        success: false,
        creator: "Bera",
        error: `Invalid quality. Choose from: ${validQualities.join(', ')}`
      });
    }
    
    const result = await downloadMP4(url, quality, baseUrl);
    
    res.json({
      status: 200,
      success: true,
      creator: "Bera",
      result: result
    });
    
  } catch (error) {
    console.error('MP4 Download Error:', error);
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message || "Internal server error"
    });
  }
});

// File Download Endpoint
app.get('/api/download/file/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const files = fs.readdirSync(downloadsDir);
    const file = files.find(f => f.startsWith(fileId));
    
    if (!file) {
      return res.status(404).json({
        status: 404,
        success: false,
        creator: "Bera",
        error: "File not found or expired"
      });
    }
    
    const filePath = path.join(downloadsDir, file);
    const stats = fs.statSync(filePath);
    
    // Determine content type
    let contentType = 'application/octet-stream';
    if (file.endsWith('.mp3')) contentType = 'audio/mpeg';
    if (file.endsWith('.mp4')) contentType = 'video/mp4';
    
    // Set headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.setHeader('Content-Length', stats.size);
    
    // Stream the file
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    
    // Clean up after streaming
    stream.on('end', () => {
      setTimeout(() => {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up file: ${file}`);
          }
        } catch (err) {
          console.error('Error deleting file:', err);
        }
      }, 5000); // Wait 5 seconds before deleting
    });
    
  } catch (error) {
    console.error('File Download Error:', error);
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message || "Internal server error"
    });
  }
});

// Video Info Endpoint
app.get('/api/download/info', validateApiKey, validateYouTubeUrl, async (req, res) => {
  try {
    const { url } = req.query;
    const info = await getVideoInfo(url);
    
    res.json({
      status: 200,
      success: true,
      creator: "Bera",
      result: info
    });
    
  } catch (error) {
    console.error('Info Error:', error);
    res.status(500).json({
      status: 500,
      success: false,
      creator: "Bera",
      error: error.message || "Internal server error"
    });
  }
});

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 200,
    success: true,
    creator: "Bera",
    message: "API is running",
    timestamp: new Date().toISOString()
  });
});

// Homepage (API Documentation)
app.get('/', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Bera YouTube Download API</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            color: white;
        }
        
        .container {
            max-width: 1000px;
            margin: 0 auto;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        
        h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
        }
        
        .subtitle {
            font-size: 1.2em;
            opacity: 0.9;
            margin-bottom: 30px;
        }
        
        .api-key {
            background: rgba(255, 255, 255, 0.15);
            padding: 15px;
            border-radius: 10px;
            margin: 20px 0;
            font-family: monospace;
            font-size: 1.1em;
            border: 1px solid rgba(255, 255, 255, 0.3);
        }
        
        .endpoint {
            background: rgba(255, 255, 255, 0.1);
            padding: 25px;
            border-radius: 15px;
            margin: 25px 0;
            border-left: 4px solid #667eea;
        }
        
        .method {
            display: inline-block;
            background: #667eea;
            color: white;
            padding: 6px 12px;
            border-radius: 6px;
            font-weight: bold;
            margin-bottom: 15px;
        }
        
        .url {
            font-family: monospace;
            background: rgba(0, 0, 0, 0.3);
            padding: 12px;
            border-radius: 8px;
            margin: 10px 0;
            display: block;
            word-break: break-all;
            font-size: 1.1em;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .params {
            margin-top: 15px;
            padding-left: 20px;
        }
        
        .param {
            margin: 8px 0;
            padding: 8px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 6px;
        }
        
        .example {
            margin-top: 15px;
            padding: 15px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 10px;
            overflow-x: auto;
        }
        
        pre {
            font-family: monospace;
            font-size: 14px;
            line-height: 1.5;
        }
        
        .response {
            color: #4ade80;
        }
        
        .footer {
            text-align: center;
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid rgba(255, 255, 255, 0.2);
            opacity: 0.8;
        }
        
        .status {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.9em;
            margin-left: 10px;
        }
        
        .status.success {
            background: #10b981;
        }
        
        .status.error {
            background: #ef4444;
        }
        
        @media (max-width: 768px) {
            .container {
                padding: 20px;
            }
            
            h1 {
                font-size: 2em;
            }
            
            .url {
                font-size: 0.9em;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎵 Bera YouTube Download API</h1>
            <p class="subtitle">Free YouTube to MP3/MP4 conversion API service</p>
            <div class="api-key">
                🔑 API Key: <strong>bera</strong>
            </div>
            <p>Your API Base URL: <strong>${baseUrl}</strong></p>
        </div>
        
        <div class="endpoint">
            <div class="method">GET</div>
            <h3>MP3 Download</h3>
            <div class="url">${baseUrl}/api/download/ytmp3?apikey=bera&url=YOUTUBE_URL&quality=128</div>
            <div class="params">
                <div class="param"><strong>apikey</strong> (required): Your API key</div>
                <div class="param"><strong>url</strong> (required): YouTube video URL</div>
                <div class="param"><strong>quality</strong> (optional): 64, 128, 192, 256, 320 (kbps) - Default: 128</div>
            </div>
            <div class="example">
                <h4>Example Response:</h4>
                <pre><code class="response">{
  "status": 200,
  "success": true,
  "creator": "Bera",
  "result": {
    "quality": "128kbps",
    "duration": 379,
    "title": "Song Name.mp3",
    "thumbnail": "https://i.ytimg.com/vi/VIDEO_ID/hq720.jpg",
    "download_url": "${baseUrl}/api/download/file/abc123"
  }
}</code></pre>
            </div>
        </div>
        
        <div class="endpoint">
            <div class="method">GET</div>
            <h3>MP4 Download</h3>
            <div class="url">${baseUrl}/api/download/ytmp4?apikey=bera&url=YOUTUBE_URL&quality=medium</div>
            <div class="params">
                <div class="param"><strong>apikey</strong> (required): Your API key</div>
                <div class="param"><strong>url</strong> (required): YouTube video URL</div>
                <div class="param"><strong>quality</strong> (optional): low, medium, high, hd, fullhd - Default: medium</div>
            </div>
        </div>
        
        <div class="endpoint">
            <div class="method">GET</div>
            <h3>Video Information</h3>
            <div class="url">${baseUrl}/api/download/info?apikey=bera&url=YOUTUBE_URL</div>
            <div class="params">
                <div class="param"><strong>apikey</strong> (required): Your API key</div>
                <div class="param"><strong>url</strong> (required): YouTube video URL</div>
            </div>
        </div>
        
        <div class="endpoint">
            <div class="method">GET</div>
            <h3>Health Check</h3>
            <div class="url">${baseUrl}/health</div>
            <p>Check if the API is running</p>
        </div>
        
        <div class="footer">
            <p>Made with ❤️ by Bera | Status: <span class="status success">Online</span></p>
            <p>Rate Limit: 100 requests per 15 minutes</p>
        </div>
    </div>
    
    <script>
        // Add copy functionality to URLs
        document.querySelectorAll('.url').forEach(urlElement => {
            urlElement.addEventListener('click', function() {
                const text = this.textContent;
                navigator.clipboard.writeText(text).then(() => {
                    const original = this.textContent;
                    this.textContent = '✓ Copied!';
                    this.style.background = '#10b981';
                    setTimeout(() => {
                        this.textContent = original;
                        this.style.background = '';
                    }, 2000);
                });
            });
            urlElement.style.cursor = 'pointer';
        });
        
        // Show current server URL
        const serverUrl = window.location.origin;
        document.querySelectorAll('strong').forEach(el => {
            if (el.textContent === '${baseUrl}') {
                el.textContent = serverUrl;
            }
        });
    </script>
</body>
</html>`;
  
  res.send(html);
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Bera YouTube API running on port ${PORT}`);
  console.log(`📥 MP3 Endpoint: http://localhost:${PORT}/api/download/ytmp3?apikey=bera&url=YOUTUBE_URL&quality=128`);
  console.log(`🌐 Documentation: http://localhost:${PORT}`);
  console.log(`🔧 Downloads folder: ${downloadsDir}`);
});
