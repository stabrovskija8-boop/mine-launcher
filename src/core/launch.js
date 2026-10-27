'use strict';

const path = require('path');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const { resolveVersion } = require('./mojang');
const { isAllowed, collectArguments, getOsName } = require('./rules');
const {
  ensureDir,
  exists,
  fileSize,
  writeJson,
  formatBytes,
  offlineUuid,
  LineSplitter,
  downloadFile,
} = require('./util');
const { downloadMany } = require('./download');
const { ensureJava, findJava, minecraftRuntimeDirs } = require('./java');
const { applySkin } = require('./skin');

const APP_NAME = 'MINE Launcher';
const APP_VERSION = '1.0.0';
const ASSET_CDN = 'https://resources.download.minecraft.net';

function requiredJavaMajor(version) {
  const major = Number(version?.javaVersion?.majorVersion);
  return Number.isFinite(major) && major > 0 ? major : 8;
}

function archClassifier() {
  if (process.arch === 'ia32') return '32';
  if (process.arch === 'arm64') return 'arm64';
  return '64';
}

function classifierFromName(name) {
  if (typeof name !== 'string') return null;
  const parts = name.split(':');
  if (parts.length < 4) return null;
  const classifier = parts.slice(3).join(':');
  return /^natives-/i.test(classifier) ? classifier : null;
}

function classifierFromArtifactPath(artifactPath) {
  if (typeof artifactPath !== 'string') return null;
  const file = path.basename(artifactPath, '.jar');
  const match = /(?:^|[-_])(natives-[A-Za-z0-9._-]+)$/i.exec(file);
  return match ? match[1] : null;
}

function classifierArch(classifier) {
  const value = String(classifier || '').toLowerCase();
  if (/(arm64|aarch[_-]?64)/.test(value)) return 'arm64';
  if (/(x86_64|amd64|x64|(?:^|[-_])64(?:$|[-_]))/.test(value)) return 'x64';
  if (/((?:^|[-_])x86(?:$|[-_])|i[3-6]86|win32|(?:^|[-_])32(?:$|[-_]))/.test(value)) return 'ia32';
  return null;
}

function hostArch() {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'ia32') return 'ia32';
  return 'x64';
}

function classifierAllowed(classifier) {
  const value = String(classifier || '').toLowerCase();
  if (!value) return false;

  let classifierOs = null;
  if (value.includes('windows')) classifierOs = 'windows';
  else if (value.includes('linux')) classifierOs = 'linux';
  else if (value.includes('macos') || value.includes('osx') || value.includes('darwin')) classifierOs = 'osx';
  if (classifierOs && classifierOs !== getOsName()) return false;

  const arch = classifierArch(value);
  if (!arch) return hostArch() !== 'arm64';
  return arch === hostArch();
}

function findNativeClassifier(library) {
  if (library?.natives) {
    const raw = library.natives[getOsName()];
    if (!raw) return null;
    return raw.replace('${arch}', archClassifier());
  }
  return (
    classifierFromName(library?.name) ||
    classifierFromArtifactPath(library?.downloads?.artifact?.path)
  );
}

function isNativeLibrary(library) {
  if (library?.natives) return true;
  return Boolean(
    classifierFromName(library?.name) ||
      classifierFromArtifactPath(library?.downloads?.artifact?.path),
  );
}

function nativeClassifier(library) {
  if (!isNativeLibrary(library)) return null;
  const classifier = findNativeClassifier(library);
  if (!classifier || !classifierAllowed(classifier)) return null;
  return { preferred: classifier, raw: classifier };
}

function pickNativeArtifact(library, classifier) {
  const classifiers = library?.downloads?.classifiers;
  if (!classifiers) return null;
  const candidates = [];
  if (classifier) {
    candidates.push(classifier.preferred);
    if (classifier.preferred.endsWith('-64')) candidates.push(classifier.preferred.slice(0, -3));
    if (classifier.preferred.endsWith('-arm64')) candidates.push('natives-windows');
    candidates.push(classifier.raw?.replace('${arch}', '64'), 'natives-windows-64', 'natives-windows');
  } else {
    candidates.push('natives-windows-64', 'natives-windows');
  }
  for (const key of candidates.filter(Boolean)) {
    if (classifiers[key]?.path) return classifiers[key];
  }
  const first = Object.values(classifiers).find((artifact) => artifact?.path);
  return first || null;
}

