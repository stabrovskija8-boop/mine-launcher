'use strict';

const fsp = require('fs/promises');
const path = require('path');

const { ensureDir, exists, fetchJson, readJson, writeJson } = require('./util');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const remoteCache = new Map();

function manifestPath(paths) {
  return path.join(paths.metaDir, 'manifest.json');
}

function versionMetaPath(paths, id) {
  return path.join(paths.metaDir, 'versions', `${id}.json`);
}

async function readCachedManifest(paths) {
  return readJson(manifestPath(paths));
}

async function getManifest(paths, options = {}) {
  const { force = false, signal } = options;
  const cached = await readCachedManifest(paths);

  if (!force && cached) return { ...cached, offline: false };

  try {
    const manifest = await fetchJson(MANIFEST_URL, { signal, attempts: 3, timeout: 30000 });
    manifest.fetchedAt = Date.now();
    await writeJson(manifestPath(paths), manifest);
    return { ...manifest, offline: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (cached) {
      return {
        ...cached,
        offline: true,
        error: 'Не удалось обновить список версий. Показан сохранённый список.',
      };
    }
    const friendly = new Error(
      'Не удалось подключиться к серверам Mojang. Проверьте интернет и попробуйте снова.',
    );
    friendly.cause = error;
    throw friendly;
  }
}

async function findManifestVersion(paths, id, options = {}) {
  const { signal } = options;
  let manifest = await readCachedManifest(paths);
  if (!manifest) {
    try {
      manifest = await getManifest(paths, { signal });
    } catch {
      manifest = null;
    }
  }
  return manifest?.versions?.find((version) => version.id === id) || null;
}

async function getVersionData(id, paths, options = {}) {
  const { signal, source = 'auto' } = options;
  const localPath = path.join(paths.gameDir, 'versions', id, `${id}.json`);

  if (source !== 'remote' && (await exists(localPath))) {
    const local = await readJson(localPath);
    if (local) return { data: local, local: true };
  }

  if (source === 'local') {
    const local = await readJson(localPath);
    if (local) return { data: local, local: true };
    throw new Error(`Версия ${id} не установлена.`);
  }

  const cachedMeta = await readJson(versionMetaPath(paths, id));
  if (cachedMeta) return { data: cachedMeta, local: false, cached: true };

  if (remoteCache.has(id)) return remoteCache.get(id);

  const promise = (async () => {
    const entry = await findManifestVersion(paths, id, { signal });
    if (!entry?.url) {
      const local = await readJson(localPath);
      if (local) return { data: local, local: true };
      throw new Error(`Версия ${id} не найдена в списке Mojang.`);
    }
    let data;
    try {
      data = await fetchJson(entry.url, { signal, attempts: 3, timeout: 30000 });
    } catch (error) {
      if (signal?.aborted) throw error;
      const local = await readJson(localPath);
      if (local) return { data: local, local: true };
      const friendly = new Error(
        `Не удалось загрузить данные версии ${id}. Проверьте подключение к интернету.`,
      );
      friendly.cause = error;
      throw friendly;
    }
    await writeJson(versionMetaPath(paths, id), data);
    return { data, local: false };
  })();

  remoteCache.set(id, promise);
  try {
    return await promise;
  } finally {
    remoteCache.delete(id);
  }
}

function libraryKey(name) {
  if (typeof name !== 'string') return null;
  const parts = name.split(':');
  if (parts.length < 3) return name;
  const [group, artifact, , classifier] = parts;
  return `${group}:${artifact}${classifier ? `:${classifier}` : ''}`;
}

function mergeLibraries(parentLibraries = [], childLibraries = []) {
  const result = [];
  const positions = new Map();
  for (const library of [...parentLibraries, ...childLibraries]) {
    if (!library) continue;
    const key = libraryKey(library.name);
    if (key && positions.has(key)) {
      result[positions.get(key)] = library;
    } else {
      if (key) positions.set(key, result.length);
      result.push(library);
    }
  }
  return result;
}

function mergeVersions(parent, child) {
  const merged = { ...parent, ...child };

  merged.libraries = mergeLibraries(parent.libraries, child.libraries);
  merged.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) };

  if (child.minecraftArguments) {
    merged.minecraftArguments = child.minecraftArguments;
    delete merged.arguments;
  } else if (parent.minecraftArguments && !child.arguments) {
    merged.minecraftArguments = parent.minecraftArguments;
  } else if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])],
    };
  }

  if (!child.assetIndex && parent.assetIndex) merged.assetIndex = parent.assetIndex;
  if (!child.assets && parent.assets) merged.assets = parent.assets;
  if (!child.javaVersion && parent.javaVersion) merged.javaVersion = parent.javaVersion;
  if (!child.mainClass && parent.mainClass) merged.mainClass = parent.mainClass;
  if (!child.logging && parent.logging) merged.logging = parent.logging;
  return merged;
}

async function resolveVersion(id, paths, options = {}) {
  const { signal, source = 'auto' } = options;
  const chain = [];
  const seen = new Set();
  let currentId = id;

  while (currentId) {
    if (seen.has(currentId)) throw new Error(`Циклическое наследование версий: ${currentId}`);
    seen.add(currentId);
    const entry = await getVersionData(currentId, paths, { signal, source });
    chain.unshift({ id: currentId, ...entry });
    currentId = entry.data.inheritsFrom;
    if (chain.length > 10) throw new Error('Слишком длинная цепочка наследования версий.');
  }

  let merged = chain[0].data;
  for (let i = 1; i < chain.length; i += 1) {
    merged = mergeVersions(merged, chain[i].data);
  }
  merged.id = id;

  return {
    version: merged,
    chain: chain.map(({ id: chainId, data, local }) => ({ id: chainId, data, local })),
    local: chain[chain.length - 1].local,
  };
}

async function hasLocalJar(paths, id, depth = 0) {
  if (depth > 4) return false;
  if (await exists(path.join(paths.gameDir, 'versions', id, `${id}.jar`))) return true;
  const localJson = await readJson(path.join(paths.gameDir, 'versions', id, `${id}.json`));
  if (localJson?.inheritsFrom) return hasLocalJar(paths, localJson.inheritsFrom, depth + 1);
  return false;
}

async function listLocalVersions(paths) {
  const versionsDir = path.join(paths.gameDir, 'versions');
  let entries;
  try {
    entries = await fsp.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const jsonPath = path.join(versionsDir, id, `${id}.json`);
    const data = await readJson(jsonPath);
    if (!data) continue;
    result.push({
      id,
      type: data.type || 'release',
      releaseTime: data.releaseTime || data.time || null,
      inheritsFrom: data.inheritsFrom || null,
      jar: await hasLocalJar(paths, id),
      local: true,
    });
  }

  result.sort((a, b) => String(b.releaseTime || '').localeCompare(String(a.releaseTime || '')));
  return result;
}

module.exports = {
  MANIFEST_URL,
  readCachedManifest,
  getManifest,
  getVersionData,
  resolveVersion,
  listLocalVersions,
  hasLocalJar,
  libraryKey,
};
