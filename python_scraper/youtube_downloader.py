#!/usr/bin/env python3
import sys
import os
import json
import yt_dlp
import traceback
from pathlib import Path

def download_youtube_video(video_id, quality='best', format='mp3', output_path=None):
    """
    Download YouTube video using yt-dlp (more reliable than ytdl-core)
    """
    try:
        # Configure yt-dlp options
        ydl_opts = {
            'quiet': False,
            'no_warnings': False,
            'format': 'bestaudio/best' if format == 'mp3' else f'best[height<={quality.replace("p", "")}]',
            'outtmpl': output_path if output_path else f'%(id)s.%(ext)s',
            'progress_hooks': [progress_hook],
        }
        
        if format == 'mp3':
            ydl_opts.update({
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': quality.replace('kbps', '') if 'kbps' in quality else '192',
                }],
                'keepvideo': False,
            })
        
        url = f'https://www.youtube.com/watch?v={video_id}'
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            
            # Get the downloaded file path
            if format == 'mp3':
                downloaded_file = output_path or f"{info['id']}.mp3"
            else:
                downloaded_file = output_path or f"{info['id']}.mp4"
            
            return {
                'success': True,
                'video_id': video_id,
                'title': info.get('title', 'Unknown'),
                'duration': info.get('duration', 0),
                'file_path': downloaded_file,
                'file_size': os.path.getsize(downloaded_file) if os.path.exists(downloaded_file) else 0,
                'format': format,
                'quality': quality
            }
            
    except Exception as e:
        print(f"Error downloading video: {str(e)}")
        traceback.print_exc()
        return {
            'success': False,
            'error': str(e),
            'video_id': video_id
        }

def progress_hook(d):
    """Progress hook for yt-dlp"""
    if d['status'] == 'downloading':
        downloaded = d.get('downloaded_bytes', 0)
        total = d.get('total_bytes', 0) or d.get('total_bytes_estimate', 0)
        
        if total > 0:
            percent = (downloaded / total) * 100
            speed = d.get('speed', 0)
            
            # Print progress to stdout (Node.js will capture this)
            progress = {
                'status': 'downloading',
                'percent': round(percent, 2),
                'downloaded_mb': round(downloaded / 1024 / 1024, 2),
                'total_mb': round(total / 1024 / 1024, 2),
                'speed_mb': round(speed / 1024 / 1024, 2) if speed else 0
            }
            print(json.dumps(progress))
            
    elif d['status'] == 'finished':
        print(json.dumps({'status': 'finished'}))

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python youtube_downloader.py <video_id> <quality> <format> [output_path]")
        sys.exit(1)
    
    video_id = sys.argv[1]
    quality = sys.argv[2]
    format = sys.argv[3]
    output_path = sys.argv[4] if len(sys.argv) > 4 else None
    
    result = download_youtube_video(video_id, quality, format, output_path)
    print(json.dumps(result))