function mavenArtifact(library, classifierOverride = null) {
  const name = library?.name;
  if (typeof name !== 'string') return null;
  const parts = name.split(':');
  if (parts.length < 3) return null;
  const [group, artifact, version, classifierFromName] = parts;
  const classifier = classifierOverride || classifierFromName || null;
  const filename = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  const artifactPath = `${group.replace(/\./g, '/')}/${artifact}/${version}/${filename}`;
  const base = (library.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/');
  return { path: artifactPath, url: base + artifactPath, size: null, sha1: null };
}

function resolveLibraryArtifact(library, classifier = null) {
  if (classifier) {
    const nativeArtifact = pickNativeArtifact(library, classifier);
    if (nativeArtifact) return nativeArtifact;
  }
  const artifact = library?.downloads?.artifact;
  if (artifact?.path) {
    return {
      ...artifact,
      url:
        artifact.url ||
        `${(library.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/')}${artifact.path}`,
    };
  }
  return mavenArtifact(library, classifier?.preferred);
}

function collectLibraries(version, features, paths) {
  const tasks = [];
  const nativeJars = [];
  const classpath = [];
  const seen = new Set();

  for (const library of version.libraries || []) {
    if (!isAllowed(library.rules, features)) continue;
    const isNative = isNativeLibrary(library);
    const classifier = isNative ? nativeClassifier(library) : null;
    if (isNative && !classifier) continue;
    const artifact = resolveLibraryArtifact(library, classifier);
    if (!artifact?.path) continue;

    const dest = path.join(paths.librariesDir, artifact.path);
    if (!seen.has(dest)) {
      seen.add(dest);
      tasks.push({
        url: artifact.url,
        dest,
        sha1: artifact.sha1 || null,
        size: Number.isFinite(artifact.size) ? artifact.size : null,
        kind: isNative ? 'native' : 'library',
      });
    }
    if (isNative) {
      nativeJars.push({ jarPath: dest, extract: library.extract || null });
      // Современные версии (26.x) не распаковывают нативы заранее, а просят
      // LWJGL/JNA извлечь их из jar во время запуска
      // (-Dorg.lwjgl.system.SharedLibraryExtractPath). Поэтому нативные jar
      // должны быть в classpath; для старых версий это безвредно.
      classpath.push(dest);
    } else {
      classpath.push(dest);
    }
  }

  return { tasks, nativeJars, classpath, seen };
}

function estimateInstallSize(version, features) {
  let librariesBytes = 0;
  let clientBytes = 0;
  const seen = new Set();
  for (const library of version.libraries || []) {
    if (!isAllowed(library.rules, features)) continue;
    const isNative = isNativeLibrary(library);
    const classifier = isNative ? nativeClassifier(library) : null;
    if (isNative && !classifier) continue;
    const artifact = resolveLibraryArtifact(library, classifier);
    if (!artifact?.path || seen.has(artifact.path)) continue;
    seen.add(artifact.path);
    librariesBytes += Number(artifact.size) || 0;
  }
  clientBytes = Number(version.downloads?.client?.size) || 0;
  const assetsBytes = Number(version.assetIndex?.totalSize) || 0;
  const loggingBytes = Number(version.logging?.client?.file?.size) || 0;
  return {
    librariesBytes,
    clientBytes,
    assetsBytes,
    loggingBytes,
    totalBytes: librariesBytes + clientBytes + assetsBytes + loggingBytes,
  };
}

function objectPath(assetsDir, hash) {
  return path.join(assetsDir, 'objects', hash.slice(0, 2), hash);
}

async function ensureAssetIndex(version, paths, options) {
  const { signal, onLog } = options;
  const indexInfo = version.assetIndex;
  if (!indexInfo?.id) {
    onLog('warn', 'У этой версии нет индекса ресурсов — пропускаю загрузку ассетов.');
    return null;
  }
  if (!indexInfo.url) {
    const fallback = path.join(paths.assetsDir, 'indexes', `${indexInfo.id}.json`);
    if (await exists(fallback)) return { index: JSON.parse(await fsp.readFile(fallback, 'utf8')), id: String(indexInfo.id) };
    throw new Error(`Нет данных для загрузки ресурсов версии ${version.id}.`);
  }

  const indexId = String(indexInfo.id);
  const dest = path.join(paths.assetsDir, 'indexes', `${indexId}.json`);
  const download = async () => {
    await downloadFile({
      url: indexInfo.url,
      dest,
      sha1: indexInfo.sha1 || null,
      size: indexInfo.size || null,
      signal,
      onRetry: (error, attempt) =>
        onLog('warn', `Повтор загрузки индекса ресурсов (${attempt}): ${error.message}`),
    });
  };

  await download();
  try {
    const index = JSON.parse(await fsp.readFile(dest, 'utf8'));
    return { index, id: indexId };
  } catch (error) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    await download();
    try {
      return { index: JSON.parse(await fsp.readFile(dest, 'utf8')), id: indexId };
    } catch {
      throw new Error('Индекс ресурсов повреждён. Попробуйте запустить загрузку ещё раз.');
    }
  }
}

