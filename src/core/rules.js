'use strict';

const os = require('os');

function getOsName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function getOsArch() {
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch === 'x64' ? 'x86_64' : process.arch;
}

function ruleMatches(rule, features = {}) {
  if (!rule) return true;

  if (rule.os) {
    const osName = getOsName();
    const arch = getOsArch();
    if (rule.os.name && rule.os.name !== osName) return false;
    if (rule.os.arch && rule.os.arch !== arch) return false;
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(os.release())) return false;
      } catch {
        return false;
      }
    }
  }

  if (rule.features) {
    for (const [key, expected] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== Boolean(expected)) return false;
    }
  }

  return true;
}

function isAllowed(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features)) {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

function collectArguments(list, features = {}, onWarning = null) {
  const result = [];
  if (!Array.isArray(list)) return result;
  for (const entry of list) {
    if (typeof entry === 'string') {
      result.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (!isAllowed(entry.rules, features)) continue;
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const value of values) {
      if (typeof value === 'string') result.push(value);
      else onWarning?.(`Неизвестный аргумент запуска: ${JSON.stringify(value)}`);
    }
  }
  return result;
}

function libraryAllowed(library, features = {}) {
  return isAllowed(library?.rules, features);
}

module.exports = {
  getOsName,
  getOsArch,
  ruleMatches,
  isAllowed,
  collectArguments,
  libraryAllowed,
};
