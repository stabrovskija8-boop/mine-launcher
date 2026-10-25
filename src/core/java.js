'use strict';

const { spawn, execFile } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const {
  exists,
  fileSize,
  fetchJson,
  fetchWithTimeout,
  downloadFile,
  ensureDir,
  formatBytes,
} = require('./util');

const JAVA_BIN = process.platform === 'win32' ? 'java.exe' : 'java';
const JAVAW_BIN = process.platform === 'win32' ? 'javaw.exe' : 'java';
const RUNTIME_PREFIX = /^(?:java|jre|jdk)/i;
const detectionCache = new Map();
const scanCache = { key: null, at: 0, result: null };

function expandPath(input) {
  let value = String(input ?? '').trim();
  if (!value) return '';
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (process.platform === 'win32') {
    value = value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
  }
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(1));
  }
  return value;
}

function normalizeJavaPath(input) {
  const value = expandPath(input);
  if (!value) return null;
  if (path.basename(value).toLowerCase() === JAVAW_BIN.toLowerCase()) {
    return path.join(path.dirname(value), JAVA_BIN);
  }
  return value;
}

async function statSafe(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

/**
 * Принимает java.exe, javaw.exe, папку bin или корень JRE/JDK.
 * Возвращает путь к java.exe.
 */
async function resolveJavaPath(input) {
  const normalized = normalizeJavaPath(input);
  if (!normalized) return null;

  const stat = await statSafe(normalized);
  if (stat?.isDirectory()) {
    const candidates = [
      path.join(normalized, 'bin', JAVA_BIN),
      path.join(normalized, 'bin', JAVAW_BIN),
      path.join(normalized, JAVA_BIN),
      path.join(normalized, JAVAW_BIN),
    ];
    for (const candidate of candidates) {
      if (await exists(candidate)) return normalizeJavaPath(candidate);
    }
    return null;
  }

  if (!stat && process.platform === 'win32' && !path.extname(normalized)) {
    const withExe = `${normalized}.exe`;
    if (await exists(withExe)) return normalizeJavaPath(withExe);
  }

  return normalized;
}

async function detectJava(inputPath, options = {}) {
  const { timeout = 9000, useCache = true } = options;
  const exe = await resolveJavaPath(inputPath);
  if (!exe || !(await exists(exe))) return null;

  const cached = detectionCache.get(exe.toLowerCase());
  if (useCache && cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.info;

  const info = await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let child;
    try {
      child = spawn(exe, ['-XshowSettings:properties', '-version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve(null);
      }
    }, timeout);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = `${stdout}\n${stderr}`;
      const versionLine = /java\.version\s*=\s*([^\s]+)/.exec(text)?.[1] || null;
      let specLine = /java\.specification\.version\s*=\s*([^\s]+)/.exec(text)?.[1] || null;
      if (!specLine && versionLine) specLine = versionLine.startsWith('1.') ? versionLine.slice(0, 3) : versionLine;
      if (!specLine) {
        resolve(null);
        return;
      }
      let major;
      if (specLine.startsWith('1.')) major = parseInt(specLine.split('.')[1], 10);
      else major = parseInt(specLine, 10);
      if (!Number.isFinite(major)) {
        resolve(null);
        return;
      }
      resolve({
        path: exe,
        major,
        version: versionLine || specLine,
        arch: /os\.arch\s*=\s*([^\s]+)/.exec(text)?.[1] || null,
        vendor: /java\.vendor\s*=\s*(.+)/.exec(text)?.[1]?.trim() || null,
      });
    });
  });

  if (info) detectionCache.set(exe.toLowerCase(), { at: Date.now(), info });
  return info;
}

