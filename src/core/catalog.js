'use strict';

const fsp = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');

const {
  ensureDir,
  fetchJson,
  fetchWithTimeout,
  downloadFile,
  mapLimit,
  formatBytes,
} = require('./util');
const { downloadMany } = require('./download');
const { installLoader } = require('./loaders');

const API = 'https://api.modrinth.com/v2';

const KIND_META = {
  mod: { projectType: 'mod', label: 'Мод', folder: 'mods', extension: '.jar' },
  shader: { projectType: 'shader', label: 'Шейдеры', folder: 'shaderpacks', extension: '.zip' },
  modpack: { projectType: 'modpack', label: 'Сборка', folder: null, extension: null },
};

const LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge']);
const LOADER_LABELS = {
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

const SEARCH_LIMIT = 20;
const ICON_CACHE_LIMIT = 120;
const iconCache = new Map();

/* ------------------------------------------------------------- Утилиты */

function cleanVersion(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._+-]{1,40}$/.test(id)) {
    throw new Error('Укажите версию Minecraft, например 26.3.');
  }
  return id;
}

function cleanSlug(value) {
  const slug = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) throw new Error('Неверный идентификатор проекта.');
  return slug;
}

function cleanLoader(value) {
  const loader = String(value || 'fabric').trim();
  if (!LOADERS.has(loader)) throw new Error('Неизвестный загрузчик.');
  return loader;
}

function cleanFilename(value) {
  const name = path.basename(String(value || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  if (!name || name === '.' || name === '..') throw new Error('Проект вернул некорректное имя файла.');
  return name.slice(0, 180);
}

function safeJoin(root, relative) {
  const target = path.resolve(root, String(relative || '').replace(/\\/g, '/'));
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('В сборке найден недопустимый путь.');
  }
  return target;
}

function pickFile(version, extension) {
  const files = (version?.files || []).filter((file) => file?.url);
  if (!files.length) return null;
  const preferred = files.find(
    (file) => file.primary && (!extension || String(file.filename || '').toLowerCase().endsWith(extension)),
  );
  if (preferred) return preferred;
  return files.find((file) => !extension || String(file.filename || '').toLowerCase().endsWith(extension)) || files[0];
}

function pickVersion(versions) {
  const weight = { release: 0, beta: 1, alpha: 2 };
  return [...(versions || [])]
    .filter((version) => pickFile(version))
    .sort((a, b) => (weight[a.version_type] ?? 3) - (weight[b.version_type] ?? 3))[0] || null;
}

async function fetchProjectVersions(slug, options = {}) {
  const { gameVersion, loaders, signal } = options;
  const params = new URLSearchParams();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  if (loaders?.length) params.set('loaders', JSON.stringify(loaders));
  const query = params.toString();
  const url = `${API}/project/${encodeURIComponent(slug)}/version${query ? `?${query}` : ''}`;
  const list = await fetchJson(url, { signal, attempts: 3, timeout: 30000 });
  return Array.isArray(list) ? list : [];
}

/* --------------------------------------------------------------- Поиск */

async function iconDataUrl(url, signal) {
  if (!url) return null;
  if (iconCache.has(url)) return iconCache.get(url);
  let result = null;
  try {
    const response = await fetchWithTimeout(url, { signal, redirect: 'follow' }, 12000);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length && buffer.length <= 700 * 1024) {
        const mime = String(response.headers.get('content-type') || 'image/png').split(';')[0];
        result = `data:${mime};base64,${buffer.toString('base64')}`;
      }
    }
  } catch {
    result = null;
  }
  if (iconCache.size >= ICON_CACHE_LIMIT) {
    const first = iconCache.keys().next().value;
    if (first) iconCache.delete(first);
  }
  iconCache.set(url, result);
  return result;
}

