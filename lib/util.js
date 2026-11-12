'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function shortHash(text, len = 12) {
  return sha1(text).slice(0, len);
}

/** 规范化真实路径,用于跨根去重键(Windows 大小写不敏感) */
function normalizeRealPath(p) {
  const norm = path.normalize(p);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

/** 简单限速器:minGapMs 为相邻两次调用的最小间隔。失败不毒化后续排队。 */
function createThrottle(minGapMs) {
  let last = 0;
  let tail = Promise.resolve();
  return function run(fn) {
    const result = tail.then(async () => {
      const wait = Math.max(0, last + minGapMs - Date.now());
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    // tail 永远保持 fulfilled,单次失败不影响后续调用
    tail = result.catch(() => {});
    return result;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发射间隔 + 并发上限的组合限流:相邻调用仍保持 minGapMs 间隔(守 QPS),
 * 但允许多个请求同时在途(至多 concurrency 个)。失败不毒化后续排队。
 */
function createLimiter(minGapMs, concurrency) {
  let last = 0;
  let active = 0;
  const queue = [];
  function pump() {
    while (active < concurrency && queue.length) {
      const { fn, res, rej } = queue.shift();
      active++;
      const wait = Math.max(0, last + minGapMs - Date.now());
      last = Date.now() + wait; // 预约发射时刻,排队任务依次错开
      sleep(wait)
        .then(fn)
        .then(res, rej)
        .finally(() => {
          active--;
          pump();
        });
    }
  }
  return function run(fn) {
    return new Promise((res, rej) => {
      queue.push({ fn, res, rej });
      pump();
    });
  };
}

/** CJK 字符占比,用于判定中文文档(单栏直出,不翻译) */
function detectLanguage(text) {
  const stripped = text.replace(/```[\s\S]*?```/g, ' ');
  const cjk = stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)?.length ?? 0;
  const letters = stripped.match(/[A-Za-z]/g)?.length ?? 0;
  const total = cjk + letters;
  if (total === 0) return 'unknown';
  return cjk / total >= 0.25 ? 'zh' : 'en';
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子写 JSON(先写临时文件再改名,避免扫描中途崩溃留下半截缓存) */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = {
  sha1,
  shortHash,
  normalizeRealPath,
  createThrottle,
  createLimiter,
  sleep,
  detectLanguage,
  readJsonIfExists,
  writeJsonAtomic,
};
