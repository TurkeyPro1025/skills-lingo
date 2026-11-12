'use strict';

/**
 * 翻译管线:块级解析 → 行内保护 → 分块打包单次调用(积分友好)→ 拆回按 ID 关联 → 缓存。
 * 缓存键 = 技能真实路径哈希 + 文档内容哈希;内容未变永不重复调用。
 * 失败块逐块记录错误,可重试;打包调用失败自动降级为逐块调用尽量挽回。
 */

const fs = require('node:fs');
const path = require('node:path');
const { sha1, shortHash, writeJsonAtomic, readJsonIfExists, detectLanguage } = require('../util');
const { parseFrontmatter } = require('../frontmatter');
const { parseBlocks, protectInline, restoreInline } = require('./blocks');

const CACHE_VERSION = 2;
const CHUNK_MARGIN = 100; // 分块余量:仅覆盖 ⟦S n⟧/⟦E⟧ 分隔符(约 12 字符/块)
// 打包目标字符数:uapipro 在 Cloudflare 后,大包(origin 处理慢)易 524 超时——
// 实测 ~4700 字符即触发。按 3000 打包:首包成功率与响应速度都更好,6 并发下吞吐不吃亏
const PACK_TARGET = 3000;

/** 打包上限:接口硬限(1 万)与 524 规避目标的较小者 */
function packMaxChars(provider) {
  return Math.min(provider.maxCharsPerCall - CHUNK_MARGIN, PACK_TARGET);
}

