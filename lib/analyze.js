'use strict';

/**
 * 分析编排:扫描 → 归属(瀑布) → 概述(种子→LLM→降级) → 入口文档预翻译。
 * 触发时机:启动时与手动更新;其余时间纯读缓存零 API 调用。
 * 增量:概述与译文都以内容哈希为键,内容未变的技能直接沿用缓存。
 */

const fs = require('node:fs');
const path = require('node:path');
const { scan } = require('./scanner');
const { createEngine } = require('./attribution/engine');
const lockReader = require('./attribution/recognizers/lock-reader');
const {
  createLockRecognizer,
  createGitRecognizer,
  createFrontmatterUrlRecognizer,
  createLlmRecognizer,
  findSourceUrl,
  repoFromUrl,
} = require('./attribution/recognizers/sources');
const { buildSummaryMessages, parseSummary, buildInferenceMessages, parseInference } = require('./llm/tasks');
const { resolveStoredSummary, fallbackSummary, SUMMARY_META_VERSION } = require('./summaries');
const { localizeSummaries } = require('./summary-translate');
const { normalizeLang } = require('./languages');
const { detectLanguage, readJsonIfExists } = require('./util');

function createAnalyzer({ config, cache, pipeline, llmProvider, seeds = {} }) {
  const progress = { phase: 'idle', code: null, params: {}, done: 0, total: 0, detail: '', startedAt: null, errors: [], stages: [] };
  let running = null;
  let pendingLang = null;

  /** 任务面板阶段清单(顺序即执行序);status ∈ pending/running/done/skipped */
  const STAGE_IDS = ['scan', 'infer', 'attribute', 'summarize', 'translateMeta', 'pretranslate'];

  function resetStages() {
    progress.stages = STAGE_IDS.map((id) => ({ id, status: 'pending', done: 0, total: 0 }));
  }

  function setStage(id, patch) {
    const st = progress.stages.find((s) => s.id === id);
    if (st) Object.assign(st, patch);
  }

  /** 分析警告:code + params 供前端语言包渲染,message 保留中文回退 */
  function warn(code, params, message) {
    progress.errors.push({ code, params, message });
  }

  function buildEngine(overrides) {
    const engine = createEngine({ overrides });
    engine.registerManifestReader(lockReader);
    engine.registerSourceRecognizer(createLockRecognizer({
      manifestFiles: () => config.lockFiles,
    }));
    engine.registerSourceRecognizer(createGitRecognizer());
    engine.registerSourceRecognizer(createFrontmatterUrlRecognizer());
    engine.registerSourceRecognizer(createLlmRecognizer());
    return engine;
  }

  /** 当前是否正在分析(防止并发重入) */
  function isRunning() {
    return Boolean(running);
  }

  function getProgress() {
    return { ...progress, stages: progress.stages.map((s) => ({ ...s })) };
  }

  async function run({ trigger = 'manual', lang } = {}) {
    if (running) {
      // 分析进行中又收到语言切换:等当前轮结束后按最新语言再跑一轮(增量,内容未变不调 API)
      if (lang) pendingLang = normalizeLang(lang);
      return running;
    }
    const currentLang = normalizeLang(lang || cache.readState().uiLanguage || 'zh');
    running = (async () => analyze(trigger, currentLang))();
    try {
      return await running;
    } finally {
      running = null;
      if (pendingLang && pendingLang !== currentLang) {
        const next = pendingLang;
        pendingLang = null;
        run({ trigger: 'language', lang: next }).catch(() => {});
      } else {
        pendingLang = null;
      }
    }
  }

  async function analyze(trigger, lang) {
    progress.phase = 'scan';
    progress.code = 'progress.scanning';
    progress.params = {};
    progress.done = 0;
    progress.total = 0;
    progress.detail = '扫描技能根目录…';
    progress.startedAt = new Date().toISOString();
    progress.errors = [];
    resetStages();
    setStage('scan', { status: 'running' });
    const usage0 = pipeline ? { calls: pipeline.stats.calls, credits: pipeline.stats.credits } : null;

    const overrides = cache.readOverrides().entries;
    const engine = buildEngine(overrides);

    // 清单:先用注册的 reader 解析所有 lock 文件
    const manifests = {};
    for (const file of config.lockFiles) {
      const m = engine.readManifest(file);
      if (m) manifests[file] = m;
      else warn('warning.manifest_unreadable', { file }, `清单未识别或不可读: ${file}`);
    }
    const lockEntries = Object.values(manifests).flatMap((m) => Object.values(m.entries));
    const knownRepos = [...new Set(lockEntries.map((e) => e.repo).filter(Boolean))];

    const scanResult = scan({ roots: config.roots });
    setStage('scan', { status: 'done', done: scanResult.entities.length, total: scanResult.entities.length });

    // 每个实体附正文预览(LLM 概述/推断输入)
    progress.phase = 'attribute';
    progress.code = 'progress.attributingStart';
    progress.params = {};
    progress.detail = '归属分析…';
    progress.total = scanResult.entities.length;
    const entities = scanResult.entities.map((e) => enrichEntity(e));

    const upstreams = new Map();
    for (const e of entities) {
      const url = findSourceUrl(e.frontmatter || {});
      if (url) upstreams.set(e.dirName, { url, repo: repoFromUrl(url) });
    }

    // LLM 推断(标注"推断",存 lastInference 供确认);上一轮推断结果内容未变则复用,不重复调用。
    // 先跑一遍不含推断的瀑布,确定哪些技能需要推断。
    const baseCtx = { manifests, knownRepos, upstreams, lastInference: {} };
    const lastInference = {};
    const prevIndex = cache.readIndex();
    const prevEntities = new Map((prevIndex?.entities || []).map((e) => [e.id, e]));
    const prevInference = prevIndex?.lastInference || {};
    // 增量缓存:上次分析中断前已落盘的推断(hash 内嵌,优先于 index.lastInference——
    // 中断轮不会重写 entities,后者对新实体的 hash 校验必然落空)
    const incremental = cache.readInference().entries;
    setStage('infer', { status: llmProvider?.configured() ? 'running' : 'skipped' });
    let inferDone = 0;
    if (llmProvider?.configured()) {
      for (const e of entities) {
        const o = overrides[e.id];
        if (o && typeof o.repo === 'string') continue; // 手动已归组
        const base = await engine.resolve(e, baseCtx);
        if (base.repo) continue;
        const inc = incremental[e.id];
        if (inc && inc.hash === e.contentHash) {
          lastInference[e.id] = inc.result === undefined ? null : inc.result;
          setStage('infer', { done: ++inferDone });
          continue;
        }
        // 上一轮推断结果(含"推断不出"的负结果)内容未变则复用,不重复调用
        if (prevInference[e.id] !== undefined && prevEntities.get(e.id)?.contentHash === e.contentHash) {
          lastInference[e.id] = prevInference[e.id];
          setStage('infer', { done: ++inferDone });
          continue;
        }
        try {
          progress.code = 'progress.inferring';
          progress.params = { name: e.name };
          progress.detail = `LLM 推断归属:${e.name}`;
          const obj = await llmProvider.chatJson(buildInferenceMessages(e, knownRepos));
          const parsed = parseInference(obj);
          if (parsed) {
            lastInference[e.id] = {
              repo: parsed.repo,
              sourceUrl: null,
              group: null,
              method: 'llm',
              inferred: true,
              confidence: parsed.confidence,
              alternatives: parsed.alternatives,
              confirmed: false,
              upstream: base.upstream,
            };
          } else {
            lastInference[e.id] = null; // 负结果也缓存:内容未变不再烧 LLM 调用
          }
          setStage('infer', { done: ++inferDone });
          // 逐条实时落盘:后续阶段(概述/翻译)耗时更长,中途退出不白烧本次调用
          cache.appendInference(e.id, e.contentHash, lastInference[e.id]);
        } catch (err) {
          const detail = String(err.message || err).slice(0, 120);
          warn('warning.inference_failed', { name: e.name, error: detail }, `LLM 推断失败(${e.name}): ${detail}`);
        }
      }
    }

    if (llmProvider?.configured()) setStage('infer', { status: 'done' });

    // 最终遍:带推断结果与 overrides 走完整瀑布,得到最终归属
    const ctx = { manifests, knownRepos, upstreams, lastInference };
    const attributions = {};
    setStage('attribute', { status: 'running', total: entities.length });
    for (const [i, e] of entities.entries()) {
      progress.done = i + 1;
      progress.code = 'progress.attributing';
      progress.params = { name: e.name };
      progress.detail = `归属:${e.name}`;
      setStage('attribute', { done: i + 1 });
      attributions[e.id] = await engine.resolve(e, ctx);
    }
    setStage('attribute', { status: 'done' });

    // 概述:中文界面走种子/LLM;其它语言 = 描述 + 翻译后的分类/仓库简介(写语言缓存)
    progress.phase = 'summaries';
    progress.done = 0;
    progress.total = entities.length * 2;

    // 第一遍:保障中文概述缓存(任何界面语言都执行——新技能的分类标签由此产生,
    // 翻译阶段随后即可翻到;种子/缓存命中零调用,LLM 结果按 contentHash 落盘不重复调)
    const zhCards = {};
    setStage('summarize', { status: 'running', total: entities.length * 2 });
    for (const [i, e] of entities.entries()) {
      progress.done = i + 1;
      progress.code = 'progress.summarizing';
      progress.params = { name: e.name };
      progress.detail = `概述:${e.name}`;
      setStage('summarize', { done: i + 1 });
      zhCards[e.id] = await ensureZhSummary(e, attributions[e.id]);
    }

    let localizedCards = null;
    setStage('translateMeta', { status: 'skipped' });
    if (lang !== 'zh' && pipeline && pipelineProviderConfigured(pipeline)) {
      const analysisState = cache.readState();
      if (analysisState.consentTranslate) {
        setStage('translateMeta', { status: 'running' });
        progress.code = 'progress.translatingMeta';
        progress.params = {};
        progress.detail = '翻译概述/分类/仓库简介…';
        try {
          localizedCards = await localizeSummaries({
            entities,
            attributions,
            lang,
            seeds,
            cache,
            pipeline,
            consented: true,
          });
          if (localizedCards?.failed) {
            warn('warning.meta_translate_failed', { count: localizedCards.failed }, `概述翻译失败 ${localizedCards.failed} 项`);
          }
        } catch (err) {
          const detail = String(err.message || err).slice(0, 120);
          warn('warning.meta_translate_failed', { count: 1, error: detail }, `概述翻译失败: ${detail}`);
        }
        setStage('translateMeta', { status: 'done' });
      }
    }

    // 第二遍:按界面语言出卡(纯读,不再调 LLM)
    const cards = {};
    for (const [i, e] of entities.entries()) {
      progress.done = entities.length + i + 1;
      setStage('summarize', { done: entities.length + i + 1 });
      cards[e.id] = resolveCard(e, lang, localizedCards?.cards, zhCards[e.id]);
    }
    setStage('summarize', { status: 'done' });

    // 组装索引
    const index = {
      version: 1,
      scannedAt: scanResult.scannedAt,
      trigger,
      summaryLang: lang,
      metaVersion: SUMMARY_META_VERSION,
      roots: config.roots.map((r) => ({ path: r, label: labelOfRoot(r) })),
      lockFiles: config.lockFiles,
      entities: entities.map((e) => ({
        id: e.id,
        realPath: e.realPath,
        dirName: e.dirName,
        name: e.name,
        description: e.description,
        entryLanguage: e.entryLanguage,
        contentHash: e.contentHash,
        docs: e.docs,
        images: e.images,
        forked: Boolean(e.forked),
        versionLabel: e.versionLabel || null,
        appearances: e.appearances.map((ap) => ({ rootLabel: ap.rootLabel, linked: ap.linked })),
        copies: (e.copies || []).map((c) => ({
          realPath: c.realPath,
          appearances: c.appearances.map((ap) => ({ rootLabel: ap.rootLabel, linked: ap.linked })),
        })),
        attribution: attributions[e.id],
        summary: cards[e.id].summary,
        summarySource: cards[e.id].summarySource,
        categories: cards[e.id].categories,
      })),
      ignored: scanResult.ignored,
      lastInference,
      stats: {
        entities: entities.length,
        attributed: Object.values(attributions).filter((a) => a.repo).length,
        // 与前端卡片 [data-pending] 同口径:已应用未确认 ∪ 未应用候选
        // (负结果推断缓存 entry=null 无可确认项,不算;候选已有确认归属也不算)
        inferred: new Set([
          ...Object.entries(attributions).filter(([, a]) => a.inferred && !a.confirmed).map(([id]) => id),
          ...Object.entries(lastInference).filter(([id, cand]) => cand && !attributions[id]?.confirmed).map(([id]) => id),
        ]).size,
        linkedMerged: entities.reduce((n, e) => n + Math.max(0, e.appearances.length - 1), 0),
      },
    };
    cache.writeIndex(index);
    // 本轮推断结果已随 index.lastInference 落盘,增量缓存清空(避免文件无限增长)
    if (llmProvider?.configured()) cache.resetInference();

    // 入口文档预翻译:只在用户显式点「手动更新」时执行(知情、按需烧积分)。
    // 启动/同意隐私/保存设置都不预翻——尤其避免重启后对全部非当前语言技能
    // 一次性批量计费,以及与用户当前打开文档抢 4QPS 节流队列。
    // 目标 = 当前界面语言:中文界面预翻英文入口,英文界面预翻中文入口。
    const state = cache.readState();
    if (state.consentTranslate && trigger === 'manual' && pipeline && pipelineProviderConfigured(pipeline)) {
      progress.phase = 'pretranslate';
      const candidates = entities.filter((e) => e.entryLanguage !== lang);
      progress.total = candidates.length;
      progress.done = 0;
      setStage('pretranslate', { status: 'running', total: candidates.length });
      for (const e of candidates) {
        progress.done++;
        progress.code = 'progress.pretranslating';
        progress.params = { name: e.name };
        progress.detail = `预翻译:${e.name}`;
        setStage('pretranslate', { done: progress.done });
        try {
          await pipeline.ensureTranslation(e, 'SKILL.md', { consented: true, lang });
        } catch (err) {
          if (err.code !== 'provider_unconfigured') {
            const detail = String(err.message || err).slice(0, 120);
            warn('warning.pretranslate_failed', { name: e.name, error: detail }, `预翻译失败(${e.name}): ${detail}`);
          }
        }
      }
      setStage('pretranslate', { status: 'done' });
    }

    progress.phase = 'done';
    progress.code = 'progress.done';
    progress.params = { entities: index.stats.entities, attributed: index.stats.attributed };
    progress.detail = `完成:${index.stats.entities} 个技能,归属 ${index.stats.attributed} 个`;
    // 本轮未走到的阶段(如非手动触发的预翻译)标记为跳过
    progress.stages.forEach((s) => { if (s.status === 'pending') s.status = 'skipped'; });

    // 累计积分/调用数写入状态(增量:与 API 层 withUsageTracking 各计各的,不重复)
    const nextState = cache.readState();
    nextState.lastAnalysis = {
      at: new Date().toISOString(),
      trigger,
      entities: index.stats.entities,
      errors: progress.errors.slice(0, 20),
    };
    if (pipeline && usage0) {
      const dCalls = pipeline.stats.calls - usage0.calls;
      const dCredits = pipeline.stats.credits - usage0.credits;
      if (dCalls > 0) {
        nextState.apiCalls = (nextState.apiCalls || 0) + dCalls;
        nextState.creditsUsed = (nextState.creditsUsed || 0) + dCredits;
      }
    }
    cache.writeState(nextState);
    return index;
  }

  function pipelineProviderConfigured(p) {
    try {
      return p.providerConfigured();
    } catch {
      return false;
    }
  }

  function enrichEntity(e) {
    let bodyPreview = '';
    try {
      const skillMd = path.join(e.realPath, 'SKILL.md');
      const raw = fs.readFileSync(skillMd, 'utf8');
      const fmEnd = raw.indexOf('---', 3);
      bodyPreview = fmEnd > 0 ? raw.slice(raw.indexOf('\n', fmEnd) + 1) : raw;
    } catch { /* 忽略 */ }
    return { ...e, bodyPreview: bodyPreview.slice(0, 4000) };
  }

  /** 概述解析:中文界面走种子/缓存/LLM;其它语言用翻译后的描述/分类(翻译由 localizeSummaries 预先生成) */
  /**
   * 保障中文概述缓存(种子 → 中文缓存 → LLM,任何界面语言都执行):
   * 命中即零调用;LLM 生成结果按 contentHash 落盘,内容未变不重复调。
   * 未配置 LLM / 生成失败返回 null(出卡时降级为描述,分类由 other 兜底)。
   */
  async function ensureZhSummary(e, attribution) {
    const stored = resolveStoredSummary({ entity: e, attribution, lang: 'zh', seeds, cache });
    if (stored) return stored;
    if (llmProvider?.configured()) {
      try {
        const obj = await llmProvider.chatJson(buildSummaryMessages(e));
        const parsed = parseSummary(obj);
        if (parsed) {
          cache.writeSkill(e.id, 'zh', {
            id: e.id,
            lang: 'zh',
            contentHash: e.contentHash,
            summary: parsed.summary,
            summarySource: 'llm',
            categories: parsed.categories,
            createdAt: new Date().toISOString(),
          });
          return { summary: parsed.summary, summarySource: 'llm', categories: parsed.categories };
        }
      } catch (err) {
        const detail = String(err.message || err).slice(0, 120);
        warn('warning.summary_failed', { name: e.name, error: detail }, `LLM 概述失败(${e.name}): ${detail}`);
      }
    }
    return null;
  }

  /** 出卡(纯读):zh = 种子/缓存(ensureZhSummary 已保障);其它语言 = 翻译缓存,未命中回退描述 */
  function resolveCard(e, lang, localizedCards, zhCard) {
    if (lang !== 'zh') {
      const localized = localizedCards?.get(e.id);
      if (localized) return localized;
      // 翻译不可用或失败:先原文直出(摘要 = frontmatter 描述)
      return fallbackSummary(e, lang);
    }
    return zhCard || fallbackSummary(e, 'zh');
  }

  function labelOfRoot(root) {
    const parts = path.resolve(root).split(/[\\/]/).filter(Boolean);
    const idx = parts.lastIndexOf('skills');
    return idx > 0 ? parts[idx - 1] : parts[parts.length - 1] || root;
  }

  return { run, isRunning, getProgress, llmConfigured: () => Boolean(llmProvider?.configured()) };
}

module.exports = { createAnalyzer };
