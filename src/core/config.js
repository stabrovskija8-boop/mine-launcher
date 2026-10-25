'use strict';

const os = require('os');
const path = require('path');
const fsp = require('fs/promises');

const { ensureDir, readJson, writeJson } = require('./util');

function defaultGameDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
  }
  return path.join(os.homedir(), '.minecraft');
}

function nextPowerOfTwoCeil(value) {
  let result = 1024;
  while (result < value) result *= 2;
  return result;
}

function memoryLimits() {
  const totalMb = Math.floor(os.totalmem() / (1024 * 1024));
  const max = Math.max(2048, Math.min(32768, nextPowerOfTwoCeil(Math.floor(totalMb * 0.5))));
  return { min: 1024, max, totalMb, step: 512 };
}

function defaultRam() {
  const { max } = memoryLimits();
  const totalGb = os.totalmem() / 1024 ** 3;
  let recommended = totalGb >= 24 ? 6144 : totalGb >= 12 ? 4096 : 2048;
  recommended = Math.min(recommended, max);
  return Math.max(1024, Math.round(recommended / 512) * 512);
}

function defaultConfig() {
  return {
    username: 'Steve',
    gameDir: defaultGameDir(),
    ramMB: defaultRam(),
    javaPath: '',
    jvmArgs: '',
    resolution: false,
    width: 1280,
    height: 720,
    fullscreen: false,
    skinEnabled: true,
  };
}

function sanitizeUsername(value, fallback = 'Steve') {
  const name = String(value || '').trim();
  return /^[A-Za-z0-9_]{2,16}$/.test(name) ? name : fallback;
}

function sanitizeConfig(input, base = defaultConfig()) {
  const limits = memoryLimits();
  const config = { ...base, ...(input || {}) };
  config.username = sanitizeUsername(config.username, base.username || 'Steve');
  config.gameDir = path.resolve(String(config.gameDir || base.gameDir));
  config.ramMB = Math.min(
    limits.max,
    Math.max(limits.min, Math.round((Number(config.ramMB) || base.ramMB) / 512) * 512),
  );
  config.javaPath = String(config.javaPath || '').trim().replace(/^"(.*)"$/, '$1');
  config.jvmArgs = String(config.jvmArgs || '').trim().slice(0, 3000);
  config.resolution = Boolean(config.resolution);
  config.fullscreen = Boolean(config.fullscreen);
  config.skinEnabled = config.skinEnabled !== false;
  config.width = Math.min(7680, Math.max(320, Math.round(Number(config.width) || 1280)));
  config.height = Math.min(4320, Math.max(240, Math.round(Number(config.height) || 720)));
  return config;
}

function buildPaths(config, dataDir) {
  const gameDir = config.gameDir;
  return {
    dataDir,
    gameDir,
    metaDir: path.join(dataDir, 'meta'),
    versionsDir: path.join(gameDir, 'versions'),
    librariesDir: path.join(gameDir, 'libraries'),
    assetsDir: path.join(gameDir, 'assets'),
    javaDir: path.join(dataDir, 'runtimes'),
    logsDir: path.join(dataDir, 'logs'),
    configPath: path.join(dataDir, 'config.json'),
  };
}

async function loadConfig(dataDir) {
  await ensureDir(dataDir);
  const file = path.join(dataDir, 'config.json');
  const stored = await readJson(file);
  const config = sanitizeConfig(stored, defaultConfig());
  if (!stored) await writeJson(file, config);
  return config;
}

async function saveConfig(dataDir, config) {
  const file = path.join(dataDir, 'config.json');
  await ensureDir(dataDir);
  await writeJson(file, config);
}

async function ensureGameDir(config) {
  await fsp.mkdir(config.gameDir, { recursive: true });
  await fsp.mkdir(path.join(config.gameDir, 'versions'), { recursive: true });
}

module.exports = {
  defaultConfig,
  defaultGameDir,
  memoryLimits,
  sanitizeConfig,
  sanitizeUsername,
  buildPaths,
  loadConfig,
  saveConfig,
  ensureGameDir,
};
