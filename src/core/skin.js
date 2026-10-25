'use strict';

const fsp = require('fs/promises');
const path = require('path');

const { ensureDir, exists } = require('./util');

const PACK_NAME = 'MINE-Skin';
const PACK_ID = `file/${PACK_NAME}`;
const DEFAULT_PACK_DESCRIPTION = 'MINE Launcher · скин игрока';

/* ------------------------------------------------------------- Формат пака */

function parseVersionParts(versionId) {
  const id = String(versionId || '');
  if (/^old_alpha|^a\d/i.test(id)) return { legacy: true, major: 0, minor: 0, patch: 0 };
  if (/^old_beta|^b\d/i.test(id)) return { legacy: true, major: 0, minor: 0, patch: 0 };
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(id);
  if (!match) return { legacy: false, major: 1, minor: 21, patch: 0 };
  return {
    legacy: false,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
  };
}

function isLegacySkinVersion(versionId) {
  const { major, minor } = parseVersionParts(versionId);
  return major === 1 && minor <= 7;
}

function packFormatFor(versionId) {
  const { major, minor, patch } = parseVersionParts(versionId);
  if (major !== 1) return 34;
  if (minor <= 8) return 1;
  if (minor <= 10) return 2;
  if (minor <= 12) return 3;
  if (minor <= 14) return 4;
  if (minor === 15) return 5;
  if (minor === 16) return patch <= 1 ? 5 : 6;
  if (minor === 17) return 7;
  if (minor === 18) return 8;
  if (minor === 19) {
    if (patch <= 2) return 9;
    if (patch === 3) return 12;
    return 13;
  }
  if (minor === 20) {
    if (patch <= 1) return 15;
    if (patch === 2) return 18;
    if (patch <= 4) return 22;
    return 32;
  }
  if (minor === 21) {
    if (patch <= 1) return 34;
    if (patch <= 3) return 42;
    if (patch === 4) return 46;
    return 55;
  }
  return 55;
}

function packVersionFor(versionId, clientJarPath) {
  const fromJar = readPackVersionFromJar(clientJarPath);
  if (fromJar) return fromJar;
  return { major: packFormatFor(versionId), minor: 0 };
}

function readPackVersionFromJar(clientJarPath) {
  if (!clientJarPath) return null;
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(clientJarPath);
    const entry = zip.getEntry('version.json');
    if (!entry) return null;
    const data = JSON.parse(entry.getData().toString('utf8'));
    const major = Number(data?.pack_version?.resource_major);
    const minor = Number(data?.pack_version?.resource_minor);
    if (!Number.isFinite(major) || major <= 0) return null;
    return { major, minor: Number.isFinite(minor) && minor > 0 ? minor : 0 };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- Пути */

function skinPaths(paths) {
  const dir = path.join(paths.dataDir, 'skin');
  return {
    dir,
    file: path.join(dir, 'skin.png'),
    packDir: path.join(paths.gameDir, 'resourcepacks', PACK_NAME),
    optionsFile: path.join(paths.gameDir, 'options.txt'),
  };
}

/* ---------------------------------------------------------------- Чтение */

async function getSkin(paths, config = {}) {
  const { file } = skinPaths(paths);
  const enabled = config.skinEnabled !== false;
  if (!(await exists(file))) return { png: null, enabled };
  try {
    const buffer = await fsp.readFile(file);
    return { png: buffer.toString('base64'), enabled };
  } catch {
    return { png: null, enabled };
  }
}

async function saveSkinFile(paths, base64) {
  const { dir, file } = skinPaths(paths);
  if (typeof base64 !== 'string' || !base64) throw new Error('Не удалось прочитать изображение скина.');
  const data = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length < 100) throw new Error('Файл скина повреждён.');
  await ensureDir(dir);
  await fsp.writeFile(file, buffer);
  return file;
}

/* ------------------------------------------------------- Сборка ресурспака */

function legacySkinBuffer(buffer) {
  try {
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width !== 64 || size.height !== 64) return null;
    return image.crop({ x: 0, y: 0, width: 64, height: 32 }).toPNG();
  } catch {
    return null;
  }
}

// В 1.20+ игра выбирает один из девяти стандартных скинов по UUID игрока,
// поэтому переопределять нужно все девять в обоих типах модели.
const DEFAULT_SKIN_NAMES = [
  'steve',
  'alex',
  'ari',
  'efe',
  'kai',
  'makena',
  'noor',
  'sunny',
  'zuri',
];
const PLAYER_MODELS = ['wide', 'slim'];
const LEGACY_SKIN_TEXTURES = [
  'assets/minecraft/textures/entity/steve.png',
  'assets/minecraft/textures/entity/alex.png',
  'assets/minecraft/textures/mob/char.png',
];

function isLegacySkinLayout(versionId) {
  const { legacy, major, minor } = parseVersionParts(versionId);
  return legacy || (major === 1 && minor <= 7);
}