function createPipeline({ provider, cacheDir, onProgress }) {
  const stats = { calls: 0, credits: 0 };
  // 同一文档的并发翻译请求共享同一个进行中的 Promise:
  // 避免"查看器请求 + 后台预翻"并发时对同一文档翻译两遍(双倍积分)。
  const inflight = new Map();
  // 单文档翻译实时进度(经 /api/status 暴露给查看器横幅);null = 无进行中的翻译。
  // creditsEstimated = 打包调用数 × 每次调用积分(若发生逐块降级,实际消耗会更多)。
  let docProgress = null;

  function translationsDir(skillId, lang) {
    return path.join(cacheDir, 'translations', skillId, lang);
  }

  function cacheFile(skillId, lang, docHash) {
    return path.join(translationsDir(skillId, lang), `${docHash}.json`);
  }

  /** v1 布局(无语言段)的旧文件:只按中文解释,英文请求不得误命中中文译文 */
  function legacyCacheFile(skillId, docHash) {
    return path.join(cacheDir, 'translations', skillId, `${docHash}.json`);
  }

  /** 读缓存;docHash 不匹配(内容已变)即视为 miss。中文请求可懒迁移 v1 旧文件。 */
  function readCache(skillId, docHash, lang = 'zh') {
    const hit = readJsonIfExists(cacheFile(skillId, lang, docHash));
    if (hit && hit.version === CACHE_VERSION && hit.lang === lang && hit.docHash === docHash) return hit;
    if (lang !== 'zh') return null;
    const legacy = readJsonIfExists(legacyCacheFile(skillId, docHash));
    if (!legacy || legacy.version !== 1 || legacy.docHash !== docHash) return null;
    // 旧缓存必为中文译文:迁移到新路径,中文缓存与积分无损
    const migrated = { ...legacy, version: CACHE_VERSION, lang: 'zh' };
    writeCache(migrated);
    try { fs.unlinkSync(legacyCacheFile(skillId, docHash)); } catch { /* 已被并发迁移 */ }
    return migrated;
  }

  function writeCache(entry) {
    writeJsonAtomic(cacheFile(entry.skillId, entry.lang || 'zh', entry.docHash), entry);
  }

  /**
   * 确保某文档有目标语言译文:完整缓存命中直接返回;部分缓存(上次中断)续翻剩余块,
   * 已完成块不再消耗积分。文档语言与目标语言一致时单栏直出、不翻译、不耗积分。
   * 首次翻译前必须已获用户同意(consent 由 API 层校验后传入)。
   */
  async function ensureTranslation(entity, docRelPath, { consented, lang = 'zh' } = {}) {
    const docPath = path.join(entity.realPath, docRelPath);
    let raw;
    try {
      raw = fs.readFileSync(docPath, 'utf8');
    } catch (err) {
      throw Object.assign(new Error(`文档不可读: ${docRelPath}`), { code: 'doc_unreadable', params: { path: docRelPath }, cause: err });
    }
    const docHash = sha1(raw);
    if (detectLanguage(raw) === lang) {
      return { language: lang, cached: true, blocks: null, reason: 'same_language' };
    }

    const cached = readCache(entity.id, docHash, lang);
    if (cached && !cached.blocks.some((b) => b.status === 'pending')) return { ...cached, cached: true };

    if (!provider.configured()) {
      throw Object.assign(new Error('翻译 provider 未配置(API key 缺失)'), { code: 'provider_unconfigured' });
    }
    if (!consented) {
      throw Object.assign(new Error('需要用户同意隐私提示后才能翻译'), { code: 'consent_required' });
    }

    const inflightKey = `${entity.id}\0${lang}\0${docHash}`;
    const existing = inflight.get(inflightKey);
    if (existing) return existing;

    let p;
    if (cached) {
      // 部分缓存:续翻剩余 pending 块(上次翻译中断,已烧积分的块不重复翻译)
      p = resumeTranslation(entity, docRelPath, cached, lang)
        .then((r) => ({ ...r, cached: true, resumed: r.resumedCount }))
        .finally(() => inflight.delete(inflightKey));
    } else {
      p = translateDoc(entity, docRelPath, raw, docHash, lang)
        .then((r) => ({ ...r, cached: false }))
        .finally(() => inflight.delete(inflightKey));
    }
    inflight.set(inflightKey, p);
    return p;
  }

  async function translateDoc(entity, docRelPath, raw, docHash, lang) {
    // frontmatter 摘出不译(spec:frontmatter 与代码块占位摘出、译后回填)
    const { body } = parseFrontmatter(raw);
    const blocks = parseBlocks(body);
    const translatable = blocks.filter((b) => b.translatable);
    const result = {
      version: CACHE_VERSION,
      lang,
      skillId: entity.id,
      realPath: entity.realPath,
      docRelPath,
      docHash,
      provider: provider.name,
      createdAt: new Date().toISOString(),
      blocks: blocks.map((b) => ({ id: b.id, type: b.type, src: b.text, translated: '', status: b.translatable ? 'pending' : 'original' })),
      calls: 0,
      credits: 0,
    };
    const byId = new Map(result.blocks.map((b) => [b.id, b]));

    const chunks = packChunks(translatable, packMaxChars(provider));
    await runChunks(entity, docRelPath, chunks, byId, result, lang, { doneStart: 0, total: translatable.length });
    writeCache(result);
    return result;
  }

  /** 续翻:以部分缓存为底,把 pending 块继续打包翻译(与首轮同并发/同落盘策略) */
  async function resumeTranslation(entity, docRelPath, cached, lang) {
    const pending = cached.blocks.filter((b) => b.status === 'pending');
    const total = cached.blocks.filter((b) => b.status !== 'original').length;
    const byId = new Map(cached.blocks.map((b) => [b.id, b]));
    const pseudoBlocks = pending.map((b) => ({ id: b.id, text: b.src, translatable: true, type: b.type }));
    const chunks = packChunks(pseudoBlocks, packMaxChars(provider));
    await runChunks(entity, docRelPath, chunks, byId, cached, lang, { doneStart: total - pending.length, total });
    writeCache(cached);
    return { ...cached, resumedCount: pending.length };
  }

  /**
   * 并发翻译一组打包块并合并进 result。每包完成即落盘(部分结果经 GET 端点渐进取回,
   * 中断后由 resumeTranslation 续翻,已烧积分不浪费)。发射间隔/并发上限由 provider 闸控制。
   */
  async function runChunks(entity, docRelPath, chunks, byId, result, lang, { doneStart, total }) {
    docProgress = {
      skillId: entity.id,
      doc: docRelPath,
      done: doneStart,
      total,
      callsDone: 0,
      callsTotal: chunks.length,
      creditsEstimated: chunks.length * (provider.creditsPerCall || 0),
    };
    let done = doneStart;
    try {
      await Promise.all(chunks.map(async (chunk) => {
        await translateChunk(chunk, byId, result, lang);
        done += chunk.length;
        docProgress.done = done;
        docProgress.callsDone = result.calls;
        onProgress?.({ doc: docRelPath, done, total });
        writeCache(result); // 逐包快照落盘:并发下均为完整快照,后写覆盖先写
      }));
    } finally {
      docProgress = null;
    }
  }

  /**
   * 翻译一包块:打包调用(失败重试一次)→ 仍失败二分分包递归 → 单块直调。
   * 直接逐块降级会让 N 块文档烧 N 倍积分(实测 27 块 = 108 积分),二分把爆炸压回对数级。
   */
  async function translateChunk(chunkBlocks, byId, result, lang) {
    const masked = chunkBlocks.map((b) => {
      const { masked: m, map } = protectInline(b.text);
      return { block: b, masked: m, map };
    });
    const joined = masked.map((x, i) => `⟦S${i}⟧\n${x.masked}`).join('\n⟦E⟧\n');

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await callProvider(joined, result, lang);
        const parts = splitBySeparators(out, masked.length);
        if (!parts) throw new Error('分隔符丢失');
        masked.forEach((x, i) => {
          applyResult(byId, x, parts[i]);
        });
        return;
      } catch (err) {
        lastErr = err;
      }
    }

    // 打包两次失败:告警可见(诊断线索随缓存落盘),再降级
    const detail = String(lastErr?.message || lastErr).slice(0, 160);
    result.warnings = result.warnings || [];
    result.warnings.push(`打包翻译失败(${masked.length} 块,${joined.length} 字符):${detail};已降级分包重试`);

    if (masked.length > 1) {
      // 二分分包(按字符中点切,两半均衡):更短文本 + 更少分隔符,成功率回升;最坏才退化到单块
      const totalChars = masked.reduce((n, x) => n + x.masked.length, 0);
      let acc = 0;
      let mid = 1;
      for (let i = 0; i < masked.length - 1; i++) {
        acc += masked[i].masked.length;
        if (acc >= totalChars / 2) { mid = i + 1; break; }
      }
      await translateChunk(chunkBlocks.slice(0, mid), byId, result, lang);
      await translateChunk(chunkBlocks.slice(mid), byId, result, lang);
      return;
    }

    // 单块直调(无分隔符包装)
    const x = masked[0];
    try {
      const out = await callProvider(x.masked, result, lang);
      applyResult(byId, x, out);
    } catch (err) {
      const b = byId.get(x.block.id);
      b.status = 'failed';
      b.error = String(err.message || err).slice(0, 300);
    }
  }

  async function callProvider(text, result, lang) {
    try {
      const { text: translated, credits } = await provider.translateText(text, { targetLang: lang });
      result.calls++;
      result.credits += credits;
      stats.calls++;
      stats.credits += credits;
      return translated;
    } catch (err) {
      throw err;
    }
  }

  /** 单次调用(不挂到某文档记录):概述/分类/仓库简介的批量翻译 */
  async function callProviderRaw(text, lang) {
    const { text: translated, credits } = await provider.translateText(text, { targetLang: lang });
    stats.calls++;
    stats.credits += credits;
    return translated;
  }

  /**
   * 批量翻译短文本(概述/分类/仓库简介):贴满单次字符上限打包,⟦S n⟧/⟦E⟧ 分隔。
   * 返回与输入等长的数组;失败或超长项为 null,由调用方回退原文并在下次分析重试。
   */
  async function translateTexts(texts, { lang = 'zh' } = {}) {
    const out = new Array(texts.length).fill(null);
    if (!texts.length) return out;
    const max = packMaxChars(provider);
    const chunks = [];
    let cur = [];
    let curLen = 0;
    for (const [i, text] of texts.entries()) {
      if (typeof text !== 'string' || !text.trim()) {
        out[i] = text;
        continue;
      }
      const { masked, map } = protectInline(text);
      const add = masked.length + 16;
      if (add > max) continue;
      if (cur.length && curLen + add > max) {
        chunks.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push({ i, masked, map });
      curLen += add;
    }
    if (cur.length) chunks.push(cur);

    for (const chunk of chunks) {
      const joined = chunk.map((x, n) => `⟦S${n}⟧\n${x.masked}`).join('\n⟦E⟧\n');
      try {
        const translated = await callProviderRaw(joined, lang);
        const parts = splitBySeparators(translated, chunk.length);
        if (!parts) continue;
        chunk.forEach((x, n) => {
          try {
            out[x.i] = restoreInline(parts[n], x.map).trim();
          } catch {
            out[x.i] = null;
          }
        });
      } catch {
        // 整包失败:该包的项保持 null,不拖垮其他包
      }
    }
    return out;
  }

  function applyResult(byId, x, translatedMasked) {
    const b = byId.get(x.block.id);
    try {
      b.translated = restoreInline(translatedMasked, x.map);
      b.status = 'ok';
      b.error = null;
    } catch (err) {
      b.status = 'failed';
      b.error = String(err.message || err);
    }
  }

  /** 拆回译文:必须精确得到 n 段,否则返回 null */
  function splitBySeparators(text, n) {
    // ⟦S0⟧ ... ⟦E⟧ ⟦S1⟧ ... ⟦E⟧ ⟦S2⟧ ...
    const parts = [];
    let rest = text;
    for (let i = 0; i < n; i++) {
      const startRe = new RegExp(`^\\s*⟦S${i}⟧\\s*\\n?`);
      const m = startRe.exec(rest);
      if (!m) return null;
      rest = rest.slice(m[0].length);
      const endIdx = rest.indexOf('⟦E⟧');
      if (i < n - 1) {
        if (endIdx === -1) return null;
        parts.push(rest.slice(0, endIdx));
        rest = rest.slice(endIdx + 3);
      } else {
        parts.push(endIdx === -1 ? rest : rest.slice(0, endIdx));
      }
    }
    return parts;
  }

  function packChunks(blocks, maxChars) {
    const chunks = [];
    let cur = [];
    let curLen = 0;
    const overhead = (n) => n * 12 + 20;
    for (const b of blocks) {
      const add = b.text.length + 12;
      if (cur.length && curLen + add + overhead(cur.length + 1) > maxChars) {
        chunks.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(b);
      curLen += add;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /** 重试失败块:只重译 status=failed 的块,合并进缓存 */
  async function retryFailed(entity, docRelPath, { consented, lang = 'zh' } = {}) {
    if (!provider.configured()) {
      throw Object.assign(new Error('翻译 provider 未配置'), { code: 'provider_unconfigured' });
    }
    if (!consented) {
      throw Object.assign(new Error('需要用户同意隐私提示后才能翻译'), { code: 'consent_required' });
    }
    const raw = fs.readFileSync(path.join(entity.realPath, docRelPath), 'utf8');
    const docHash = sha1(raw);
    const cached = readCache(entity.id, docHash, lang);
    if (!cached) return ensureTranslation(entity, docRelPath, { consented, lang });

    const failed = cached.blocks.filter((b) => b.status === 'failed');
    if (!failed.length) return { ...cached, cached: true, retried: 0 };

    const byId = new Map(cached.blocks.map((b) => [b.id, b]));
    const pseudoBlocks = failed.map((b) => ({ id: b.id, text: b.src, translatable: true, type: b.type }));
    const chunks = packChunks(pseudoBlocks, packMaxChars(provider));
    const total = cached.blocks.filter((b) => b.status !== 'original').length;
    await runChunks(entity, docRelPath, chunks, byId, cached, lang, { doneStart: total - failed.length, total });
    writeCache(cached);
    return { ...cached, cached: true, retried: failed.length };
  }

  return {
    ensureTranslation,
    retryFailed,
    translateTexts,
    readCache,
    stats,
    providerConfigured: () => provider.configured(),
    getDocProgress: () => (docProgress ? { ...docProgress } : null),
  };
}

module.exports = { createPipeline };
