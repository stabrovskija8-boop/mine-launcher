'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const {
  ensureDir,
  exists,
  fetchJson,
  readJson,
  writeJson,
  downloadFile,
  formatBytes,
} = require('./util');
const { ensureJava, minecraftRuntimeDirs } = require('./java');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases';
const INSTALLER_DIR = 'loaders';

const LOADERS = {
  fabric: { label: 'Fabric', mainClassDefault: true },
  quilt: { label: 'Quilt', mainClassDefault: true },
  forge: { label: 'Forge', mainClassDefault: false },
  neoforge: { label: 'NeoForge', mainClassDefault: false },
  optifine: { label: 'OptiFine', mainClassDefault: false },
};

function sanitizeVersionId(id) {
  const value = String(id || '').trim();
  if (!value) throw new Error('Не указана версия игры.');
  return value;
}

function versionsDir(paths) {
  return path.join(paths.gameDir, 'versions');
}

async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- Fabric */

async function fabricVersions(gameVersion, options = {}) {
  const { signal } = options;
  const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`;
  const list = await fetchJson(url, { signal, attempts: 3, timeout: 30000 });
  return (Array.isArray(list) ? list : [])
    .filter((item) => item?.loader?.version)
    .map((item) => ({
      version: item.loader.version,
      stable: item.loader.stable !== false,
    }))
    .slice(0, 40);
}

async function fabricProfile(gameVersion, loaderVersion, options = {}) {
  const { signal } = options;
  const url =
    `${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}/` +
    `${encodeURIComponent(loaderVersion)}/profile/json`;
  return fetchJson(url, { signal, attempts: 3, timeout: 30000 });
}

/* ----------------------------------------------------------------- Quilt */

async function quiltVersions(gameVersion, options = {}) {
  const { signal } = options;
  const url = `${QUILT_META}/versions/loader/${encodeURIComponent(gameVersion)}`;
  const list = await fetchJson(url, { signal, attempts: 3, timeout: 30000 });
  return (Array.isArray(list) ? list : [])
    .filter((item) => item?.loader?.version)
    .map((item) => ({
      version: item.loader.version,
      stable: !/beta|pre|rc/i.test(String(item.loader.version)),
    }))
    .slice(0, 40);
}

async function quiltProfile(gameVersion, loaderVersion, options = {}) {
  const { signal } = options;
  const url =
    `${QUILT_META}/versions/loader/${encodeURIComponent(gameVersion)}/` +
    `${encodeURIComponent(loaderVersion)}/profile/json`;
  return fetchJson(url, { signal, attempts: 3, timeout: 30000 });
}

/* ----------------------------------------------------------- Forge/NeoForge */

function parseMavenVersions(xml) {
  const versions = [];
  const re = /<version>([^<]+)<\/version>/g;
  let match;
  while ((match = re.exec(String(xml || '')))) versions.push(match[1].trim());
  return versions;
}

async function readMavenMetadata(baseUrl, signal) {
  const response = await fetch(`${baseUrl}/maven-metadata.xml`, { signal });
  if (!response.ok) throw new Error(`Сервер версий ответил HTTP ${response.status}`);
  return parseMavenVersions(await response.text());
}

function compareLoose(a, b) {
  const pa = String(a).split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const pb = String(b).split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (String(x) !== String(y)) {
      return String(x).localeCompare(String(y));
    }
  }
  return 0;
}

async function forgeVersions(gameVersion, options = {}) {
  const { signal } = options;
  const all = await readMavenMetadata(`${FORGE_MAVEN}/net/minecraftforge/forge`, signal);
  return all
    .filter((version) => version.startsWith(`${gameVersion}-`))
    .sort((a, b) => compareLoose(b, a))
    .slice(0, 40)
    .map((version) => ({ version, gameVersion, stable: !/beta|alpha/i.test(version) }));
}

function neoforgePrefix(gameVersion) {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(gameVersion);
  if (!match) return null;
  const minor = Number(match[1]);
  const patch = Number(match[2] || 0);
  if (minor < 20 || (minor === 20 && patch < 2)) return null;
  return `${minor}.${patch}.`;
}

async function neoforgeVersions(gameVersion, options = {}) {
  const { signal } = options;
  const prefix = neoforgePrefix(gameVersion);
  if (!prefix) return [];
  const all = await readMavenMetadata(`${NEOFORGE_MAVEN}/net/neoforged/neoforge`, signal);
  return all
    .filter((version) => version.startsWith(prefix) && !/beta|alpha/i.test(version))
    .sort((a, b) => compareLoose(b, a))
    .slice(0, 30)
    .map((version) => ({ version, gameVersion, stable: true }));
}

/* ------------------------------------------------------- Установка модов */

async function writeVersionJson(paths, id, data) {
  const dir = path.join(versionsDir(paths), id);
  await ensureDir(dir);
  await writeJson(path.join(dir, `${id}.json`), data);
  return dir;
}

function installerPath(paths, filename) {
  return path.join(paths.dataDir, INSTALLER_DIR, filename);
}

function runJava(javaPath, args, options = {}) {
  const { cwd, signal, onLog = () => {} } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const push = (level, chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      if (output.length > 20000) output = output.slice(-12000);
      for (const line of text.split(/\r?\n/)) {
        const value = line.trim();
        if (value) onLog(level, value.slice(0, 500));
      }
    };
    child.stdout?.on('data', (chunk) => push('info', chunk));
    child.stderr?.on('data', (chunk) => push('warn', chunk));

    const onAbort = () => {
      child.kill();
      reject(new Error('Установка отменена'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Установка отменена'));
      if (code === 0) return resolve(output);
      reject(new Error(`Установщик завершился с кодом ${code}. Подробности — в консоли.`));
    });
  });
}

async function javaForGame(gameVersion, paths, config, signal, onLog) {
  const { getVersionData } = require('./mojang');
  const { requiredJavaMajor } = require('./launch');
  let major = 8;
  try {
    const { data } = await getVersionData(gameVersion, paths, { signal });
    major = requiredJavaMajor(data) || 8;
  } catch {
    /* если не удалось узнать — используем Java 8 */
  }
  return ensureJava(major, {
    customPath: config.javaPath,
    javaDir: paths.javaDir,
    extraDirs: minecraftRuntimeDirs(config.gameDir),
    signal,
    log: onLog,
  });
}

async function installFabric(payload, options) {
  const { gameVersion, loaderVersion } = payload;
  const { signal, onLog } = options;
  onLog('info', `Загрузка профиля Fabric ${loaderVersion} для ${gameVersion}…`);
  const profile = await fabricProfile(gameVersion, loaderVersion, { signal });
  if (!profile || typeof profile !== 'object') {
    throw new Error('Fabric вернул пустой профиль версии.');
  }
  const id = profile.id || `fabric-loader-${loaderVersion}-${gameVersion}`;
  profile.id = id;
  profile.type = 'release';
  profile.inheritsFrom = profile.inheritsFrom || gameVersion;
  profile.releaseTime = profile.releaseTime || new Date().toISOString();
  await writeVersionJson(options.paths, id, profile);
  onLog('info', `Fabric установлен: ${id}`);
  return { id };
}

async function installQuilt(payload, options) {
  const { gameVersion, loaderVersion } = payload;
  const { signal, onLog } = options;
  onLog('info', `Загрузка профиля Quilt ${loaderVersion} для ${gameVersion}…`);
  const profile = await quiltProfile(gameVersion, loaderVersion, { signal });
  if (!profile || typeof profile !== 'object') {
    throw new Error('Quilt вернул пустой профиль версии.');
  }
  const id = profile.id || `quilt-loader-${loaderVersion}-${gameVersion}`;
  profile.id = id;
  profile.type = 'release';
  profile.inheritsFrom = profile.inheritsFrom || gameVersion;
  profile.releaseTime = profile.releaseTime || new Date().toISOString();
  await writeVersionJson(options.paths, id, profile);
  onLog('info', `Quilt установлен: ${id}`);
  return { id };
}

function detectInstalledVersion(paths, matcher, since) {
  return listDirs(versionsDir(paths)).then(async (names) => {
    for (const name of names) {
      if (!matcher(name)) continue;
      const stat = await fsp.stat(path.join(versionsDir(paths), name)).catch(() => null);
      if (!stat) continue;
      if (since && stat.mtimeMs + 1000 < since) continue;
      return name;
    }
    return null;
  });
}

async function ensureLauncherProfiles(paths) {
  const file = path.join(paths.gameDir, 'launcher_profiles.json');
  if (await exists(file)) return;
  await ensureDir(paths.gameDir);
  await writeJson(file, { profiles: {}, settings: {}, version: 3 });
}

async function installForgeLike(payload, options, kind) {
  const { gameVersion } = payload;
  const { paths, config, signal, onLog, onProgress } = options;
  const isNeo = kind === 'neoforge';
  const list = isNeo
    ? await neoforgeVersions(gameVersion, { signal })
    : await forgeVersions(gameVersion, { signal });
  if (!list.length) {
    throw new Error(
      isNeo
        ? `NeoForge не поддерживает Minecraft ${gameVersion}.`
        : `Для Minecraft ${gameVersion} нет сборок Forge.`,
    );
  }
  const version = payload.loaderVersion || list[0].version;
  const entry = list.find((item) => item.version === version);
  if (!entry) throw new Error(`Версия ${kind} ${version} не найдена.`);

  const fileName = isNeo
    ? `neoforge-${version}-installer.jar`
    : `forge-${version}-installer.jar`;
  const url = isNeo
    ? `${NEOFORGE_MAVEN}/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
    : `${FORGE_MAVEN}/net/minecraftforge/forge/${version}/forge-${version}-installer.jar`;
  const jarPath = installerPath(paths, fileName);
  await ensureDir(path.dirname(jarPath));

  onProgress?.({ phase: 'loader', label: `Загрузка ${kind}`, percent: 0, detail: version });
  await downloadFile({
    url,
    dest: jarPath,
    signal,
    attempts: 3,
    onRetry: (error, attempt) => onLog('warn', `Повтор загрузки установщика (${attempt}): ${error.message}`),
  });

  const java = await javaForGame(gameVersion, paths, config, signal, onLog);
  onLog('info', `Запуск установщика ${kind} ${version} (Java ${java.major})…`);
  onProgress?.({
    phase: 'loader',
    label: `Установка ${kind}`,
    percent: null,
    detail: 'Установщик скачивает библиотеки…',
  });

  const started = Date.now();
  await ensureDir(paths.gameDir);
  await ensureLauncherProfiles(paths);
  await runJava(java.path, ['-jar', jarPath, '--installClient'], {
    cwd: paths.gameDir,
    signal,
    onLog,
  });

  const matcher = isNeo
    ? (name) => /neoforge/i.test(name)
    : (name) => /forge/i.test(name) && !/neoforge/i.test(name);
  let id = await detectInstalledVersion(paths, matcher, started);
  if (!id) {
    // Установщик мог проигнорировать папку и поставить в стандартный .minecraft.
    const fallback = path.join(
      process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
      '.minecraft',
    );
    if (path.resolve(fallback) !== path.resolve(paths.gameDir)) {
      const found = await detectInstalledVersion({ gameDir: fallback }, matcher, started);
      if (found) {
        const from = path.join(fallback, 'versions', found);
        const to = path.join(paths.gameDir, 'versions', found);
        await fsp.cp(from, to, { recursive: true, force: true });
        id = found;
        onLog('warn', `Версия ${found} была установлена в стандартную папку и скопирована в папку игры.`);
      }
    }
  }
  if (!id) throw new Error('Установщик завершился, но версия не появилась в папке versions.');

  onProgress?.({ phase: 'loader', label: `${kind} установлен`, percent: 100, detail: id });
  onLog('info', `${kind} установлен: ${id}`);
  return { id };
}

