#!/usr/bin/env python3
import sys
import os
import json
import time
import argparse
from pathlib import Path
from typing import List, Dict, Any
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import yt_dlp
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
from datetime import datetime

class VideoScraper:
    def __init__(self, base_url: str, output_dir: str, job_id: str):
        self.base_url = base_url
        self.output_dir = Path(output_dir)
        self.job_id = job_id
        self.visited_urls = set()
        self.videos_found = []
        self.videos_downloaded = []
        self.progress = {
            'status': 'starting',
            'pages_scraped': 0,
            'videos_found': 0,
            'videos_downloaded': 0,
            'errors': 0,
            'start_time': datetime.now().isoformat()
        }
        
        # Create output directory
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        # Session for persistent connections
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        })
    
    def update_progress(self, **kwargs):
        """Update progress and print to stdout (for Node.js to capture)"""
        self.progress.update(kwargs)
        self.progress['current_time'] = datetime.now().isoformat()
        print(json.dumps(self.progress))
        
        # Save progress to file
        progress_file = self.output_dir / 'progress.json'
        with open(progress_file, 'w') as f:
            json.dump(self.progress, f, indent=2)
    
    def scrape_page(self, url: str, depth: int = 0, max_depth: int = 2):
        """Scrape a single page for video links"""
        if depth > max_depth or url in self.visited_urls:
            return
        
        self.visited_urls.add(url)
        
        try:
            self.update_progress(status=f'scraping_page', current_url=url)
            
            response = self.session.get(url, timeout=30)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Find video containers (common patterns)
            video_selectors = [
                {'tag': 'div', 'class_': 'video-item'},
                {'tag': 'article', 'class_': 'video'},
                {'tag': 'div', 'class_': 'video-container'},
                {'tag': 'a', 'href': lambda x: x and ('video' in x or 'watch' in x)},
                {'tag': 'div', 'data-type': 'video'},
            ]
            
            videos_on_page = []
            
            for selector in video_selectors:
                elements = soup.find_all(**selector)
                for elem in elements:
                    video_data = self.extract_video_data(elem, url)
                    if video_data and video_data.get('url'):
                        videos_on_page.append(video_data)
                        break  # Found videos with this selector
            
            # Deduplicate
            unique_videos = []
            seen_urls = set()
            for video in videos_on_page:
                if video['url'] not in seen_urls:
                    seen_urls.add(video['url'])
                    unique_videos.append(video)
            
            # Add to total videos found
            self.videos_found.extend(unique_videos)
            self.update_progress(
                pages_scraped=self.progress['pages_scraped'] + 1,
                videos_found=len(self.videos_found)
            )
            
            # Save current results
            self.save_results()
            
            # Find links to follow
            if depth < max_depth:
                links = soup.find_all('a', href=True)
                for link in links:
                    href = link['href']
                    absolute_url = urljoin(url, href)
                    
                    # Only follow links within same domain
                    if urlparse(absolute_url).netloc == urlparse(self.base_url).netloc:
                        # Avoid common non-page links
                        if not any(ext in absolute_url.lower() for ext in ['.jpg', '.png', '.mp4', '.mp3', '.pdf']):
                            time.sleep(0.5)  # Politeness delay
                            self.scrape_page(absolute_url, depth + 1, max_depth)
            
        except Exception as e:
            self.update_progress(
                errors=self.progress['errors'] + 1,
                last_error=str(e)
            )
    
    def extract_video_data(self, element, base_url: str) -> Dict[str, Any]:
        """Extract video metadata from HTML element"""
        try:
            video = {}
            
            # Try to find title
            title_elem = element.find(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'span', 'div'])
            if title_elem and title_elem.text.strip():
                video['title'] = title_elem.text.strip()[:200]
            
            # Try to find URL
            link_elem = element.find('a', href=True)
            if link_elem:
                video['url'] = urljoin(base_url, link_elem['href'])
            elif element.name == 'a' and element.get('href'):
                video['url'] = urljoin(base_url, element['href'])
            
            # Try to find thumbnail
            img_elem = element.find('img', src=True)
            if img_elem:
                video['thumbnail'] = urljoin(base_url, img_elem['src'])
            
            # Try to find duration
            time_elem = element.find(['time', 'span', 'div'], class_=lambda x: x and any(word in str(x).lower() for word in ['duration', 'time', 'length']))
            if time_elem:
                video['duration'] = time_elem.text.strip()
            
            # Try to find views
            views_elem = element.find(['span', 'div'], class_=lambda x: x and any(word in str(x).lower() for word in ['view', 'watch']))
            if views_elem:
                video['views'] = views_elem.text.strip()
            
            # Add timestamp
            video['scraped_at'] = datetime.now().isoformat()
            
            return video if video.get('url') else None
            
        except Exception as e:
            return None
    
    def download_videos(self, quality: str = 'best', concurrent: int = 3):
        """Download found videos"""
        if not self.videos_found:
            self.update_progress(status='no_videos_found')
            return
        
        self.update_progress(status='downloading_videos', total_to_download=len(self.videos_found))
        
        with ThreadPoolExecutor(max_workers=concurrent) as executor:
            futures = []
            for video in self.videos_found[:20]:  # Limit to 20 videos
