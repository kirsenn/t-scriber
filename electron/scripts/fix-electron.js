#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

// Fix path.txt so Electron can locate its binary after a fresh npm install.
const pathFile = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt');
const value = 'Electron.app/Contents/MacOS/Electron';
if (!fs.existsSync(pathFile) || fs.readFileSync(pathFile, 'utf8').trim() !== value) {
  fs.writeFileSync(pathFile, value, 'utf8');
  console.log('electron path.txt written');
}

const ELECTRON_APP = path.join(
  __dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents'
);

// Patch Info.plist so macOS dock shows "T-Scriber" instead of "Electron".
const plistPath = path.join(ELECTRON_APP, 'Info.plist');
if (fs.existsSync(plistPath)) {
  let plist = fs.readFileSync(plistPath, 'utf8');
  const patched = plist
    .replace(
      /<key>CFBundleDisplayName<\/key>\s*<string>Electron<\/string>/,
      '<key>CFBundleDisplayName</key>\n\t<string>T-Scriber</string>'
    )
    .replace(
      /<key>CFBundleName<\/key>\s*<string>Electron<\/string>/,
      '<key>CFBundleName</key>\n\t<string>T-Scriber</string>'
    );
  if (patched !== plist) {
    fs.writeFileSync(plistPath, patched, 'utf8');
    console.log('Info.plist patched: Electron → T-Scriber');
  }
}

// Replace bundle icon so dock shows our custom icon.
const icnsSrc = path.join(__dirname, '..', 'assets', 'icon.icns');
const icnsDst = path.join(ELECTRON_APP, 'Resources', 'electron.icns');
if (fs.existsSync(icnsSrc) && fs.existsSync(icnsDst)) {
  fs.copyFileSync(icnsSrc, icnsDst);
  console.log('electron.icns replaced with T-Scriber icon');
}