/* --------------------------------------------------------------- OptiFine */

function optifineGameVersion(jarName) {
  const match = /(?:OptiFine[_-]?)?(\d+\.\d+(?:\.\d+)?)/i.exec(String(jarName || ''));
  return match ? match[1] : null;
}

async function installOptiFine(payload, options) {
  const { jarPath } = payload;
  const { paths, config, signal, onLog, onProgress } = options;
  if (!jarPath || !(await exists(jarPath))) {
    throw new Error('Установщик OptiFine не найден. Скачайте его с optifine.net и выберите файл.');
  }
  const fileName = path.basename(jarPath);
  const gameVersion = optifineGameVersion(fileName);
  const java = await javaForGame(gameVersion || '1.20.1', paths, config, signal, onLog);

  onLog('info', `Запуск установщика OptiFine (${fileName}). В открывшемся окне нажмите Install.`);
  onProgress?.({
    phase: 'loader',
    label: 'Установка OptiFine',
    percent: null,
    detail: 'Подтвердите установку в окне OptiFine',
  });

  const started = Date.now();
  await ensureDir(paths.gameDir);
  await ensureLauncherProfiles(paths);
  await runJava(java.path, ['-jar', jarPath], {
    cwd: paths.gameDir,
    signal,
    onLog,
  });

  let id = await detectInstalledVersion(paths, (name) => /optifine/i.test(name), started);
  if (!id) {
    id = await detectInstalledVersion(paths, (name) => /optifine/i.test(name), null);
  }
  if (!id) {
    throw new Error(
      'Установщик закрылся, но версия OptiFine не найдена. Убедитесь, что в окне установщика нажали «Install».',
    );
  }
  onProgress?.({ phase: 'loader', label: 'OptiFine установлен', percent: 100, detail: id });
  onLog('info', `OptiFine установлен: ${id}`);
  return { id };
}

