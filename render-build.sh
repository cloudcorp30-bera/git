#!/bin/bash
echo "Starting build process on Render..."

# Create necessary directories
mkdir -p downloads scraped_data python_scraper logs

# Check Python version
python3 --version

# Install Python dependencies if requirements.txt exists
if [ -f "python_scraper/requirements.txt" ]; then
    echo "Installing Python dependencies..."
    pip3 install -r python_scraper/requirements.txt
fi

echo "Build completed!"