async function findJavaInDir(dir, depth = 3) {
  if (depth < 0) return null;
  const direct = path.join(dir, 'bin', JAVA_BIN);
  if (await exists(direct)) return direct;
  if (depth === 0) return null;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const found = await findJavaInDir(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

async function whereJava() {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise((resolve) => {
    execFile(command, ['java'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    });
  });
}

/**
 * Папки, куда официальный лаунчер Minecraft (и его Store-версия)
 * складывает свои Java-рантаймы. Это позволяет переиспользовать
 * уже скачанные Java 8/17/21 без повторной загрузки.
 */
function minecraftRuntimeDirs(gameDir = '') {
  const dirs = [];
  if (gameDir) dirs.push(path.join(gameDir, 'runtime'));

  const appData = process.env.APPDATA;
  if (appData) dirs.push(path.join(appData, '.minecraft', 'runtime'));

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    dirs.push(
      path.join(
        localAppData,
        'Packages',
        'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
        'LocalCache',
        'Local',
        'runtime',
      ),
    );
    dirs.push(path.join(localAppData, 'Minecraft Launcher', 'runtime'));
  }

  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) dirs.push(path.join(base, 'Minecraft Launcher', 'runtime'));
  }

  if (process.platform !== 'win32') {
    dirs.push(path.join(os.homedir(), '.minecraft', 'runtime'));
  }

  return [...new Set(dirs.map((dir) => path.normalize(dir)))];
}

async function collectJavaCandidates(options = {}) {
  const { customPath = '', javaDir = '', extraDirs = [], force = false } = options;
  const roots = [
    ...new Set(
      [javaDir, ...(Array.isArray(extraDirs) ? extraDirs : [extraDirs]), ...minecraftRuntimeDirs()]
        .filter(Boolean)
        .map((dir) => path.normalize(dir)),
    ),
  ];
  const key = `${customPath}|${roots.join('|')}`;
  if (!force && scanCache.key === key && Date.now() - scanCache.at < 45 * 1000) {
    return scanCache.result;
  }

  const candidates = new Set();
  const add = async (value) => {
    const normalized = await resolveJavaPath(value);
    if (normalized && (await exists(normalized))) candidates.add(path.resolve(normalized));
  };

  if (customPath) await add(customPath);

  for (const root of roots) {
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !RUNTIME_PREFIX.test(entry.name)) continue;
        const found = await findJavaInDir(path.join(root, entry.name), 3);
        if (found) await add(found);
      }
    } catch {
      /* ignore */
    }
  }

  if (javaDir) await add(path.join(javaDir, 'bin', JAVA_BIN));

  if (process.env.JAVA_HOME) {
    await add(path.join(process.env.JAVA_HOME, 'bin', JAVA_BIN));
  }

  for (const found of await whereJava()) await add(found);

  const bases = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
    path.join(os.homedir(), '.jdks'),
    '/usr/lib/jvm',
    '/Library/Java/JavaVirtualMachines',
  ].filter(Boolean);
  const vendors = [
    'Java',
    'Eclipse Adoptium',
    'Eclipse Foundation',
    'Microsoft',
    'Zulu',
    'Amazon Corretto',
    'BellSoft',
    'Semeru',
    'Temurin',
    'GraalVM',
  ];

  for (const base of bases) {
    for (const vendor of vendors) {
      const vendorDir = path.join(base, vendor);
      if (!(await exists(vendorDir))) continue;
      await add(path.join(vendorDir, 'bin', JAVA_BIN));
      let entries = [];
      try {
        entries = await fsp.readdir(vendorDir, { withFileTypes: true });
      } catch {
        continue;
      }
      let count = 0;
      for (const entry of entries) {
        if (!entry.isDirectory() || count >= 24) continue;
        count += 1;
        await add(path.join(vendorDir, entry.name, 'bin', JAVA_BIN));
      }
    }
  }

  const list = [...candidates].slice(0, 40);
  scanCache.key = key;
  scanCache.at = Date.now();
  scanCache.result = list;
  return list;
}

async function listInstalledJava(options = {}) {
  const { signal } = options;
  const candidates = await collectJavaCandidates(options);
  const detected = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (signal?.aborted) break;
    const info = await detectJava(candidate);
    if (!info) continue;
    const key = info.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    detected.push(info);
  }
  detected.sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
  return detected;
}