/* -------------------------------------------------------------- Каталог */

async function loaderVersions(kind, gameVersion, options = {}) {
  const game = sanitizeVersionId(gameVersion);
  if (!LOADERS[kind]) throw new Error('Неизвестный загрузчик.');
  if (kind === 'fabric') return fabricVersions(game, options);
  if (kind === 'quilt') return quiltVersions(game, options);
  if (kind === 'forge') return forgeVersions(game, options);
  if (kind === 'neoforge') return neoforgeVersions(game, options);
  return [];
}

async function installLoader(payload, options) {
  const kind = String(payload?.kind || '');
  if (!LOADERS[kind]) throw new Error('Неизвестный загрузчик.');
  const gameVersion = sanitizeVersionId(payload?.gameVersion);

  if (kind === 'fabric') {
    const list = await fabricVersions(gameVersion, { signal: options.signal });
    if (!list.length) throw new Error(`Fabric не поддерживает Minecraft ${gameVersion}.`);
    const loaderVersion = payload.loaderVersion || list[0].version;
    return installFabric({ gameVersion, loaderVersion }, options);
  }
  if (kind === 'quilt') {
    const list = await quiltVersions(gameVersion, { signal: options.signal });
    if (!list.length) throw new Error(`Quilt не поддерживает Minecraft ${gameVersion}.`);
    const loaderVersion = payload.loaderVersion || list[0].version;
    return installQuilt({ gameVersion, loaderVersion }, options);
  }
  if (kind === 'forge' || kind === 'neoforge') {
    return installForgeLike({ ...payload, gameVersion }, options, kind);
  }
  if (kind === 'optifine') {
    return installOptiFine(payload, options);
  }
  throw new Error('Неизвестный загрузчик.');
}

module.exports = {
  LOADERS,
  loaderVersions,
  installLoader,
  optifineGameVersion,
  formatBytes,
};
