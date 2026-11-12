'use strict';

/**
 * 概述解析(读路径 + 翻译源):
 * - 中文界面:种子 → 中文缓存 → (分析阶段 LLM) → 原文描述。
 * - 非中文界面:card-summary = frontmatter 描述(英文直接使用,其它语言翻译);
 *   分类标签与仓库简介来自中文种子/中文概述缓存,翻译后写入该语言缓存。
 * 读路径不发起任何外部调用;缺失时先原文直出,等分析补齐。
 */

const { sha1 } = require('./util');

// 概述策略版本:非中文界面 = 描述 + 翻译元数据。旧索引(无此字段或低于 2)需重跑一次。
const SUMMARY_META_VERSION = 2;

/* ============ 一级分类体系(category-chips 用) ============ */
// 固定 7 个一级分类,数组顺序即展示序;细分标签读取时归并到一级,不重写缓存。
// 开发与工程 = 原「开发实践/工程流程」合并:真实数据里工程向标签占多数,拆两类边界争议大。
const L1_ORDER = ['dev', 'writing', 'learning', 'design', 'data', 'life', 'other'];
// 分类名(一级中文名或历史细分名)→ 一级 id;未命中归 other。LLM 概述今后只产出一级中文名(见 llm/tasks.js)。
const L1_BY_NAME = {
  开发与工程: 'dev', 开发实践: 'dev', 前端开发: 'dev', 实现与编码: 'dev', 代码审查: 'dev', 调试: 'dev', 测试: 'dev',
  任务分解: 'dev', 推荐系统: 'dev', 工程流程: 'dev', 项目管理: 'dev', 项目配置: 'dev', 规格与工单: 'dev',
  会话管理: 'dev', 领域建模: 'dev', 需求文档: 'dev',
  写作沟通: 'writing', 写作: 'writing', 沟通模式: 'writing', 演示文稿: 'writing',
  学习研究: 'learning', 学习引导: 'learning', 教学材料: 'learning', 调研: 'learning',
  设计创意: 'design', 设计: 'design', 视觉设计: 'design', 设计智能: 'design', 品牌视觉: 'design', 设计系统: 'design',
  数据分析: 'data',
  生活效率: 'life', 生活服务: 'life', 旅游规划: 'life', 旅行生活: 'life',
  其他: 'other',
};

/** 分类名 → 一级 id(未命中 other) */
const toL1 = (name) => L1_BY_NAME[name] || 'other';

/** 分类名数组 → 一级 id 数组(保持顺序与长度,卡片细分标签按索引对应) */
const l1Of = (names) => (names || []).map(toL1);

function seedFor(entity, attribution, seeds) {
  const sources = seeds?.sources || {};
  const byRepo = attribution?.repo ? sources[attribution.repo] : null;
  return byRepo?.skills?.[entity.dirName] || sources['*']?.skills?.[entity.dirName] || null;
}

/** 分类的来源:种子优先,其次中文 LLM 概述缓存 */
function sourceCategories({ entity, attribution, seeds, cache }) {
  const seed = seedFor(entity, attribution, seeds);
  if (seed?.categories?.length) return seed.categories;
  const cached = cache.readSkill(entity.id, 'zh');
  if (cached && cached.contentHash === entity.contentHash && Array.isArray(cached.categories)) {
    return cached.categories;
  }
  return [];
}

/** 非中文界面的翻译源:描述 + 中文分类标签 */
function localizedSource({ entity, attribution, seeds, cache }) {
  return {
    description: String(entity.description || ''),
    categories: sourceCategories({ entity, attribution, seeds, cache }),
  };
}

/** 源文本哈希:描述或分类变化时使该语言的概述缓存失效 */
function summarySourceHash(source) {
  return sha1(JSON.stringify({ description: source.description, categories: source.categories }));
}

function isValidLocalizedCache(cached, entity, lang, source) {
  return Boolean(cached
    && cached.lang === lang
    && cached.contentHash === entity.contentHash
    && cached.summarySource === 'description'
    && cached.sourceHash === summarySourceHash(source)
    && typeof cached.summary === 'string');
}

function resolveStoredSummary({ entity, attribution, lang, seeds, cache }) {
  if (lang === 'zh') {
    const seed = seedFor(entity, attribution, seeds);
    if (seed?.summary) {
      return { summary: seed.summary, summarySource: 'seed', categories: seed.categories || [] };
    }
    const cached = cache.readSkill(entity.id, 'zh');
    if (cached && cached.contentHash === entity.contentHash && cached.summary) {
      return { summary: cached.summary, summarySource: cached.summarySource || 'llm', categories: cached.categories || [] };
    }
    return null;
  }

  const source = localizedSource({ entity, attribution, seeds, cache });
  const cached = cache.readSkill(entity.id, lang);
  if (isValidLocalizedCache(cached, entity, lang, source)) {
    return { summary: cached.summary, summarySource: 'description', categories: cached.categories || [] };
  }
  // 尚未翻译:先原文直出;分类留空,等分析补齐翻译缓存
  return {
    summary: source.description || '(no description)',
    summarySource: 'description',
    categories: [],
  };
}

function fallbackSummary(entity, lang) {
  return {
    summary: entity.description || (lang === 'zh' ? '(无描述)' : '(no description)'),
    summarySource: lang === 'zh' ? 'fallback' : 'description',
    categories: [],
  };
}

/** 仓库简介:中文用种子原文;其它语言用翻译缓存(按源文本哈希校验) */
function resolveRepoSummary(repo, lang, seeds, cache) {
  const source = seeds?.sources?.[repo]?.repoSummary || '';
  if (!source) return '';
  if (lang === 'zh') return source;
  const entry = cache.readRepoSummaries(lang)?.entries?.[repo];
  if (entry && entry.sourceHash === sha1(source) && entry.summary) return entry.summary;
  return '';
}

module.exports = {
  SUMMARY_META_VERSION,
  L1_ORDER,
  toL1,
  l1Of,
  sourceCategories,
  localizedSource,
  summarySourceHash,
  isValidLocalizedCache,
  resolveStoredSummary,
  fallbackSummary,
  resolveRepoSummary,
};
