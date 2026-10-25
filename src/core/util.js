'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const USER_AGENT = 'MINE-Launcher/1.0.0 (offline; Electron)';

function abortError(message = 'Операция отменена') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile() ? stat.size : -1;
  } catch {
    return -1;
  }
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const { signal, headers, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Превышено время ожидания')), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw abortError();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        ...(headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function fetchJson(url, options = {}) {
  const { signal, attempts = 3, timeout = 30000 } = options;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      const response = await fetchWithTimeout(
        url,
        { signal, headers: { Accept: 'application/json' } },
        timeout,
      );
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} — ${url}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw abortError();
      lastError = error;
      if (error.status && error.status >= 400 && error.status < 500) break;
      if (attempt < attempts) {
        try {
          await sleep(500 * attempt, signal);
        } catch {
          throw abortError();
        }
      }
    }
  }
  throw lastError || new Error(`Не удалось загрузить ${url}`);
}

/**
 * Скачивает файл с проверкой размера/SHA-1 и повторами.
 * Уже существующий файл правильного размера пропускается.
 */
async function downloadFile(options) {
  const {
    url,
    dest,
    sha1 = null,
    size = null,
    signal,
    onBytes,
    onRetry,
    attempts = 3,
    timeout = 60000,
  } = options;

  await ensureDir(path.dirname(dest));
  const currentSize = await fileSize(dest);
  if (currentSize >= 0) {
    if (size != null) {
      if (currentSize === size) return { skipped: true, size: currentSize };
    } else if (sha1) {
      if ((await sha1File(dest)) === sha1) return { skipped: true, size: currentSize };
    }
    // Если проверить файл нечем (нет ни размера, ни SHA-1), он мог скачаться
    // не полностью — такой файл перекачиваем.
  }

  const part = `${dest}.part`;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw abortError();
    let received = 0;
    let offset = 0;
    const controller = new AbortController();
    const combined = anySignal([signal, controller.signal]);
    let idleTimer = null;

    try {
      // Докачка: если остался .part (например, с прошлого запуска),
      // продолжаем с его конца, а не качаем всё заново.
      const partSize = await fileSize(part);
      if (partSize > 0 && (size == null || partSize < size)) offset = partSize;

      const response = await fetchWithTimeout(
        url,
        {
          signal: combined,
          redirect: 'follow',
          ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
        },
        timeout,
      );
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} — ${path.basename(dest)}`);
        error.status = response.status;
        throw error;
      }

      let append = false;
      if (offset > 0) {
        if (response.status === 206) {
          append = true;
        } else {
          // Сервер не поддерживает докачку — начинаем файл заново.
          offset = 0;
          await fsp.rm(part, { force: true }).catch(() => {});
        }
      }
      if (!response.body) throw new Error('Пустой ответ сервера');

      // Сервер может закрыть соединение раньше времени — тогда файл придёт
      // обрезанным. Контролируем длину по заголовку ответа.
      const declared = Number(response.headers.get('content-length'));
      const rangeTotal = /\/(\d+)\s*$/.exec(response.headers.get('content-range') || '');
      const expected =
        size != null
          ? size
          : rangeTotal
            ? Number(rangeTotal[1])
            : Number.isFinite(declared) && declared > 0
              ? declared + offset
              : null;

      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          controller.abort(new Error('Соединение зависло'));
        }, 90000);
      };
      resetIdle();

      const hash = sha1 ? crypto.createHash('sha1') : null;
      if (hash && append) {
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(part);
          stream.on('data', (chunk) => hash.update(chunk));
          stream.on('end', resolve);
          stream.on('error', reject);
        });
      }

      const body = Readable.fromWeb(response.body);
      body.on('data', (chunk) => {
        received += chunk.length;
        hash?.update(chunk);
        resetIdle();
        onBytes?.(chunk.length);
      });

      await pipeline(
        body,
        append ? fs.createWriteStream(part, { flags: 'a' }) : fs.createWriteStream(part),
      );

      const written = offset + received;
      if (expected != null && written !== expected) {
        throw new Error(`Файл скачан не полностью: ${written} из ${expected} байт`);
      }
      if (sha1) {
        const digest = hash.digest('hex');
        if (digest !== sha1) {
          await fsp.rm(part, { force: true }).catch(() => {});
          throw new Error('Файл повреждён (не совпал SHA-1)');
        }
      }
      await fsp.rm(dest, { force: true }).catch(() => {});
      await fsp.rename(part, dest);
      return { skipped: false, size: written };
    } catch (error) {
      if (received) onBytes?.(-received);
      if (signal?.aborted) throw abortError();
      if (isAbortError(error) && !controller.signal.aborted) throw abortError();
      lastError = error;
      if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
        await fsp.rm(part, { force: true }).catch(() => {});
        throw error;
      }
      if (attempt < attempts) {
        onRetry?.(error, attempt);
        try {
          await sleep(600 * attempt, signal);
        } catch {
          throw abortError();
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }
  throw lastError || new Error(`Не удалось скачать ${url}`);
}

async function mapLimit(items, limit, worker, signal) {
  if (!items.length) return [];
  const controller = new AbortController();
  const combined = anySignal([signal, controller.signal]);
  let cursor = 0;
  let firstError = null;

  const runner = async () => {
    while (!combined.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index], index, combined);
      } catch (error) {
        if (!firstError) firstError = error;
        controller.abort();
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  if (firstError) {
    if (signal?.aborted) throw abortError();
    throw firstError;
  }
  if (signal?.aborted) throw abortError();
  return [];
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  const digits = index === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace('.', ',')} ${units[index]}`;
}

function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest('hex');
  const chars = md5.split('');
  chars[12] = '3';
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sanitizeUsername(name) {
  const trimmed = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{2,16}$/.test(trimmed)) return null;
  return trimmed;
}

function timestamp(date = new Date()) {
  return date.toLocaleTimeString('ru-RU', { hour12: false });
}

class LineSplitter {
  constructor(onLine, maxLength = 6000) {
    this.onLine = onLine;
    this.maxLength = maxLength;
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > this.maxLength) line = `${line.slice(0, this.maxLength)}…`;
      if (line.length) this.onLine(line);
    }
    if (this.buffer.length > this.maxLength) {
      this.onLine(this.buffer.slice(0, this.maxLength));
      this.buffer = '';
    }
  }

  flush() {
    if (this.buffer.trim().length) this.onLine(this.buffer);
    this.buffer = '';
  }
}

module.exports = {
  USER_AGENT,
  abortError,
  isAbortError,
  sleep,
  ensureDir,
  exists,
  fileSize,
  sha1File,
  readJson,
  writeJson,
  fetchJson,
  fetchWithTimeout,
  downloadFile,
  mapLimit,
  formatBytes,
  offlineUuid,
  sanitizeUsername,
  timestamp,
  LineSplitter,
};