function compareGameVersions(a, b) {
  const left = String(a).split('.').map((part) => Number(part) || 0);
  const right = String(b).split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Modrinth отдаёт все версии, включая снапшоты и пре-релизы.
// Для карточки оставляем только стабильные релизы, новые сверху.
function releaseGameVersions(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((value) => String(value || ''))
    .filter((value) => /^\d+\.\d+(?:\.\d+)?$/.test(value))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .sort(compareGameVersions)
    .reverse()
    .slice(0, 60);
}

function buildFacets(kind, gameVersion, loader) {
  if (kind === 'mod') {
    return [
      ['project_type:mod'],
      [`versions:${gameVersion}`],
      [`categories:${loader}`],
    ];
  }
  if (kind === 'shader') {
    return [['project_type:shader'], [`versions:${gameVersion}`], ['categories:iris']];
  }
  return [['project_type:modpack'], [`versions:${gameVersion}`]];
}

async function searchProjects(payload = {}) {
  const kind = KIND_META[payload.kind] ? payload.kind : 'mod';
  const gameVersion = cleanVersion(payload.gameVersion);
  const loader = kind === 'mod' ? cleanLoader(payload.loader) : null;
  const query = String(payload.query || '').trim().slice(0, 80);
  const offset = Math.max(0, Math.min(5000, Number(payload.offset) || 0));
  const limit = Math.max(1, Math.min(SEARCH_LIMIT, Number(payload.limit) || SEARCH_LIMIT));

  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    index: query ? 'relevance' : 'downloads',
  });
  if (query) params.set('query', query);
  params.set('facets', JSON.stringify(buildFacets(kind, gameVersion, loader)));

  const data = await fetchJson(`${API}/search?${params.toString()}`, { attempts: 3, timeout: 30000 });
  const raw = Array.isArray(data?.hits) ? data.hits : [];
  const icons = new Array(raw.length).fill(null);
  await mapLimit(
    raw,
    8,
    async (hit, index) => {
      icons[index] = await iconDataUrl(hit.icon_url, undefined);
    },
  ).catch(() => {});

  return {
    kind,
    gameVersion,
    loader,
    offset,
    total: Number(data?.total_hits) || 0,
    hits: raw.map((hit, index) => ({
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      author: hit.author,
      downloads: hit.downloads || 0,
      followers: hit.followers || 0,
      icon: icons[index],
      categories: Array.isArray(hit.categories) ? hit.categories.slice(0, 4) : [],
      versions: releaseGameVersions(hit.versions),
      projectType: hit.project_type || kind,
    })),
  };
}

/* ------------------------------------------------------ Установка файлов */

async function downloadProjectFile(file, dest, options) {
  const { signal, onLog, onProgress, label } = options;
  let received = 0;
  const total = Number(file.size) || 0;
  const name = path.basename(dest);
  let lastReport = 0;
  if (onProgress) {
    onProgress({ phase: 'catalog', label: label || 'Скачивание', percent: 0, detail: name });
  }
  await downloadFile({
    url: file.url,
    dest,
    sha1: file.hashes?.sha1 || null,
    size: total || null,
    signal,
    timeout: 120000,
    onRetry: (error, attempt) =>
      onLog?.('warn', `Повтор загрузки ${name} (${attempt}): ${error.message}`),
    onBytes: (delta) => {
      received += delta;
      const now = Date.now();
      if (!onProgress || (now - lastReport < 140 && received < total)) return;
      lastReport = now;
      onProgress({
        phase: 'catalog',
        label: label || 'Скачивание',
        percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null,
        detail: `${name} · ${formatBytes(Math.max(0, received))}${total ? ` из ${formatBytes(total)}` : ''}`,
      });
    },
  });
  if (onProgress) {
    onProgress({
      phase: 'catalog',
      label: label || 'Скачивание',
      percent: 100,
      detail: `${name} готов`,
    });
  }
  return dest;
}

function versionResult(version) {
  return {
    version: version.version_number || version.name || '',
    type: version.version_type || 'release',
    name: version.name || '',
    gameVersions: version.game_versions || [],
    loaders: version.loaders || [],
  };
}

/* --------------------------------------------------------- Зависимости */

async function collectDependencies(rootVersion, ctx, options) {
  const installed = [];
  const seen = new Set([rootVersion.project_id].filter(Boolean));
  const queue = (rootVersion.dependencies || [])
    .filter((dep) => dep?.dependency_type === 'required')
    .map((dep) => ({ dep, depth: 0 }));

  while (queue.length && installed.length < 6) {
    const { dep, depth } = queue.shift();
    const key = dep.project_id || dep.version_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    let version = null;
    try {
      if (dep.version_id) {
        version = await fetchJson(`${API}/version/${encodeURIComponent(dep.version_id)}`, {
          signal: options.signal,
          attempts: 2,
          timeout: 30000,
        });
      } else if (dep.project_id) {
        const list = await fetchProjectVersions(dep.project_id, {
          gameVersion: ctx.gameVersion,
          loaders: [ctx.loader],
          signal: options.signal,
        });
        version = pickVersion(list);
      }
    } catch (error) {
      options.onLog?.('warn', `Не удалось проверить зависимость: ${error.message}`);
      continue;
    }
    if (!version) continue;

    const file = pickFile(version, '.jar');
    if (!file) continue;
    const dest = path.join(ctx.modsDir, cleanFilename(file.filename));
    try {
      await downloadProjectFile(file, dest, {
        signal: options.signal,
        onLog: options.onLog,
        onProgress: options.onProgress,
        label: 'Зависимость',
      });
      installed.push({ title: version.name || path.basename(dest), file: dest, version: version.version_number });
      options.onLog?.('info', `Зависимость установлена: ${path.basename(dest)}`);
    } catch (error) {
      options.onLog?.('warn', `Зависимость не установлена (${path.basename(dest)}): ${error.message}`);
      continue;
    }

    if (depth < 1) {
      for (const next of version.dependencies || []) {
        if (next?.dependency_type === 'required') queue.push({ dep: next, depth: depth + 1 });
      }
    }
  }
  return installed;
}

