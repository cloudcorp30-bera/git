#!/bin/bash
echo "Installing Python dependencies..."
pip3 install -r requirements.txt

echo "Installing FFmpeg (for audio conversion)..."
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y ffmpeg

# macOS
# brew install ffmpeg

echo "Installing ChromeDriver for Selenium..."
pip3 install webdriver-manager

echo "Installation complete!"