function skinTexturesFor(versionId) {
  if (isLegacySkinLayout(versionId)) return [...LEGACY_SKIN_TEXTURES];
  const list = [];
  for (const model of PLAYER_MODELS) {
    for (const name of DEFAULT_SKIN_NAMES) {
      list.push(`assets/minecraft/textures/entity/player/${model}/${name}.png`);
    }
  }
  list.push(...LEGACY_SKIN_TEXTURES);
  return list;
}

function packMetaFor({ major, minor }) {
  const description = DEFAULT_PACK_DESCRIPTION;
  // 1.21.9+ (resource_major >= 65): обязательны min_format/max_format,
  // pack_format и supported_formats в новом формате запрещены.
  if (major >= 65) {
    return {
      pack: {
        description,
        min_format: [major, minor || 0],
        max_format: major,
      },
    };
  }
  return {
    pack: {
      pack_format: major,
      description,
    },
  };
}

async function writePack(paths, buffer, versionId, clientJarPath) {
  const { packDir } = skinPaths(paths);
  const format = packVersionFor(versionId, clientJarPath);
  const legacy = isLegacySkinLayout(versionId);
  const png = legacy ? legacySkinBuffer(buffer) || buffer : buffer;

  const meta = packMetaFor(format);

  await ensureDir(packDir);
  await fsp.writeFile(path.join(packDir, 'pack.mcmeta'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  for (const relative of skinTexturesFor(versionId)) {
    const dest = path.join(packDir, ...relative.split('/'));
    await ensureDir(path.dirname(dest));
    await fsp.writeFile(dest, png);
  }
  return packDir;
}

/* --------------------------------------------------------- options.txt */

function parseOptions(text) {
  const lines = String(text || '').split(/\r?\n/);
  const values = new Map();
  const order = [];
  for (const line of lines) {
    if (!line || !line.includes(':')) continue;
    const index = line.indexOf(':');
    const key = line.slice(0, index);
    values.set(key, line.slice(index + 1));
    order.push(key);
  }
  return { lines, values, order };
}

function readJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeOptions(text, enabled) {
  const { lines, values, order } = parseOptions(text);
  const packs = [];
  for (const item of readJsonArray(values.get('resourcePacks'))) {
    if (item === PACK_ID || packs.includes(item)) continue;
    packs.push(item);
  }
  const incompatible = [...new Set(readJsonArray(values.get('incompatibleResourcePacks')))].filter(
    (item) => item !== PACK_ID,
  );

  if (enabled) {
    // vanilla должен идти первым ровно один раз.
    const rest = packs.filter((item) => item !== 'vanilla');
    packs.length = 0;
    packs.push('vanilla', ...rest);
    packs.push(PACK_ID);
  }

  const updated = new Map(values);
  updated.set('resourcePacks', JSON.stringify(packs));
  updated.set('incompatibleResourcePacks', JSON.stringify(incompatible));

  const keys = [...order];
  for (const key of ['resourcePacks', 'incompatibleResourcePacks']) {
    if (!keys.includes(key)) keys.push(key);
  }

  const result = keys.map((key) => `${key}:${updated.get(key) ?? ''}`);
  // Сохраняем пустые строки и комментарии на своих местах не критично,
  // но завершающий перевод строки нужен игре.
  if (lines.length && lines[lines.length - 1] === '') result.push('');
  return result.join('\n');
}

async function patchOptions(paths, enabled) {
  const { optionsFile } = skinPaths(paths);
  let current = '';
  if (await exists(optionsFile)) {
    current = await fsp.readFile(optionsFile, 'utf8').catch(() => '');
  }
  const next = writeOptions(current, enabled);
  await ensureDir(path.dirname(optionsFile));
  await fsp.writeFile(optionsFile, next, 'utf8');
}

/* ------------------------------------------------------------ Применение */

async function applySkin(paths, config, versionId, clientJarPath, log = () => {}) {
  const { file, packDir } = skinPaths(paths);
  const enabled = config.skinEnabled !== false;

  if (!enabled) {
    await patchOptions(paths, false);
    return { applied: false, reason: 'disabled' };
  }
  if (!(await exists(file))) {
    await patchOptions(paths, false);
    return { applied: false, reason: 'empty' };
  }

  const buffer = await fsp.readFile(file);
  await writePack(paths, buffer, versionId, clientJarPath);
  await patchOptions(paths, true);
  log('info', `Скин применён через ресурспак ${packDir}.`);
  return { applied: true };
}

async function resetSkin(paths) {
  const { file, packDir, optionsFile } = skinPaths(paths);
  await fsp.rm(file, { force: true }).catch(() => {});
  await fsp.rm(packDir, { recursive: true, force: true }).catch(() => {});
  if (await exists(optionsFile)) {
    const text = await fsp.readFile(optionsFile, 'utf8').catch(() => '');
    await fsp.writeFile(optionsFile, writeOptions(text, false), 'utf8');
  }
}

module.exports = {
  PACK_ID,
  PACK_NAME,
  getSkin,
  saveSkinFile,
  applySkin,
  resetSkin,
  packFormatFor,
  packVersionFor,
  isLegacySkinVersion,
};
