'use strict';

const { fetchJson } = require('./util');

const API = 'https://api.mcsrvstat.us/3';
const CACHE_TTL = 60 * 1000;

// Публичные серверы без лицензии: пускают по нику, регистрация командой /register.
// Онлайн и версии подтягиваются с mcsrvstat, статические значения — запасные.
const SERVERS = [
  {
    id: 'extremecraft',
    name: 'ExtremeCraft',
    host: 'join.extremecraft.net',
    port: 25565,
    versions: '1.7.2–26.3',
    tags: ['Выживание', 'Экономика', 'Мини-игры'],
    note: 'Крупный сервер с выживанием, экономикой и ивентами.',
  },
  {
    id: 'battlepie',
    name: 'BattlePie',
    host: 'play.battlepie.net',
    port: 25565,
    versions: '1.8–26.3',
    tags: ['Мини-игры', 'PvP', 'BedWars'],
    note: 'Мини-игры на любой вкус: BedWars, SkyWars, Duels.',
  },
  {
    id: 'politcore',
    name: 'PolitCore',
    host: 'mc.politcore.net',
    port: 25565,
    versions: '1.16.5–26.3',
    tags: ['Выживание', 'Политика', 'Кланы'],
    note: 'Политическое выживание: города, кланы, войны.',
  },
  {
    id: 'ashsmp',
    name: 'ASH SMP',
    host: 'play.ashsmp.in',
    port: 25565,
    versions: '1.7.2–26.3',
    tags: ['SMP', 'Выживание', 'PvP'],
    note: 'SMP с экономикой, боссами и PvP-ареной.',
  },
  {
    id: 'concordmc',
    name: 'ConcordMC',
    host: 'play.concordmc.net',
    port: 25565,
    versions: '1.21–26.3',
    tags: ['Выживание', 'Экономика'],
    note: 'Сезонное выживание с квестами и рынком.',
  },
  {
    id: 'siegelands',
    name: 'Siegelands',
    host: 'siegelands.org',
    port: 25565,
    versions: '1.7.2–26.2',
    tags: ['SMP', 'Сезоны'],
    note: 'Уютный сезонный SMP с осадами и кланами.',
  },
  {
    id: 'mosspvp',
    name: 'MOSS PvP',
    host: 'play.mosspvp.net',
    port: 25565,
    versions: '1.7.2–26.3',
    tags: ['PvP', 'Практика', 'Дуэли'],
    note: 'PvP-практика: дуэли, киты, тренировки.',
  },
  {
    id: 'allaysmp',
    name: 'Allay SMP',
    host: 'allaysmp.pro',
    port: 25565,
    versions: '1.7.2–26.2',
    tags: ['SMP', 'Выживание'],
    note: 'Небольшой SMP с дружелюбным сообществом.',
  },
];

const cache = new Map();

function normalizeStatus(data) {
  const players = data?.players;
  const online = Number(players?.online);
  const max = Number(players?.max);
  return {
    online: Boolean(data?.online),
    players: Number.isFinite(online) ? { online, max: Number.isFinite(max) ? max : 0 } : null,
    version: typeof data?.version === 'string' ? data.version : '',
    motd: Array.isArray(data?.motd?.clean) ? data.motd.clean.join(' ').trim() : '',
  };
}

async function fetchStatus(server) {
  const cached = cache.get(server.host);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.value;

  let value;
  try {
    const data = await fetchJson(`${API}/${encodeURIComponent(server.host)}`, {
      attempts: 1,
      timeout: 7000,
    });
    value = normalizeStatus(data);
  } catch {
    value = { online: false, players: null, version: '', motd: '', unknown: true };
  }

  cache.set(server.host, { time: Date.now(), value });
  return value;
}

function parseRange(version) {
  const match = String(version || '').match(
    /(\d+\.\d+(?:\.\d+)?)\s*[-–—]\s*(\d+\.\d+(?:\.\d+)?)/,
  );
  if (!match) return null;
  return { min: match[1], max: match[2] };
}

function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => Number(part) || 0);
  const right = String(b).split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Понимает host, host:port, http://host:port и адреса с путём.
function parseServerAddress(input) {
  let value = String(input || '').trim();
  if (!value) return null;
  value = value.replace(/^[a-z]+:\/\//i, '');
  value = value.split('/')[0].trim();
  if (!value) return null;

  let host = value;
  let port = 25565;
  const ipv6 = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6) {
    host = ipv6[1];
    if (ipv6[2]) port = Number(ipv6[2]);
  } else if ((value.match(/:/g) || []).length === 1) {
    const [left, right] = value.split(':');
    host = left;
    port = Number(right);
  }

  host = host.toLowerCase();
  const validHost =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    /^[0-9a-f:]+$/i.test(host);
  if (!validHost || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { host, port };
}

async function listServers() {
  const statuses = await Promise.all(SERVERS.map((server) => fetchStatus(server)));
  return SERVERS.map((server, index) => {
    const status = statuses[index];
    const range = parseRange(status.version) || parseRange(server.versions);
    return {
      ...server,
      status: {
        online: status.online,
        players: status.players,
        version: status.version,
        motd: status.motd,
        unknown: Boolean(status.unknown),
      },
      minVersion: range?.min || '',
      maxVersion: range?.max || '',
    };
  });
}

module.exports = {
  SERVERS,
  listServers,
  parseServerAddress,
  parseRange,
  compareVersions,
};