async function prepareAssets(version, paths, options) {
  const { signal, onProgress, onLog } = options;
  const indexResult = await ensureAssetIndex(version, paths, { signal, onLog });
  if (!indexResult) {
    return {
      assetsRoot: paths.assetsDir,
      assetsIndexName: version.assets || 'legacy',
      virtual: false,
    };
  }

  const { index, id: indexId } = indexResult;
  const objects = Object.entries(index.objects || {});
  const tasks = objects.map(([, object]) => {
    const hash = object.hash;
    return {
      url: `${ASSET_CDN}/${hash.slice(0, 2)}/${hash}`,
      dest: objectPath(paths.assetsDir, hash),
      sha1: hash,
      size: Number(object.size) || null,
      kind: 'asset',
    };
  });

  await downloadMany(tasks, {
    label: `Ресурсы Minecraft (${objects.length})`,
    phase: 'assets',
    concurrency: 20,
    signal,
    onProgress,
    onLog,
  });

  // pre-1.6 индексы помечены map_to_resources, а legacy/1.6-1.7 — virtual.
  // Оба варианта требуют каталог assets/virtual/<index>, иначе старые
  // версии запускаются без текстур, звуков и языковых файлов.
  const needsVirtual =
    version.assets === 'legacy' ||
    index.virtual === true ||
    index.map_to_resources === true ||
    objects.some(([, object]) => object.map_to_resources === true);

  let assetsRoot = paths.assetsDir;
  if (needsVirtual) {
    const virtualDir = path.join(paths.assetsDir, 'virtual', indexId);
    await ensureDir(virtualDir);
    let processed = 0;
    let created = 0;
    for (const [name, object] of objects) {
      if (signal?.aborted) throw Object.assign(new Error('Операция отменена'), { name: 'AbortError' });
      const source = objectPath(paths.assetsDir, object.hash);
      const normalized = path.normalize(name).replace(/^(\.\.(\\|\/|$))+/, '');
      const destination = path.join(virtualDir, normalized);
      if (!destination.startsWith(virtualDir + path.sep)) continue;
      const currentSize = await fileSize(destination);
      if (currentSize !== Number(object.size)) {
        await ensureDir(path.dirname(destination));
        await fsp.rm(destination, { force: true }).catch(() => {});
        try {
          await fsp.link(source, destination);
        } catch {
          await fsp.copyFile(source, destination);
        }
        created += 1;
      }
      processed += 1;
      if (processed % 150 === 0) {
        onProgress?.({
          phase: 'virtual',
          label: 'Подготовка ресурсов старой версии',
          percent: (processed / objects.length) * 100,
          detail: `${processed} из ${objects.length}`,
        });
      }
    }
    if (created) onLog('info', `Подготовлено ресурсов для старой версии: ${created}.`);
    assetsRoot = virtualDir;
  }

  return {
    assetsRoot,
    assetsIndexName: indexId,
    virtual: needsVirtual,
  };
}

function isExcludedFromExtraction(name, extract) {
  if (!extract?.exclude) return false;
  return extract.exclude.some((pattern) => name.startsWith(pattern));
}