/* ---------------------------------------------------- Мод или шейдер */

async function installProject(payload = {}, options = {}) {
  const kind = payload.kind === 'shader' ? 'shader' : 'mod';
  const meta = KIND_META[kind];
  const slug = cleanSlug(payload.slug);
  const gameVersion = cleanVersion(payload.gameVersion);
  const loader = kind === 'mod' ? cleanLoader(payload.loader) : null;
  const { signal, onLog } = options;

  const project = await fetchJson(`${API}/project/${encodeURIComponent(slug)}`, {
    signal,
    attempts: 3,
    timeout: 30000,
  }).catch(() => null);
  const title = project?.title || payload.title || slug;

  onLog?.('info', `${meta.label}: ${title} · Minecraft ${gameVersion}${loader ? ` · ${LOADER_LABELS[loader]}` : ''}`);
  if (loader) {
    onLog?.('info', `Ищем версию для ${LOADER_LABELS[loader]}…`);
  }

  const versions = await fetchProjectVersions(slug, {
    gameVersion,
    loaders: kind === 'mod' ? [loader] : undefined,
    signal,
  });
  const version = pickVersion(versions);
  if (!version) {
    throw new Error(
      kind === 'mod'
        ? `Для Minecraft ${gameVersion} и ${LOADER_LABELS[loader]} подходящих версий нет.`
        : `Для Minecraft ${gameVersion} подходящих шейдеров нет.`,
    );
  }

  const file = pickFile(version, meta.extension);
  if (!file) throw new Error('У проекта нет файла для скачивания.');

  const folder = path.join(options.paths.gameDir, meta.folder);
  await ensureDir(folder);
  const dest = path.join(folder, cleanFilename(file.filename));
  onLog?.('info', `Файл: ${path.basename(dest)} · ${formatBytes(file.size || 0)}`);
  await downloadProjectFile(file, dest, {
    signal,
    onLog,
    onProgress: options.onProgress,
    label: title,
  });

  let dependencies = [];
  if (kind === 'mod') {
    dependencies = await collectDependencies(version, {
      gameVersion,
      loader,
      modsDir: folder,
    }, options);
  }

  return {
    ok: true,
    kind,
    title,
    slug,
    file: dest,
    folder,
    ...versionResult(version),
    dependencies,
    message:
      `${title} ${version.version_number || ''} установлен в ${meta.folder}` +
      (dependencies.length ? ` (+${dependencies.length} зависимостей)` : ''),
  };
}

/* ------------------------------------------------------ Сборка .mrpack */

function loaderFromDependencies(dependencies = {}) {
  const candidates = [
    ['fabric-loader', 'fabric'],
    ['quilt-loader', 'quilt'],
    ['neoforge', 'neoforge'],
    ['forge', 'forge'],
  ];
  for (const [key, kind] of candidates) {
    if (dependencies[key]) return { kind, version: String(dependencies[key]) };
  }
  return null;
}

async function applyOverrides(zip, root, prefixes, onLog) {
  let copied = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const prefix = prefixes.find((item) => entry.entryName.startsWith(item));
    if (!prefix) continue;
    const relative = entry.entryName.slice(prefix.length);
    if (!relative) continue;
    const dest = safeJoin(root, relative);
    await ensureDir(path.dirname(dest));
    await fsp.writeFile(dest, entry.getData());
    copied += 1;
  }
  if (copied) onLog?.('info', `Файлы сборки (overrides): ${copied}.`);
  return copied;
}