async function findJava(requiredMajor, options = {}) {
  const { customPath, javaDir, extraDirs, signal, force = false } = options;
  const candidates = await collectJavaCandidates({ customPath, javaDir, extraDirs, force });
  const detected = [];
  for (const candidate of candidates) {
    if (signal?.aborted) return { found: false, aborted: true, requiredMajor };
    const info = await detectJava(candidate);
    if (info) detected.push(info);
  }

  const required = Number(requiredMajor) || 8;
  let best = null;
  for (const info of detected) {
    if (info.major === required) {
      return { found: true, ...info, requiredMajor: required, exact: true };
    }
    if (required > 8 && info.major >= required) {
      if (!best || info.major < best.major) best = info;
    }
  }

  if (best) return { found: true, ...best, requiredMajor: required, exact: false };
  return {
    found: false,
    requiredMajor: required,
    detected: detected.map(({ path: javaPath, major, version }) => ({ path: javaPath, major, version })),
  };
}

function adoptiumOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function adoptiumArch() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'arm64') return 'aarch64';
  return process.arch;
}

async function getAdoptiumPackage(major, signal) {
  const osName = adoptiumOs();
  const arch = adoptiumArch();
  const url =
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot` +
    `?os=${encodeURIComponent(osName)}&architecture=${encodeURIComponent(arch)}` +
    '&image_type=jre&vendor=eclipse';

  const assets = await fetchJson(url, { signal, attempts: 3, timeout: 30000 });
  const packageInfo = assets?.[0]?.binary?.package;
  if (!packageInfo?.link) {
    throw new Error(`Не удалось найти Java ${major} на сервере Adoptium.`);
  }
  return {
    major,
    link: packageInfo.link,
    size: Number(packageInfo.size) || null,
    semver: assets[0]?.version?.semver || String(major),
    releaseName: assets[0]?.release_name || `Temurin ${major}`,
    source: 'Adoptium Temurin',
  };
}

function azulOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function azulArch() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

async function remoteSize(url, signal) {
  try {
    const head = await fetchWithTimeout(
      url,
      { method: 'HEAD', redirect: 'follow', signal },
      15000,
    );
    if (head.ok) {
      const value = Number(head.headers.get('content-length'));
      if (Number.isFinite(value) && value > 0) return value;
    }
  } catch {
    /* часть CDN не отвечает на HEAD — пробуем Range */
  }

  try {
    const response = await fetchWithTimeout(
      url,
      { redirect: 'follow', signal, headers: { Range: 'bytes=0-0' } },
      15000,
    );
    const range = response.headers.get('content-range');
    await response.body?.cancel().catch(() => {});
    const match = /\/(\d+)\s*$/.exec(range || '');
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  } catch {
    /* точный размер узнаем из заголовков при скачивании */
  }
  return null;
}

async function getAzulPackage(major, signal) {
  const params = new URLSearchParams({
    java_version: String(major),
    os: azulOs(),
    arch: azulArch(),
    archive_type: 'zip',
    java_package_type: 'jre',
    latest: 'true',
    release_status: 'ga',
    availability_types: 'CA',
  });
  const url = `https://api.azul.com/metadata/v1/zulu/packages/?${params.toString()}`;
  const assets = await fetchJson(url, { signal, attempts: 2, timeout: 30000 });
  const list = Array.isArray(assets) ? assets : [];
  const packageInfo =
    list.find((item) => item?.download_url && !/-fx-/i.test(String(item.name || ''))) ||
    list.find((item) => item?.download_url);
  if (!packageInfo) {
    throw new Error(`Не удалось найти Java ${major} на сервере Azul.`);
  }
  const version = Array.isArray(packageInfo.java_version)
    ? packageInfo.java_version.join('.')
    : String(major);
  const size = await remoteSize(packageInfo.download_url, signal);
  return {
    major,
    link: packageInfo.download_url,
    size,
    semver: version,
    releaseName: packageInfo.name || `Zulu ${major}`,
    source: 'Azul Zulu',
  };
}

