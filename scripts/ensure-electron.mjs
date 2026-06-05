#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = path.join(rootDir, 'node_modules', 'electron')
const distDir = path.join(electronDir, 'dist')
const pathFile = path.join(electronDir, 'path.txt')

function platformPath() {
  switch (process.env.npm_config_platform || os.platform()) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'linux':
    case 'openbsd':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(
        `Unsupported Electron platform: ${process.env.npm_config_platform || os.platform()}`
      )
  }
}

function electronBinaryPath() {
  return process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(distDir, platformPath())
}

function isInstalled() {
  try {
    return (
      fs.readFileSync(pathFile, 'utf8') === platformPath() && fs.existsSync(electronBinaryPath())
    )
  } catch {
    return false
  }
}

function electronZipName(version, platform, arch) {
  return `electron-v${version}-${platform}-${arch}.zip`
}

async function downloadElectronZip(version, platform, arch) {
  const zipName = electronZipName(version, platform, arch)
  const cacheRoot =
    process.env.electron_config_cache || path.join(os.homedir(), '.cache', 'electron-pi-rag')
  const zipPath = path.join(cacheRoot, zipName)

  if (!fs.existsSync(zipPath) || process.env.force_no_cache === 'true') {
    fs.mkdirSync(cacheRoot, { recursive: true })
    const mirror =
      process.env.ELECTRON_MIRROR || 'https://github.com/electron/electron/releases/download/'
    const url = `${mirror.replace(/\/$/, '')}/v${version}/${zipName}`
    console.log(`[ensure-electron] downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok)
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
    const data = Buffer.from(await response.arrayBuffer())
    fs.writeFileSync(zipPath, data)
  }

  const checksums = require(path.join(electronDir, 'checksums.json'))
  const expected = checksums[zipName]
  if (expected) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
    if (actual !== expected)
      throw new Error(`Checksum mismatch for ${zipName}: expected ${expected}, got ${actual}`)
  }

  return zipPath
}

async function installElectron() {
  const extract = require('extract-zip')
  const { version } = require(path.join(electronDir, 'package.json'))
  const platform = process.env.npm_config_platform || process.platform
  const arch = process.env.npm_config_arch || process.arch
  const zipPath = await downloadElectronZip(version, platform, arch)

  fs.rmSync(distDir, { recursive: true, force: true })
  fs.mkdirSync(distDir, { recursive: true })

  if (platform === 'linux') {
    execFileSync('unzip', ['-q', zipPath, '-d', distDir], { stdio: 'inherit' })
  } else {
    await extract(zipPath, { dir: distDir })
  }

  fs.writeFileSync(pathFile, platformPath())
}

async function main() {
  if (!fs.existsSync(electronDir)) {
    console.warn('[ensure-electron] node_modules/electron not found; skipping')
    return
  }

  if (!isInstalled()) {
    console.log('[ensure-electron] installing Electron binary')
    await installElectron()
  }

  if (!isInstalled()) {
    throw new Error(`Electron binary missing after install: ${electronBinaryPath()}`)
  }

  console.log(`[ensure-electron] ready: ${electronBinaryPath()}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
