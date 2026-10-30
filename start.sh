#!/bin/bash
# Seedr Cloud Engine Linux Startup Script

echo "======================================================="
echo "  Starting Seedr 4GB Free Cloud Engine on Linux..."
echo "======================================================="

# Ensure aria2 is installed
if ! command -v aria2c &> /dev/null; then
    echo "⚠️ aria2c is not installed. Installing via apt..."
    if command -v apt &> /dev/null; then
        sudo apt update && sudo apt install -y aria2
    elif command -v apk &> /dev/null; then
        apk add --no-cache aria2
    elif command -v yum &> /dev/null; then
        sudo yum install -y aria2
    fi
fi

# Ensure directories exist
mkdir -p downloads data

# Start server
PORT=${PORT:-3000} node server.js