async function getJavaPackage(major, signal, log) {
  const providers = [
    { name: 'Azul Zulu', resolve: getAzulPackage },
    { name: 'Adoptium Temurin', resolve: getAdoptiumPackage },
  ];
  let lastError = null;
  for (const provider of providers) {
    try {
      const pkg = await provider.resolve(major, signal);
      log('info', `Источник Java: ${provider.name} ${pkg.semver}.`);
      return pkg;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      log('warn', `${provider.name} недоступен: ${error.message}`);
    }
  }
  throw lastError || new Error(`Не удалось найти Java ${major}.`);
}

function makeProgressReporter(onProgress, label) {
  let last = 0;
  return (payload) => {
    const now = Date.now();
    if (!payload.force && now - last < 120) return;
    last = now;
    onProgress?.({ phase: 'java', label, ...payload });
  };
}

/**
 * Скачивание большого архива через системный curl.
 * Node-fetch на этом CDN периодически «зависает» без данных, а curl умеет
 * докачку, повторные попытки и обрыв по скорости.
 */
async function curlDownload(url, dest, options = {}) {
  const { size = null, signal, onBytes } = options;
  const part = `${dest}.part`;
  await ensureDir(path.dirname(dest));

  if (await exists(part)) {
    const current = await fileSize(part);
    if (size != null && current >= size) {
      await fsp.rm(dest, { force: true }).catch(() => {});
      await fsp.rename(part, dest);
      onBytes?.(current);
      return { size: current, resumed: true };
    }
  }

  const args = [
    '-L',
    '--fail',
    '--retry',
    '4',
    '--retry-all-errors',
    '--retry-delay',
    '2',
    '--connect-timeout',
    '20',
    '--speed-time',
    '30',
    '--speed-limit',
    '1024',
    '-C',
    '-',
    '-o',
    part,
    url,
  ];

  let reported = 0;
  await new Promise((resolve, reject) => {
    const child = spawn('curl.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let finished = false;
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
    const poll = setInterval(async () => {
      try {
        const current = await fileSize(part);
        if (current > reported) {
          onBytes?.(current - reported);
          reported = current;
        }
      } catch {
        /* файл ещё не создан */
      }
    }, 400);
    const stop = () => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      stop();
      child.kill();
      reject(new Error('Операция отменена'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      stop();
      reject(error);
    });
    child.on('close', (code) => {
      stop();
      if (code === 0) resolve();
      else reject(new Error(`curl завершился с кодом ${code}${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`));
    });
  });

  const finalSize = await fileSize(part);
  if (size != null && finalSize !== size) {
    throw new Error(`Файл скачан не полностью: ${finalSize} из ${size} байт`);
  }
  await fsp.rm(dest, { force: true }).catch(() => {});
  await fsp.rename(part, dest);
  return { size: finalSize, resumed: false };
}

async function ensureJava(requiredMajor, options = {}) {
  const {
    customPath,
    javaDir,
    extraDirs,
    signal,
    log = () => {},
    onProgress = null,
  } = options;

  if (customPath) {
    const custom = await detectJava(customPath);
    if (!custom) {
      log('warn', `Указанная Java не найдена: ${customPath}. Будет выполнен автоматический поиск.`);
    }
  }

  const found = await findJava(requiredMajor, {
    customPath,
    javaDir,
    extraDirs,
    signal,
    force: false,
  });

  if (found.found) {
    if (!found.exact) {
      log(
        'warn',
        `Для версии рекомендуется Java ${found.requiredMajor}, используется Java ${found.major}.`,
      );
    }
    log('info', `Java ${found.major} найдена: ${found.path}`);
    return found;
  }

  if (signal?.aborted) throw new Error('Операция отменена');

  const required = found.requiredMajor;
  log('info', `Java ${required} не найдена. Скачиваю JRE ${required}…`);

  const downloadDir = path.join(javaDir, 'downloads');
  await ensureDir(downloadDir);
  const zipPath = path.join(downloadDir, `java-${required}.zip`);
  const targetDir = path.join(javaDir, `java-${required}`);

  let pkg;
  try {
    pkg = await getJavaPackage(required, signal, log);
  } catch (error) {
    if (required === 16) {
      log('warn', 'Java 16 недоступна, пробую Java 17.');
      pkg = await getJavaPackage(17, signal, log);
    } else {
      const friendly = new Error(
        `Не удалось получить Java ${required} автоматически. Установите Java ${required} вручную и укажите путь в настройках.`,
      );
      friendly.cause = error;
      throw friendly;
    }
  }

  const total = pkg.size || 0;
  let done = 0;
  let lastReport = 0;
  const report = makeProgressReporter(onProgress, `Загрузка Java ${pkg.major}`);
  onProgress?.({
    phase: 'java',
    label: `Загрузка Java ${pkg.major}`,
    percent: 0,
    detail: total ? formatBytes(total) : pkg.semver,
    force: true,
  });

  log(
    'info',
    `${pkg.source || 'Java'} ${pkg.semver} (${total ? formatBytes(total) : 'размер неизвестен'}).`,
  );
  const onBytes = (delta) => {
    done += delta;
    if (done < 0) done = 0;
    const now = Date.now();
    if (now - lastReport > 120) {
      lastReport = now;
      report({
        percent: total ? Math.min(100, (done / total) * 100) : null,
        detail: total ? `${formatBytes(done)} из ${formatBytes(total)}` : formatBytes(done),
      });
    }
  };

  if (process.platform === 'win32') {
    await curlDownload(pkg.link, zipPath, { size: total || null, signal, onBytes });
  } else {
    await downloadFile({
      url: pkg.link,
      dest: zipPath,
      size: total || null,
      signal,
      onBytes,
      onRetry: (error, attempt) => log('warn', `Повтор загрузки Java (${attempt}): ${error.message}`),
    });
  }
  report({
    percent: 100,
    detail: total ? formatBytes(total) : '',
    force: true,
  });

  onProgress?.({
    phase: 'java-extract',
    label: 'Распаковка Java',
    percent: null,
    detail: 'Это может занять минуту…',
    force: true,
  });
  log('info', 'Распаковка Java…');

  await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  await ensureDir(targetDir);
  try {
    const zip = new AdmZip(zipPath);
    await zip.extractAllToAsync(targetDir, true, false);
  } catch (error) {
    // Повреждённый архив удаляем, иначе при следующем запуске он снова
    // попадёт в распаковку.
    await fsp.rm(zipPath, { force: true }).catch(() => {});
    await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    const friendly = new Error('Скачанная Java повреждена. Запустите ещё раз — архив будет скачан заново.');
    friendly.cause = error;
    throw friendly;
  }

  const javaExe = await findJavaInDir(targetDir, 4);
  if (!javaExe) throw new Error('После распаковки Java не найден java.exe.');

  const info = await detectJava(javaExe, { useCache: false });
  if (!info) throw new Error('Скачанная Java не запускается.');

  await fsp.rm(zipPath, { force: true }).catch(() => {});
  log('info', `Java ${info.major} (${info.version}) установлена в ${targetDir}`);
  onProgress?.({
    phase: 'java-done',
    label: `Java ${info.major} готова`,
    percent: 100,
    detail: info.version,
    force: true,
  });
  return { ...info, requiredMajor: required, downloaded: true };
}

function clearJavaCaches() {
  detectionCache.clear();
  scanCache.key = null;
  scanCache.at = 0;
  scanCache.result = null;
}

module.exports = {
  JAVA_BIN,
  detectJava,
  findJava,
  ensureJava,
  listInstalledJava,
  clearJavaCaches,
  normalizeJavaPath,
  resolveJavaPath,
  minecraftRuntimeDirs,
};