async function extractNatives(nativeJars, nativesDir, options = {}) {
  const { signal, onProgress, onLog } = options;
  if (!nativeJars.length) {
    await ensureDir(nativesDir);
    return 0;
  }

  await fsp.rm(nativesDir, { recursive: true, force: true }).catch(() => {});
  await ensureDir(nativesDir);
  let extracted = 0;

  for (let index = 0; index < nativeJars.length; index += 1) {
    if (signal?.aborted) throw Object.assign(new Error('Операция отменена'), { name: 'AbortError' });
    const { jarPath, extract } = nativeJars[index];
    if (!(await exists(jarPath))) throw new Error(`Не найден файл нативов: ${path.basename(jarPath)}`);
    let zip;
    try {
      zip = new AdmZip(jarPath);
    } catch (error) {
      throw new Error(`Повреждён архив нативов ${path.basename(jarPath)}.`);
    }
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const entryName = entry.entryName.replace(/\\/g, '/');
      if (entryName.startsWith('META-INF/') || entryName === 'META-INF') continue;
      if (entryName.includes('..') || path.posix.isAbsolute(entryName)) continue;
      if (isExcludedFromExtraction(entryName, extract)) continue;
      const destination = path.join(nativesDir, ...entryName.split('/'));
      if (!destination.startsWith(nativesDir + path.sep)) continue;
      await ensureDir(path.dirname(destination));
      try {
        await fsp.writeFile(destination, entry.getData());
        extracted += 1;
      } catch (error) {
        throw new Error(`Не удалось распаковать натив ${entryName}: ${error.message}`);
      }
      if (/\.(dll|so|dylib)$/i.test(entryName) && entryName.includes('/')) {
        const flat = path.join(nativesDir, path.basename(entryName));
        if (flat !== destination) await fsp.copyFile(destination, flat).catch(() => {});
      }
    }
    onProgress?.({
      phase: 'natives',
      label: 'Распаковка нативов',
      percent: ((index + 1) / nativeJars.length) * 100,
      detail: `${index + 1} из ${nativeJars.length}`,
    });
  }

  onLog('info', `Распаковано нативов: ${extracted} файл(ов).`);
  return extracted;
}

function splitLegacyArguments(value) {
  const matches = String(value).match(/"[^"]*"|\S+/g) || [];
  return matches.map((part) => (part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part));
}

function substitute(value, context, missing) {
  return String(value).replace(/\$\{([^}]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) return String(context[key] ?? '');
    missing.add(key);
    return '';
  });
}

function buildClasspath(classpathLibs, clientJar) {
  const parts = [];
  const seen = new Set();
  // Нативные jar не должны попадать в classpath: их содержимое
  // подключается через -Djava.library.path.
  for (const entry of [...classpathLibs, clientJar]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    parts.push(entry);
  }
  return parts.join(path.delimiter);
}

async function writeVersionJsonIfNeeded(version, paths, chain, onLog) {
  if (chain.length > 1) return;
  const dir = path.join(paths.gameDir, 'versions', version.id);
  const jsonPath = path.join(dir, `${version.id}.json`);
  if (await exists(jsonPath)) return;
  await ensureDir(dir);
  await writeJson(jsonPath, version);
  onLog?.('info', `Сохранено описание версии ${version.id}.`);
}

async function prepareLogging(version, paths, signal, onLog) {
  const client = version.logging?.client;
  const file = client?.file;
  if (!file?.url || !file?.id) return null;
  const dest = path.join(paths.assetsDir, 'log_configs', file.id);
  try {
    await downloadFile({
      url: file.url,
      dest,
      sha1: file.sha1 || null,
      size: file.size || null,
      signal,
      onRetry: (error, attempt) =>
        onLog('warn', `Повтор загрузки конфигурации логов (${attempt}): ${error.message}`),
    });
    return dest;
  } catch (error) {
    if (signal?.aborted) throw error;
    onLog('warn', `Не удалось скачать конфигурацию логов: ${error.message}`);
    return null;
  }
}

