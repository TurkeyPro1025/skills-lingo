'use strict';

/**
 * JSON 缓存层:索引 / 每技能一文件 / 译文按技能+哈希分文件 / overrides / 运行状态。
 * API key 绝不写入任何缓存文件(只存在内存与环境变量)。
 */

const path = require('node:path');
const fs = require('node:fs');
const { readJsonIfExists, writeJsonAtomic } = require('./util');

function createCache({ dataDir }) {
  const dirs = {
    root: dataDir,
    skills: path.join(dataDir, 'skills'),
    translations: path.join(dataDir, 'translations'),
  };

  function ensureDirs() {
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  }

  // ---- 索引(扫描+归属+概述后的全量视图) ----
  function readIndex() {
    return readJsonIfExists(path.join(dirs.root, 'index.json'));
  }

  function writeIndex(index) {
    writeJsonAtomic(path.join(dirs.root, 'index.json'), index);
  }

  // ---- LLM 推断增量缓存:hash 与结果绑定,逐条实时落盘 ----
  // index.json 只在整轮分析(归属+概述+翻译)末尾写入,推断若不单独落盘,
  // 中途退出会让已烧掉的 LLM 调用全部作废,下轮从 0 重推。
  function inferenceFile() {
    return path.join(dirs.root, 'inference.json');
  }

  function readInference() {
    const d = readJsonIfExists(inferenceFile());
    return d && typeof d.entries === 'object' ? d : { version: 1, entries: {} };
  }

  function appendInference(id, contentHash, result) {
    const d = readInference();
    d.entries[id] = { hash: contentHash, result: result === undefined ? null : result };
    writeJsonAtomic(inferenceFile(), d);
  }

  function resetInference() {
    writeJsonAtomic(inferenceFile(), { version: 1, entries: {} });
  }

  // ---- 每技能每语言一文件(概述/分类,记录内容哈希做增量) ----
  // v1 布局 skills/{id}.json 是中文概述;读取中文时懒迁移到 skills/{id}/zh.json,
  // 英文等其它语言只读自己的语言段,不会误用中文概述。
  function skillFile(id, lang = 'zh') {
    return path.join(dirs.skills, id, `${lang}.json`);
  }

  function legacySkillFile(id) {
    return path.join(dirs.skills, `${id}.json`);
  }

  function readSkill(id, lang = 'zh') {
    const hit = readJsonIfExists(skillFile(id, lang));
    if (hit) return hit;
    if (lang !== 'zh') return null;
    const legacy = readJsonIfExists(legacySkillFile(id));
    if (!legacy) return null;
    writeJsonAtomic(skillFile(id, 'zh'), legacy);
    return legacy;
  }

  function writeSkill(id, lang, data) {
    writeJsonAtomic(skillFile(id, lang), data);
  }

  // ---- 语言相关的元数据翻译缓存:仓库简介 / 分类标签(按源文本哈希失效) ----
  function repoSummariesFile(lang) {
    return path.join(dirs.root, 'summaries', 'repos', `${lang}.json`);
  }

  function readRepoSummaries(lang) {
    return readJsonIfExists(repoSummariesFile(lang)) || { version: 1, lang, entries: {} };
  }

  function writeRepoSummaries(lang, data) {
    writeJsonAtomic(repoSummariesFile(lang), { ...data, version: 1, lang });
  }

  function labelMapFile(lang) {
    return path.join(dirs.root, 'summaries', 'labels', `${lang}.json`);
  }

  function readLabelMap(lang) {
    const data = readJsonIfExists(labelMapFile(lang));
    return data && typeof data.labels === 'object' ? data.labels : {};
  }

  function writeLabelMap(lang, labels) {
    writeJsonAtomic(labelMapFile(lang), { version: 1, lang, labels });
  }

  // ---- overrides(手动归组,最高优先级,重分析不覆盖) ----
  function readOverrides() {
    const o = readJsonIfExists(path.join(dirs.root, 'overrides.json'));
    return o && typeof o.entries === 'object' ? o : { version: 1, entries: {} };
  }

  function writeOverrides(data) {
    writeJsonAtomic(path.join(dirs.root, 'overrides.json'), data);
  }

  // ---- 运行状态(隐私同意、积分消耗、上次分析) ----
  function readState() {
    return readJsonIfExists(path.join(dirs.root, 'state.json')) || {
      version: 1,
      consentTranslate: false,
      creditsUsed: 0,
      apiCalls: 0,
      lastAnalysis: null,
    };
  }

  function writeState(state) {
    writeJsonAtomic(path.join(dirs.root, 'state.json'), state);
  }

  return {
    dirs,
    ensureDirs,
    readIndex,
    writeIndex,
    readInference,
    appendInference,
    resetInference,
    readSkill,
    writeSkill,
    readOverrides,
    writeOverrides,
    readState,
    writeState,
    readRepoSummaries,
    writeRepoSummaries,
    readLabelMap,
    writeLabelMap,
  };
}

module.exports = { createCache };
