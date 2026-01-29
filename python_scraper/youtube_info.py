#!/usr/bin/env python3
import sys
import json
import yt_dlp

def get_video_info(url):
    """Get YouTube video info without downloading"""
    try:
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': False,
        }
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            return {
                'success': True,
                'title': info.get('title', 'Unknown'),
                'thumbnail': info.get('thumbnail', ''),
                'duration': info.get('duration', 0),
                'uploader': info.get('uploader', ''),
                'view_count': info.get('view_count', 0),
                'like_count': info.get('like_count', 0),
                'description': info.get('description', '')[:500],
                'formats': len(info.get('formats', [])),
                'best_audio_format': 'mp3',
                'best_video_format': 'mp4'
            }
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'title': 'YouTube Video',
            'thumbnail': '',
            'duration': 0
        }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'URL required'}))
        sys.exit(1)
    
    url = sys.argv[1]
    info = get_video_info(url)
    print(json.dumps(info))