async function findClientJar(version, chain, paths, tasks, signal, onLog) {
  const ids = [];
  if (typeof version.jar === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version.jar)) {
    ids.push(version.jar);
  }
  for (const entry of [...chain].reverse()) ids.push(entry.id);

  for (const id of [...new Set(ids)]) {
    const candidate = path.join(paths.gameDir, 'versions', id, `${id}.jar`);
    if (await exists(candidate)) return candidate;
  }

  const download = version.downloads?.client;
  if (!download?.url) {
    throw new Error('Не удалось найти файл клиента Minecraft для этой версии.');
  }
  const dest = path.join(paths.gameDir, 'versions', version.id, `${version.id}.jar`);
  tasks.push({
    url: download.url,
    dest,
    sha1: download.sha1 || null,
    size: download.size || null,
    kind: 'client',
  });
  return dest;
}

function buildLaunchDetails(options) {
  const {
    version,
    config,
    username,
    uuid,
    assetsRoot,
    assetsIndexName,
    nativesDir,
    classpath,
    loggingPath,
    server,
  } = options;

  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(config.resolution),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  const width = Number(config.width) > 0 ? Number(config.width) : 854;
  const height = Number(config.height) > 0 ? Number(config.height) : 480;
  const context = {
    auth_player_name: username,
    auth_uuid: uuid.replace(/-/g, ''),
    auth_access_token: '0',
    auth_session: `token:0:${uuid.replace(/-/g, '')}`,
    auth_xuid: '0',
    clientid: '0',
    user_type: 'legacy',
    user_properties: '{}',
    profile_properties: '{}',
    version_name: version.id,
    version_type: version.type || 'release',
    game_directory: config.gameDir,
    game_assets: assetsRoot,
    assets_root: assetsRoot,
    assets_index_name: assetsIndexName,
    natives_directory: nativesDir,
    library_directory: options.librariesDir,
    classpath,
    classpath_separator: path.delimiter,
    launcher_name: APP_NAME,
    launcher_version: APP_VERSION,
    resolution_width: width,
    resolution_height: height,
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: '',
  };

  const missing = new Set();
  const jvmArgs = version.arguments?.jvm
    ? collectArguments(version.arguments.jvm, features, (message) => options.onLog?.('warn', message))
    : [];

  const jvm = [];
  if (!jvmArgs.some((arg) => arg.startsWith('-Xmx'))) jvm.push(`-Xmx${config.ramMB}M`);
  if (!jvmArgs.some((arg) => arg.startsWith('-Xms'))) jvm.push(`-Xms${Math.min(512, config.ramMB)}M`);
  jvm.push('-Dfile.encoding=UTF-8');
  jvm.push('-Dstdout.encoding=UTF-8');
  jvm.push('-Dstderr.encoding=UTF-8');
  jvm.push('-Dlog4j2.formatMsgNoLookups=true');

  for (let arg of jvmArgs) {
    if (arg.startsWith('-Djava.library.path=')) {
      arg = `-Djava.library.path=${nativesDir}`;
    }
    jvm.push(arg);
  }

  if (!jvm.some((arg) => arg.startsWith('-Djava.library.path='))) {
    jvm.push(`-Djava.library.path=${nativesDir}`);
  }
  if (!jvm.some((arg) => arg.startsWith('-Dminecraft.launcher.brand'))) {
    jvm.push(`-Dminecraft.launcher.brand=${APP_NAME}`);
  }
  if (!jvm.some((arg) => arg.startsWith('-Dminecraft.launcher.version'))) {
    jvm.push(`-Dminecraft.launcher.version=${APP_VERSION}`);
  }
  if (loggingPath) {
    const loggingArgument = version.logging?.client?.argument || '-Dlog4j.configurationFile=${path}';
    jvm.push(loggingArgument.replace('${path}', loggingPath));
  }
  if (!jvm.some((arg) => arg === '-cp' || arg === '-classpath')) {
    jvm.push('-cp', classpath);
  }

  if (config.jvmArgs) {
    const extra = splitLegacyArguments(config.jvmArgs);
    if (extra.length) jvm.push(...extra);
  }

  const gameArgsRaw = version.minecraftArguments
    ? splitLegacyArguments(version.minecraftArguments)
    : collectArguments(version.arguments?.game || [], features, (message) =>
        options.onLog?.('warn', message),
      );

  if (!gameArgsRaw.length) throw new Error('Не найдены аргументы запуска игры для этой версии.');

  const game = gameArgsRaw.map((arg) => substitute(arg, context, missing));
  if (config.fullscreen && !game.includes('--fullscreen')) game.push('--fullscreen');
  if (
    config.resolution &&
    !game.includes('--width') &&
    !game.includes('--height')
  ) {
    game.push('--width', String(width), '--height', String(height));
  }

  if (server?.host) {
    game.push('--server', server.host, '--port', String(server.port || 25565));
  }

  if (missing.size) {
    options.onLog?.(
      'warn',
      `Неизвестные параметры запуска заменены пустыми: ${[...missing].join(', ')}`,
    );
  }

  const finalJvm = jvm
    .map((arg) => substitute(arg, context, missing))
    .filter((arg) => arg !== '');
  const mainClass = version.mainClass || 'net.minecraft.client.main.Main';

  return {
    args: [...finalJvm, mainClass, ...game],
    mainClass,
    features,
    context,
  };
}