async function installPack(payload = {}, options = {}) {
  const slug = cleanSlug(payload.slug);
  const gameVersion = cleanVersion(payload.gameVersion);
  const { signal, onLog } = options;

  const project = await fetchJson(`${API}/project/${encodeURIComponent(slug)}`, {
    signal,
    attempts: 3,
    timeout: 30000,
  }).catch(() => null);
  const title = project?.title || payload.title || slug;

  onLog?.('info', `Сборка: ${title} · Minecraft ${gameVersion}`);
  const versions = await fetchProjectVersions(slug, { gameVersion, signal });
  const version = pickVersion(versions);
  if (!version) throw new Error(`Для Minecraft ${gameVersion} у сборки нет подходящей версии.`);

  const file = pickFile(version, '.mrpack');
  if (!file) throw new Error('У сборки нет файла .mrpack.');

  const cacheDir = path.join(options.paths.dataDir, 'cache');
  await ensureDir(cacheDir);
  const archive = path.join(cacheDir, `${slug}-${cleanFilename(version.id || 'pack')}.mrpack`);
  onLog?.('info', `Загрузка сборки: ${path.basename(file.filename)} · ${formatBytes(file.size || 0)}`);
  await downloadProjectFile(file, archive, {
    signal,
    onLog,
    onProgress: options.onProgress,
    label: 'Сборка',
  });

  let index;
  let zip;
  try {
    zip = new AdmZip(archive);
    const entry = zip.getEntry('modrinth.index.json');
    if (!entry) throw new Error('В архиве нет modrinth.index.json — это не сборка Modrinth.');
    index = JSON.parse(entry.getData().toString('utf8'));
  } catch (error) {
    throw new Error(`Не удалось прочитать сборку: ${error.message}`);
  }

  if (index?.game && index.game !== 'minecraft') {
    throw new Error('Сборка предназначена не для Minecraft.');
  }

  const packName = index.name || title;
  const packVersion = index.versionId || version.version_number || '';
  onLog?.('info', `Сборка «${packName}${packVersion ? ` ${packVersion}` : ''}»: подготовка файлов…`);

  const tasks = [];
  const seen = new Set();
  for (const item of index.files || []) {
    if (item?.env?.client === 'unsupported') continue;
    if (!item?.path || !Array.isArray(item.downloads) || !item.downloads.length) continue;
    const dest = safeJoin(options.paths.gameDir, item.path);
    const key = path.normalize(dest);
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({
      url: item.downloads[0],
      dest,
      sha1: item.hashes?.sha1 || null,
      size: Number(item.fileSize) || null,
    });
  }

  if (tasks.length) {
    onLog?.('info', `Файлов в сборке: ${tasks.length}, всего ${formatBytes(
      tasks.reduce((sum, task) => sum + (task.size || 0), 0),
    )}.`);
    await downloadMany(tasks, {
      label: `Сборка ${packName}`,
      phase: 'pack',
      concurrency: 8,
      signal,
      onProgress: (progress) => options.onProgress?.(progress),
      onLog,
    });
  }

  const overrides = await applyOverrides(
    zip,
    options.paths.gameDir,
    ['overrides/', 'client-overrides/'],
    onLog,
  );

  const loaderInfo = loaderFromDependencies(index.dependencies);
  let loaderId = null;
  if (loaderInfo) {
    onLog?.(
      'info',
      `Установка загрузчика: ${LOADER_LABELS[loaderInfo.kind] || loaderInfo.kind} ${loaderInfo.version}…`,
    );
    const result = await installLoader(
      {
        kind: loaderInfo.kind,
        gameVersion: String(index.dependencies?.minecraft || gameVersion),
        loaderVersion: loaderInfo.version,
      },
      {
        paths: options.paths,
        config: options.config,
        signal,
        onLog,
        onProgress: (progress) =>
          options.onProgress?.({
            phase: 'loader',
            label: `Загрузчик ${LOADER_LABELS[loaderInfo.kind] || loaderInfo.kind}`,
            percent: progress?.percent ?? null,
            detail: progress?.detail || progress?.label || '',
          }),
      },
    );
    loaderId = result?.id || null;
    if (loaderId) onLog?.('info', `Версия сборки в библиотеке: ${loaderId}`);
  } else {
    onLog?.('warn', 'В сборке не указан загрузчик — файлы установлены, версию нужно выбрать вручную.');
  }

  await fsp.rm(archive, { force: true }).catch(() => {});

  return {
    ok: true,
    kind: 'modpack',
    title: packName,
    slug,
    version: packVersion,
    id: loaderId,
    files: tasks.length,
    overrides,
    folder: options.paths.gameDir,
    message: `Сборка «${packName}» установлена${loaderId ? ` · версия ${loaderId}` : ''}`,
  };
}

module.exports = {
  KIND_META,
  LOADER_LABELS,
  searchProjects,
  installProject,
  installPack,
  safeJoin,
};
