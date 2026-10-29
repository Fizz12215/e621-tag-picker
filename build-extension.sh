#!/usr/bin/env bash
# Builds the Firefox add-on from the website files.
# The website files are only copied, never changed.
#   dist/firefox/                          the add-on as a folder (for testing in Firefox)
#   dist/e621-tag-picker-firefox-<v>.zip   the add-on as one file (to upload to Mozilla)
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist/firefox
mkdir -p dist/firefox/picker
cp extension/manifest.json extension/content.js extension/content.css extension/icon.svg dist/firefox/
cp index.html app.js style.css theme.js dist/firefox/picker/

version=$(grep -o '"version": *"[^"]*"' extension/manifest.json | grep -o '[0-9][0-9.]*')
zipfile="dist/e621-tag-picker-firefox-$version.zip"
rm -f "$zipfile"
(cd dist/firefox && zip -qr "../$(basename "$zipfile")" .)
echo "Built $zipfile"