async function startGame(versionId, options) {
  const {
    paths,
    config,
    username,
    server,
    signal,
    onProgress = () => {},
    onLog = () => {},
    onExit = () => {},
  } = options;

  const uuid = offlineUuid(username);
  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(config.resolution),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };

  onProgress({ phase: 'meta', label: 'Чтение данных версии', percent: null, detail: versionId });
  const resolved = await resolveVersion(versionId, paths, { signal });
  const { version, chain } = resolved;
  const javaMajor = requiredJavaMajor(version);

  onLog(
    'info',
    `Версия ${version.id} · ${version.type || 'release'} · нужна Java ${javaMajor}.`,
  );

  if (version.inheritsFrom) {
    onLog('info', `Загружена цепочка наследования: ${chain.map((item) => item.id).join(' → ')}`);
  }

  onProgress({
    phase: 'java-check',
    label: `Проверка Java ${javaMajor}`,
    percent: null,
    detail: 'Поиск установленной Java…',
  });
  const java = await ensureJava(javaMajor, {
    customPath: config.javaPath,
    javaDir: paths.javaDir,
    extraDirs: minecraftRuntimeDirs(config.gameDir),
    signal,
    log: (level, message) => onLog(level, message),
    onProgress,
  });

  await ensureDir(config.gameDir);
  await writeVersionJsonIfNeeded(version, paths, chain, onLog);

  const libraryInfo = collectLibraries(version, features, paths);
  const tasks = [...libraryInfo.tasks];

  const clientJar = await findClientJar(version, chain, paths, tasks, signal, onLog);
  if (!libraryInfo.tasks.length) {
    onLog('info', 'Дополнительные библиотеки не требуются.');
  }

  const loggingPath = await prepareLogging(version, paths, signal, onLog);

  if (tasks.length) {
    await downloadMany(tasks, {
      label: 'Клиент и библиотеки',
      phase: 'files',
      concurrency: 12,
      signal,
      onProgress,
      onLog,
    });
  }

  const assetsInfo = await prepareAssets(version, paths, { signal, onProgress, onLog });

  for (const entry of libraryInfo.classpath) {
    if (!(await exists(entry))) {
      throw new Error(`Не найден библиотечный файл: ${path.relative(paths.gameDir, entry)}`);
    }
  }
  if (!(await exists(clientJar))) throw new Error('Не найден клиент Minecraft.');

  // Скин применяется после проверки клиента: формат ресурспака берётся
  // из version.json внутри самого JAR, а не угадывается по номеру версии.
  try {
    const skin = await applySkin(paths, config, version.id, clientJar, (level, message) =>
      onLog(level, message),
    );
    if (!skin.applied && skin.reason === 'empty') {
      onLog('info', 'Скин не задан — используется стандартный.');
    }
  } catch (error) {
    onLog('warn', `Не удалось применить скин: ${error.message}`);
  }

  const nativesDir = path.join(paths.gameDir, 'versions', version.id, 'natives');
  onProgress({
    phase: 'natives',
    label: 'Распаковка нативов',
    percent: 0,
    detail: 'Подготовка библиотек…',
  });
  await extractNatives(libraryInfo.nativeJars, nativesDir, { signal, onProgress, onLog });

  const classpath = buildClasspath(libraryInfo.classpath, clientJar);

  const launchDetails = buildLaunchDetails({
    version,
    config,
    username,
    uuid,
    assetsRoot: assetsInfo.assetsRoot,
    assetsIndexName: assetsInfo.assetsIndexName,
    nativesDir,
    classpath,
    loggingPath,
    librariesDir: paths.librariesDir,
    server,
    onLog,
  });

  onProgress({
    phase: 'launch',
    label: 'Запуск Minecraft',
    percent: 100,
    detail: `${version.id} · ${formatBytes(config.ramMB * 1024 * 1024)} ОЗУ`,
  });
  onLog(
    'info',
    `Запуск ${version.id} на Java ${java.major || javaMajor}, ОЗУ ${config.ramMB} МБ, игрок ${username}.`,
  );
  if (server?.host) {
    onLog('info', `Подключение к серверу ${server.host}:${server.port || 25565}.`);
  }

  const child = spawn(java.path, launchDetails.args, {
    cwd: config.gameDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let closed = false;
  let spawned = false;
  const stdoutSplitter = new LineSplitter((line) => onLog(classifyLogLine(line), line));
  const stderrSplitter = new LineSplitter((line) => onLog(classifyLogLine(line), line));

  child.stdout?.on('data', (chunk) => stdoutSplitter.push(chunk));
  child.stderr?.on('data', (chunk) => stderrSplitter.push(chunk));

  child.on('error', (error) => {
    if (spawned) onLog('error', `Ошибка процесса Minecraft: ${error.message}`);
  });

  child.on('close', (code, signalName) => {
    if (closed || !spawned) return;
    closed = true;
    stdoutSplitter.flush();
    stderrSplitter.flush();
    onExit(code, signalName, child);
  });

  await new Promise((resolve, reject) => {
    child.once('spawn', () => {
      spawned = true;
      options.onSpawn?.(child);
      resolve();
    });
    child.once('error', (error) => {
      if (!spawned) {
        const friendly = new Error(`Не удалось запустить Java: ${error.message}`);
        friendly.cause = error;
        reject(friendly);
      }
    });
  });

  onProgress({
    phase: 'running',
    label: 'Игра запущена',
    percent: 100,
    detail: version.id,
  });

  return {
    child,
    version,
    java,
    args: launchDetails.args,
    clientJar,
    assetsRoot: assetsInfo.assetsRoot,
    nativesDir,
  };
}

function classifyLogLine(line) {
  if (/\[(ERROR|FATAL)\]|^Exception|^\s+at |Caused by:|Failed to|ERROR:/i.test(line)) return 'error';
  if (/\[WARN\]|WARNING|Deprecated/i.test(line)) return 'warn';
  return 'game';
}

async function getVersionRuntimeInfo(versionId, options) {
  const { paths, config, signal } = options;
  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(config.resolution),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };
  const resolved = await resolveVersion(versionId, paths, { signal });
  const { version, chain } = resolved;
  const engineMajor = requiredJavaMajor(version);
  const sizes = estimateInstallSize(version, features);
  let javaInfo;
  try {
    javaInfo = await findJava(engineMajor, {
      customPath: config.javaPath,
      javaDir: paths.javaDir,
      extraDirs: minecraftRuntimeDirs(config.gameDir),
      signal,
      force: false,
    });
  } catch {
    javaInfo = { found: false, requiredMajor: engineMajor };
  }
  const local = chain.some((entry) => entry.local);
  return {
    id: versionId,
    type: version.type || 'release',
    releaseTime: version.releaseTime || null,
    javaMajor: engineMajor,
    java: javaInfo.found
      ? {
          found: true,
          major: javaInfo.major,
          version: javaInfo.version,
          path: javaInfo.path,
          exact: javaInfo.exact,
        }
      : { found: false, requiredMajor: engineMajor },
    sizes,
    inheritsFrom: version.inheritsFrom || null,
    chain: chain.map((entry) => entry.id),
    local,
  };
}

module.exports = {
  requiredJavaMajor,
  collectLibraries,
  estimateInstallSize,
  getVersionRuntimeInfo,
  startGame,
  buildLaunchDetails,
};
