'use strict';

/**
 * 黑盒测试:唯一测试缝 = 本地服务的 HTTP API(spec 测试决策)。
 * fixture 技能树 + stub provider,不打真网、不需要真实 key。
 * 覆盖票 01-12 的验收标准;UI 手动验收清单见 README。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { buildFixtures, createFakeUApiPro, createFakeLlm } = require('./helpers');
const { loadConfig } = require('../lib/config');
const { createCache } = require('../lib/cache');
const { createCredentialStore } = require('../lib/credentials');
const { createProviderSettings } = require('../lib/providerSettings');
const { createTranslateProvider } = require('../lib/translate/uapipro');
const { createPipeline } = require('../lib/translate/pipeline');
const { createLlmProvider } = require('../lib/llm/provider');
const { createAnalyzer } = require('../lib/analyze');
const { createApp } = require('../lib/api');
const { createEngine } = require('../lib/attribution/engine');
const lockReader = require('../lib/attribution/recognizers/lock-reader');
const { sha1 } = require('../lib/util');
const presets = require('../lib/llm/presets.json');

/* ---------- 实现选择:node(默认)| rust(desktop Tauri 版) ----------
   同一套 28 项黑盒测试驱动两种实现:
   - node:进程内 createApp(回退线,始终保留)
   - rust:spawn desktop 的 --serve 模式,密钥经与 Node 完全相同的
     加密存储格式(providers.json + credentials.enc/.masterkey)预置 */
const IMPL = process.env.SKILLS_LINGO_TEST_IMPL === 'rust' ? 'rust' : 'node';
const RUST_BIN = process.env.SKILLS_LINGO_RUST_BIN
  || [path.join(__dirname, '..', 'desktop', 'target', 'release', 'skills-lingo-desktop.exe'),
      path.join(__dirname, '..', 'desktop', 'target', 'debug', 'skills-lingo-desktop.exe')]
    .find((p) => fs.existsSync(p));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-lingo-test-'));
const FIXTURES = path.join(TMP, 'fixtures');
const DATA = path.join(TMP, 'data');

const ctx = {};

/* ---------- 基建 ---------- */

async function startApp({ dataDir = DATA, llmEnv = true, translateEnv = true } = {}) {
  if (IMPL === 'rust') return startRustApp({ dataDir, llmEnv, translateEnv });
  return startNodeApp({ dataDir, llmEnv, translateEnv });
}

/** Node 实现:进程内装配(回退线) */
async function startNodeApp({ dataDir, llmEnv, translateEnv }) {
  const llmPort = ctx.llmPort;
  const cfg = loadConfig(path.join(TMP, 'config.json'));
  cfg.dataDir = dataDir;
  cfg.port = 0;

  const cache = createCache({ dataDir });
  cache.ensureDirs();
  const credStore = await createCredentialStore({ dataDir }).init();
  const providerSettings = createProviderSettings({ dataDir });
  // 无环境变量概念:配置一律走加密存储 + providers.json(与网页设置页同链路)
  if (translateEnv) credStore.set('uapipro', 'stub-key');
  if (llmEnv) {
    credStore.set('llm', 'stub-llm-key');
    providerSettings.updateLlm({ preset: 'custom', baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'stub-model' });
  }
  const translateProvider = createTranslateProvider(cfg.providers.translate, {
    keyGetter: () => credStore.get('uapipro') || '',
  });
  const pipeline = createPipeline({ provider: translateProvider, cacheDir: dataDir });
  const llmProvider = createLlmProvider(cfg.providers.llm, {
    getBaseUrl: () => providerSettings.get().llm.baseUrl || '',
    getApiKey: () => credStore.get('llm') || '',
    getModel: () => providerSettings.get().llm.model || '',
  });
  const seeds = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'seeds.json'), 'utf8'));
  const analyzer = createAnalyzer({ config: cfg, cache, pipeline, llmProvider, seeds });
  const { server } = createApp({ config: cfg, cache, analyzer, pipeline, seeds, credStore, providerSettings, presets });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { server, port, base: `http://127.0.0.1:${port}`, translateProvider, llmProvider };
}

/** Rust 实现:spawn desktop --serve,密钥用与 Node 相同的落盘格式预置 */
async function startRustApp({ dataDir, llmEnv, translateEnv }) {
  assert.ok(RUST_BIN, '未找到 Rust 二进制(先 cargo build)');
  const dbg = (...a) => { if (process.env.SV_TEST_DEBUG) console.error('[rust-app]', ...a); };
  dbg('start', dataDir);
  const configPath = path.join(TMP, `config-${path.basename(dataDir)}.json`);
  fs.writeFileSync(configPath, JSON.stringify({
    port: 0,
    host: '127.0.0.1',
    roots: ctx.fixtures.roots,
    lockFiles: [ctx.fixtures.lock],
    dataDir,
    seedsFile: path.join(FIXTURES, 'seeds.json'),
    providers: {
      translate: {
        endpoint: `http://127.0.0.1:${ctx.uapiPort}/api/v1/ai/translate`,
      },
    },
  }, null, 2));

  fs.mkdirSync(dataDir, { recursive: true });
  dbg('seeding creds');
  const credStore = await createCredentialStore({ dataDir }).init();
  const providerSettings = createProviderSettings({ dataDir });
  if (translateEnv) credStore.set('uapipro', 'stub-key');
  if (llmEnv) {
    credStore.set('llm', 'stub-llm-key');
    providerSettings.updateLlm({ preset: 'custom', baseUrl: `http://127.0.0.1:${ctx.llmPort}/v1`, model: 'stub-model' });
  }
  dbg('spawning exe');

  const child = spawn(RUST_BIN, ['--serve', '--config', configPath, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Rust 服务启动超时。stderr:\n${stderr}`)), 20000);
    child.stdout.on('data', (chunk) => {
      const m = /LISTENING 127\.0\.0\.1:(\d+)/.exec(String(chunk));
      if (m) {
        clearTimeout(timer);
        dbg('listening', m[1]);
        resolve(parseInt(m[1], 10));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Rust 服务提前退出(code ${code})。stderr:\n${stderr}`));
    });
  });
  dbg('ready on', port);
  // close(cb):必须以回调形式通知完成(测试的 closeServer 包装用的是 node http 风格)
  const server = {
    close: (cb) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; if (cb) cb(); } };
      child.on('exit', done);
      child.kill();
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } done(); }, 3000);
    },
  };
  return { server, port, base: `http://127.0.0.1:${port}` };
}

/** provider 是否就绪(HTTP 查询,双实现通用) */
async function providerConfigured(base, kind) {
  const st = await get(base, '/api/settings');
  return Boolean(st.body[kind]?.configured);
}

/** 关服:先掐 keep-alive 连接,close() 才不会被闲置连接卡住 */
function closeServer(server) {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function get(base, p) {
  const res = await fetch(base + p);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

async function post(base, p, payload) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function waitFor(fn, timeoutMs = 30000, everyMs = 100) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function runAnalysis(base) {
  await post(base, '/api/analyze');
  await waitFor(async () => {
    const st = await get(base, '/api/status');
    return !st.body.running && st.body.phase?.phase === 'done';
  });
}

async function waitForIdle(base) {
  await waitFor(async () => {
    const st = await get(base, '/api/status');
    return !st.body.running && st.body.phase?.phase === 'done';
  });
}

function skillsByDir(data, dir) {
  return data.skills.filter((s) => s.dirName === dir);
}

/* ---------- 生命周期 ---------- */

test.before(async () => {
  const fx = buildFixtures(FIXTURES);
  ctx.fixtures = fx;
  ctx.uapi = createFakeUApiPro();
  ctx.llm = createFakeLlm();
  ctx.uapiPort = await ctx.uapi.listen();
  ctx.llmPort = await ctx.llm.listen();

  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    port: 0,
    roots: fx.roots,
    lockFiles: [fx.lock],
    dataDir: DATA,
    seedsFile: path.join(FIXTURES, 'seeds.json'),
    providers: {
      translate: {
        endpoint: `http://127.0.0.1:${ctx.uapiPort}/api/v1/ai/translate`,
      },
    },
  }, null, 2));

  const app = await startApp();
  Object.assign(ctx, app);
});

test.after(async () => {
  if (ctx.server) await closeServer(ctx.server);
  await closeServer(ctx.uapi.server);
  await closeServer(ctx.llm.server);
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ---------- 01 骨架与平铺列表 ---------- */

test('01 首次分析:frontmatter 解析、平铺列表、缓存索引', async () => {
  const before = await get(ctx.base, '/api/skills');
  assert.equal(before.status, 503, '首次分析前应返回 no_index');
  assert.equal(before.body.error.code, 'no_index');

  await runAnalysis(ctx.base);

  const { body: data } = await get(ctx.base, '/api/skills');
  assert.equal(data.stats.entities, 7, `实体数应为 7(去重后),实际 ${data.stats.entities}`);

  const alphas = skillsByDir(data, 'alpha');
  assert.equal(alphas.length, 1, 'junction/拷贝合并后 alpha 只有一条');
  assert.equal(alphas[0].name, 'alpha');
  assert.match(alphas[0].description, /Alpha skill for testing/);

  const detail = await get(ctx.base, `/api/skills/${alphas[0].id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.docs.some((d) => d.rel === 'SKILL.md'));
  assert.ok(detail.body.docs.some((d) => d.rel === 'reference-long.md'));

  const ignoredNames = data.ignored.map((i) => i.name);
  assert.ok(ignoredNames.includes('no-skill'), '缺 SKILL.md 的文件夹应记入 ignored');
  assert.ok(ignoredNames.includes('nested'), '嵌套子目录不视为技能');

  assert.ok(fs.existsSync(path.join(DATA, 'index.json')), '分析结果持久化为 JSON');
});

test('01 二次启动直接读缓存,不重新扫描也能显示', async () => {
  const app2 = await startApp({ dataDir: path.join(TMP, 'data-cacheboot') });
  const dbg = (...a) => { if (process.env.SV_TEST_DEBUG) console.error('[t0102]', ...a); };
  dbg('app2 ready');
  // 直接把主 dataDir 的 index 拷过去,模拟"已有缓存的新进程"
  fs.copyFileSync(path.join(DATA, 'index.json'), path.join(TMP, 'data-cacheboot', 'index.json'));
  dbg('index copied');
  const res = await get(app2.base, '/api/skills');
  dbg('got skills', res.status);
  assert.equal(res.status, 200);
  assert.equal(res.body.stats.entities, 7);
  await closeServer(app2.server);
  dbg('closed');
});

/* ---------- 02 多根与去重 ---------- */

test('02 多根扫描:junction/symlink 去重、链接徽章、拷贝合并、版本分岔', async () => {
  const { body: data } = await get(ctx.base, '/api/skills');
  const alpha = skillsByDir(data, 'alpha')[0];
  const labels = alpha.roots.map((r) => r.label);
  assert.deepEqual([...new Set(labels)].sort(), ['agents', 'claudeA', 'zcodeA'], 'alpha 应出现在三个根');
  assert.ok(alpha.roots.find((r) => r.label === 'agents' && !r.linked), 'agents 为实体根');
  assert.ok(alpha.roots.find((r) => r.label === 'zcodeA' && r.linked), 'zcodeA 为链接');
  assert.ok(alpha.copyCount >= 2, '内容一致的 alpha-copy 独立拷贝应合并');

  const betas = skillsByDir(data, 'beta');
  assert.equal(betas.length, 2, '同名但内容分岔的 beta 应有两个版本');
  assert.ok(betas.every((b) => b.forked), '两个 beta 均标 forked');
  assert.ok(betas.some((b) => b.versionLabel === 'agents') && betas.some((b) => b.versionLabel === 'claudeA'));

  assert.ok(data.stats.linkedMerged >= 2, '链接去重计数');
});

/* ---------- 03 lock 主表归属 ---------- */

test('03 lock 主表:仓库→子技能两级结构、仓库内分组、未归属不降级', async () => {
  const { body: data } = await get(ctx.base, '/api/skills');
  const mono = data.groups.find((g) => g.repo === 'example/mono');
  assert.ok(mono, 'example/mono 组存在');
  assert.equal(mono.sourceUrl, 'https://github.com/example/mono.git');
  const sub = mono.subgroups.find((s) => s.name === 'sub');
  assert.ok(sub, 'lock 的仓库内路径分组(sub)进入结构');
  assert.ok(sub.skills.some((s) => s.dirName === 'alpha'));
  assert.equal(sub.skills[0].attribution.method, 'lock');
  assert.equal(sub.skills[0].attribution.repo, 'example/mono');

  const cn = data.groups.find((g) => g.repo === 'example/cn');
  assert.ok(cn?.subgroups.some((s) => s.skills.some((x) => x.dirName === 'chinese-one')));

  const unknown = data.groups.find((g) => g.key === '__unknown__');
  assert.ok(unknown, '未归属技能进入未知来源组');
  const unknownDirs = unknown.subgroups.flatMap((s) => s.skills.map((x) => x.dirName));
  assert.ok(unknownDirs.includes('lonely'), 'lonely 在未知来源');
  assert.ok(unknownDirs.includes('beta'), 'beta 分岔副本(claudeA,无 .git)在未知来源');
});

test('03z 扩展点:注册新清单格式识别器不改核心(结构性检查)', { skip: IMPL === 'rust' ? '白盒结构测试,仅适用于 Node 实现' : false }, () => {
  const engine = createEngine({});
  engine.registerManifestReader(lockReader);
  engine.registerManifestReader({
    name: 'custom-lock',
    canRead: (raw) => raw && raw.format === 'custom',
    parse: (raw) => ({ [raw.skill]: { repo: raw.origin } }),
  });

  const customFile = path.join(TMP, 'custom-lock.json');
  fs.writeFileSync(customFile, JSON.stringify({ format: 'custom', skill: 'kappa', origin: 'custom/mono' }));
  const m = engine.readManifest(customFile);
  assert.equal(m.format, 'custom-lock');
  assert.equal(m.entries.kappa.repo, 'custom/mono');

  const lockFile = path.join(FIXTURES, 'lock.json');
  assert.equal(engine.readManifest(lockFile).format, 'skill-lock-v3');
});

/* ---------- 04 归属瀑布补充链 ---------- */

test('04 瀑布优先级:lock > .git > frontmatter URL,创作上游标注', async () => {
  const { body: data } = await get(ctx.base, '/api/skills');
  const alpha = skillsByDir(data, 'alpha')[0];
  assert.equal(alpha.attribution.method, 'lock', '有 lock 条目时优先 lock(alpha 的 .git 是诱饵)');

  const betaAgents = skillsByDir(data, 'beta').find((b) => b.versionLabel === 'agents');
  assert.equal(betaAgents.attribution.method, 'git');
  assert.equal(betaAgents.attribution.repo, 'hand/hand-repo');
  assert.equal(betaAgents.attribution.sourceUrl, 'https://github.com/hand/hand-repo.git');

  const gamma = skillsByDir(data, 'gamma')[0];
  assert.equal(gamma.attribution.method, 'frontmatter-url');
  assert.equal(gamma.attribution.repo, 'up/upstream-repo');
  assert.equal(gamma.attribution.upstream.repo, 'up/upstream-repo', 'frontmatter URL 同时作为创作上游标注');
});

/* ---------- 05 种子概述与分类 ---------- */

test('05 种子概述:两仓库生效、分类独立、无种子降级', async () => {
  const { body: data } = await get(ctx.base, '/api/skills');
  const alpha = skillsByDir(data, 'alpha')[0];
  assert.equal(alpha.summarySource, 'seed');
  assert.equal(alpha.summary, '种子概述:alpha 是测试技能。');
  assert.deepEqual(alpha.categories, ['种子分类A', '设计'], '分类标签独立于仓库归组');
  assert.deepEqual(alpha.categoriesL1, ['other', 'design'], '一级分类按索引与细分标签对应');

  const cnOne = skillsByDir(data, 'chinese-one')[0];
  assert.equal(cnOne.summarySource, 'seed');

  const mono = data.groups.find((g) => g.repo === 'example/mono');
  assert.match(mono.repoSummary, /示例单仓库/);

  const cats = await get(ctx.base, '/api/categories');
  // chips 为固定一级分类:细分「设计」→ design,「种子分类A」不在体系内 → other
  const L1 = ['dev', 'writing', 'learning', 'design', 'data', 'life', 'other'];
  assert.ok(cats.body.categories.every((c) => L1.includes(c.name)), 'chips 只出现固定一级分类');
  assert.ok(cats.body.categories.some((c) => c.name === 'design' && c.count === 1));
  assert.equal(cats.body.categories[cats.body.categories.length - 1].name, 'other', '「其他」恒居末位');
});

/* ---------- 06 搜索维度(过滤为纯前端,API 提供全部维度) ---------- */

test('06 搜索字段齐全:名称/描述/概述/分类/仓库均可检索', async () => {
  const { body: data } = await get(ctx.base, '/api/skills');
  const alpha = skillsByDir(data, 'alpha')[0];
  for (const field of ['name', 'dirName', 'description', 'summary', 'categories']) {
    assert.ok(field in alpha, `卡片应携带 ${field} 供前端过滤`);
  }
  assert.ok(data.groups.every((g) => typeof g.repo === 'string' || g.key === '__unknown__'));
});

/* ---------- 07 文档查看器·原文 ---------- */

test('07 文档端点:块解析、图片、中文判定、路径安全', async () => {
  const alpha = skillsByDir((await get(ctx.base, '/api/skills')).body, 'alpha')[0];
  const doc = await get(ctx.base, `/api/skills/${alpha.id}/doc?path=SKILL.md`);
  assert.equal(doc.status, 200);
  assert.equal(doc.body.language, 'en');
  const types = doc.body.blocks.map((b) => b.type);
  for (const t of ['heading', 'paragraph', 'list', 'code', 'table']) {
    assert.ok(types.includes(t), `块类型应包含 ${t}`);
  }
  assert.ok(doc.body.blocks.find((b) => b.type === 'code').markdown.includes('code block never translated'));

  const zh = skillsByDir((await get(ctx.base, '/api/skills')).body, 'chinese-one')[0];
  const zhDoc = await get(ctx.base, `/api/skills/${zh.id}/doc?path=SKILL.md`);
  assert.equal(zhDoc.body.language, 'zh', '中文文档应判定为 zh(单栏直出)');

  const img = await get(ctx.base, `/api/skills/${alpha.id}/file?path=assets/pic.png`);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/png/);

  const evil = await get(ctx.base, `/api/skills/${alpha.id}/file?path=../lock.json`);
  assert.notEqual(evil.status, 200, '路径穿越应被拒绝');

  const missing = await get(ctx.base, `/api/skills/${alpha.id}/doc?path=nope.md`);
  assert.equal(missing.status, 404);
});

/* ---------- 08 翻译管线与对照 ---------- */

test('08 隐私门:未同意前翻译被拒(409),同意后放行', async () => {
  const alpha = skillsByDir((await get(ctx.base, '/api/skills')).body, 'alpha')[0];
  const denied = await post(ctx.base, `/api/skills/${alpha.id}/translate`, { path: 'SKILL.md' });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, 'consent_required');

  await post(ctx.base, '/api/consent', { accept: true });
  await waitFor(async () => {
    const st = await get(ctx.base, '/api/status');
    return !st.body.running;
  });

  const ok = await post(ctx.base, `/api/skills/${alpha.id}/translate`, { path: 'SKILL.md' });
  assert.equal(ok.status, 200);
});

test('08 块级对照:块 ID 对齐、代码块不译、占位符保护、单次上限', async () => {
  const data = (await get(ctx.base, '/api/skills')).body;
  const alpha = skillsByDir(data, 'alpha')[0];
  const doc = (await get(ctx.base, `/api/skills/${alpha.id}/doc?path=SKILL.md`)).body;
  const t = (await post(ctx.base, `/api/skills/${alpha.id}/translate`, { path: 'SKILL.md' })).body;

  const tmap = new Map(t.blocks.map((b) => [b.id, b]));
  for (const b of doc.blocks) {
    const tb = tmap.get(b.id);
    assert.ok(tb, `原文块 ${b.id} 应有对应译文块`);
    if (b.type === 'code') {
      assert.equal(tb.status, 'original');
      assert.equal(tb.translated, '', '代码块不被翻译');
    }
  }

  const stub = ctx.uapi.stats();
  assert.ok(!stub.overLimit, `单次调用不得超 1 万字符(max=${stub.maxLen})`);

  // 占位符保护:行内代码/URL/路径/环境变量原样保留,敏感词改写不波及
  const para = t.blocks.find((b) => b.src.includes('npm install skill-x'));
  assert.ok(para, '包含行内代码的块应存在');
  assert.match(para.translated, /npm install skill-x/, '行内代码保留原文');
  assert.ok(!para.translated.includes('技能X'), '占位符内的代码不被 stub 改写');
  assert.match(para.translated, /https:\/\/example\.com\/docs/, 'URL 保留');
  assert.match(para.translated, /~\/\.agents\/skills\/alpha/, '路径保留');
  assert.match(para.translated, /\$HOME_DIR/, '环境变量保留');

  const st = (await get(ctx.base, '/api/status')).body;
  assert.ok(st.state.creditsUsed > 0, '积分消耗对用户可见');
  assert.equal(st.state.creditsUsed % 4, 0, '每次调用 4 积分');
});

test('08 长文分块 + 并发限流 + 渐进部分结果', async () => {
  const alpha = skillsByDir((await get(ctx.base, '/api/skills')).body, 'alpha')[0];
  // 懒翻译证明:分析/预翻译阶段从未碰过附属长文档
  assert.ok(!ctx.uapi.stats().hasText('Paragraph 0:'), '附属长文档不应在分析阶段被翻译(懒翻译)');
  // 模拟真实翻译耗时,让并发与渐进可观察;结束后复原
  await post(`http://127.0.0.1:${ctx.uapiPort}`, '/__mode', { delay: 300 });
  const before = ctx.uapi.stats().calls;
  const t0 = Date.now();
  // 不 await:并发轮询 GET /translate 捕获渐进部分结果(逐包落盘)。
  // 首包完成前 blocks 为 null,循环等到"有已完成块"的中间态再断言。
  const pending = post(ctx.base, `/api/skills/${alpha.id}/translate`, { path: 'reference-long.md' });
  let part = null;
  for (let i = 0; i < 40 && !(part && part.blocks && part.done > 0 && part.partial); i++) {
    await new Promise((r) => setTimeout(r, 120));
    part = (await get(ctx.base, `/api/skills/${alpha.id}/translate?path=reference-long.md`)).body;
  }
  const t = await pending;
  const elapsed = Date.now() - t0;
  await post(`http://127.0.0.1:${ctx.uapiPort}`, '/__mode', { delay: 0 });
  assert.equal(t.status, 200);
  assert.ok(part, '翻译进行中 GET /translate 应返回部分结果');
  assert.equal(part.started, true, '进行中标记 started');
  assert.equal(part.partial, true, '存在未完成块时 partial');
  assert.ok(part.total > 0 && part.done > 0 && part.done < part.total, `渐进块进度合法:${part.done}/${part.total}`);
  assert.ok(part.blocks.some((b) => b.status === 'ok') && part.blocks.some((b) => b.status === 'pending'), '部分块已完成,其余仍在翻译');
  const fin = (await get(ctx.base, `/api/skills/${alpha.id}/translate?path=reference-long.md`)).body;
  assert.equal(fin.started, false, '结束后 started 复位');
  assert.equal(fin.partial, false, '结束后无 pending 块');
  const newCalls = ctx.uapi.stats().calls - before;
  const maxConc = ctx.uapi.stats().maxConcurrent;
  assert.ok(newCalls >= 3, `4 万字符长文应分多次调用,实际 ${newCalls}`);
  assert.ok(maxConc >= 2 && maxConc <= 6, `并发在 2..6 之间,实际峰值 ${maxConc}`);
  assert.ok(
    t.body.blocks.filter((b) => b.status === 'ok').length >= 80,
    '长文所有语义块均有译文且不撕裂',
  );
  assert.ok(elapsed >= (newCalls - 1) * 250 * 0.8, `发射间隔节流生效:${newCalls} 次调用耗时 ${elapsed}ms`);
});

/* ---------- 09 懒翻译与增量缓存 ---------- */

test('09 大包失败二分分包:不逐块降级,告警落盘', async () => {
  const alpha = skillsByDir((await get(ctx.base, '/api/skills')).body, 'alpha')[0];
  const detail = (await get(ctx.base, `/api/skills/${alpha.id}`)).body;
  const raw = fs.readFileSync(path.join(detail.realPath, 'reference-long.md'), 'utf8');
  const cacheFile = path.join(DATA, 'translations', alpha.id, 'zh', `${sha1(raw)}.json`);
  fs.rmSync(cacheFile, { force: true }); // 删缓存重翻,触发大包路径

  // >2000 字符的调用必失败(模拟 524:打包目标 3000,部分包超 2000 失败 → 二分成 <2000 小包成功)
  await post(`http://127.0.0.1:${ctx.uapiPort}`, '/__mode', { failOverChars: 2000 });
  const r = await post(ctx.base, `/api/skills/${alpha.id}/translate`, { path: 'reference-long.md' });
  await post(`http://127.0.0.1:${ctx.uapiPort}`, '/__mode', { failOverChars: 0 });
  assert.equal(r.status, 200);
  const blocks = r.body.blocks.filter((b) => b.status !== 'original');
  assert.ok(blocks.every((b) => b.status === 'ok'), '二分分包后全部块成功');
  // 逐块降级 = 块数(≈85)次调用;二分后调用数应显著低于块数(部分小包一轮成功,超限包二分)
  assert.ok(r.body.calls < blocks.length * 0.75, `二分分包调用 ${r.body.calls} 应显著低于块数 ${blocks.length}`);
  assert.ok(Array.isArray(r.body.warnings) && r.body.warnings.length >= 1, '打包失败告警随缓存落盘');
  assert.match(r.body.warnings[0], /打包翻译失败/, '告警含失败原因');
});

test('09 附属文档缓存秒开 + 内容未变零调用', async () => {
  const alpha = skillsByDir((await get(ctx.base, '/api/skills')).body, 'alpha')[0];
  const afterFirst = ctx.uapi.stats().calls;

  const second = await post(ctx.base, `/api/skills/${alpha.id}/translate`, { path: 'reference-long.md' });
  assert.equal(second.status, 200);
  assert.equal(second.body.cached, true, '第二次读取走缓存');
  assert.equal(ctx.uapi.stats().calls, afterFirst, '缓存命中不产生新调用');

  // 内容未变的手动更新:零 API 调用。
  // 先跑一轮把 consent 后未预翻的入口补齐入缓存,再断言下一轮零调用。
  await runAnalysis(ctx.base);
  const beforeAnalyze = ctx.uapi.stats().calls;
  const llmBefore = ctx.llm.stats().calls;
  await runAnalysis(ctx.base);
  assert.equal(ctx.uapi.stats().calls, beforeAnalyze, '内容未变,重新分析零翻译调用');
  assert.equal(ctx.llm.stats().calls, llmBefore, '内容未变,概述与推断走缓存零 LLM 调用');
});

test('09 内容变更后自动重翻入口文档', async () => {
  const alpha = skillsByDir((await get(ctx.base, '/api/skills')).body, 'alpha')[0];
  const append = '\nBrand new paragraph after content change.\n';
  // alpha 与 alpha-copy(内容一致的拷贝)同步追加,保持"合并"不变式不被测试突变破坏
  fs.appendFileSync(path.join(FIXTURES, 'roots', 'agents', 'skills', 'alpha', 'SKILL.md'), append);
  fs.appendFileSync(path.join(FIXTURES, 'roots', 'claudeA', 'skills', 'alpha-copy', 'SKILL.md'), append);

  const before = ctx.uapi.stats().calls;
  await runAnalysis(ctx.base);
  const delta = ctx.uapi.stats().calls - before;
  assert.ok(delta >= 1, `alpha 内容变化应触发入口重翻,实际新增 ${delta} 次调用`);
  assert.ok(ctx.uapi.stats().hasText('Brand new paragraph after content change'), '重译的是新内容');
  const recount = (await get(ctx.base, '/api/skills')).body.stats.entities;
  assert.equal(recount, 7, '同步变更拷贝后实体数不变');
});

test('09 部分缓存续翻:中断的翻译只补剩余块,已完成块零调用', async () => {
  const beta = skillsByDir((await get(ctx.base, '/api/skills')).body, 'beta')[0];
  const detail = (await get(ctx.base, `/api/skills/${beta.id}`)).body;
  // beta 的 SKILL.md 已被预翻译(zh 缓存就绪);把一半块重置为 pending 模拟中断
  const raw = fs.readFileSync(path.join(detail.realPath, 'SKILL.md'), 'utf8');
  const cacheFile = path.join(DATA, 'translations', beta.id, 'zh', `${sha1(raw)}.json`);
  assert.ok(fs.existsSync(cacheFile), '预翻译缓存应存在');
  const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const translatable = entry.blocks.filter((b) => b.status !== 'original');
  const resetN = Math.ceil(translatable.length / 2);
  for (const b of translatable.slice(0, resetN)) {
    b.status = 'pending';
    b.translated = '';
  }
  fs.writeFileSync(cacheFile, JSON.stringify(entry));

  const before = ctx.uapi.stats().calls;
  const r = await post(ctx.base, `/api/skills/${beta.id}/translate`, { path: 'SKILL.md' });
  assert.equal(r.status, 200);
  assert.equal(r.body.resumed, resetN, '续翻只补 pending 块');
  assert.ok(r.body.blocks.every((b) => b.status !== 'pending'), '续翻后无 pending 块');
  assert.ok(r.body.blocks.filter((b) => b.status === 'ok').length >= translatable.length, '全部块有译文');
  const newCalls = ctx.uapi.stats().calls - before;
  assert.ok(newCalls >= 1, `剩余块至少一次调用,实际 ${newCalls}`);
  const newChars = ctx.uapi.stats().texts.slice(-newCalls).reduce((n, t) => n + t.length, 0);
  const fullChars = translatable.reduce((n, b) => n + b.src.length, 0);
  assert.ok(newChars < fullChars * 0.75, `只翻剩余部分:${newChars} < 全文 75%(${fullChars})`);
});

/* ---------- 10 LLM provider:概述与推断 ---------- */

test('10 概述生成与归属推断(stub LLM)', async () => {
  const data = (await get(ctx.base, '/api/skills')).body;
  const delta = skillsByDir(data, 'delta')[0];
  assert.equal(delta.summarySource, 'llm');
  assert.equal(delta.summary, 'LLM 生成的中文概述');

  // 高置信度推断自动纳入仓库分组
  assert.equal(delta.attribution.inferred, true);
  assert.equal(delta.attribution.repo, 'example/mono');
  assert.equal(delta.attribution.confidence, 'high');

  // 低置信度不自动纳入:留在未知来源,但携带候选供确认
  const lonely = skillsByDir(data, 'lonely')[0];
  assert.equal(lonely.attribution.repo, null, '低置信度推断不得自动纳入仓库');
  assert.ok(lonely.pendingInference, '低置信度保留推断候选');
  assert.equal(lonely.pendingInference.repo, 'hand/hand-repo');
  assert.equal(lonely.pendingInference.confidence, 'low');

  // 无候选技能不带字段
  const fork = skillsByDir(data, 'beta').find((b) => b.versionLabel === 'claudeA');
  assert.equal(fork.pendingInference, null);

  // 待确认推断读数与卡片同口径:已应用未确认(delta)∪ 未应用候选(lonely);
  // beta 分岔的负结果推断(LLM 判不出仓库,缓存 null)无可确认项,不计入
  assert.equal(data.stats.inferred, 2, 'stats.inferred = 已应用未确认 + 未应用候选');

  // 任务面板:/api/status 携带逐阶段清单(手动更新后全部 done/skipped)
  const st = (await get(ctx.base, '/api/status')).body;
  const stages = st.phase.stages || [];
  assert.equal(stages.length, 6, '阶段清单固定 6 项');
  assert.ok(stages.every((s) => ['done', 'skipped'].includes(s.status)), '完成后各阶段为 done/skipped');
  assert.ok(stages.some((s) => s.id === 'pretranslate' && s.status === 'done'), '手动触发包含预翻译');
  assert.ok(stages.some((s) => s.id === 'translateMeta' && s.status === 'skipped'), '中文界面跳过概述翻译');
});

test('10 未配置 LLM 时优雅降级,不报错不阻塞', async () => {
  const llmBefore = ctx.llm.stats().calls;
  const app2 = await startApp({ dataDir: path.join(TMP, 'data-degraded'), llmEnv: false });
  await runAnalysis(app2.base);
  const data = (await get(app2.base, '/api/skills')).body;
  const delta = skillsByDir(data, 'delta')[0];
  assert.equal(delta.summarySource, 'fallback', '降级为 frontmatter 描述');
  assert.equal(delta.summary, delta.description);
  assert.equal(delta.attribution.repo, null, '未配置 LLM 时不推断');
  assert.equal(ctx.llm.stats().calls, llmBefore, '没有 LLM 调用发生');
  // 无 LLM 时新技能没有分类来源:卡片一级分类兜底 other,至少能在「其他」chip 里被发现
  assert.ok(data.skills.every((s) => (s.categoriesL1 || []).length > 0), '无标签卡兜底 other');
  assert.equal(data.stats.entities, 7, '功能不受影响');
  await closeServer(app2.server);
});

/* ---------- 11 手动归组与推断确认 ---------- */

test('11 overrides:手动归组最高优先级且重分析不丢,推断可确认', async () => {
  const data0 = (await get(ctx.base, '/api/skills')).body;
  const lonely = skillsByDir(data0, 'lonely')[0];

  // 确认低置信度候选:从未知来源转入对应仓库
  const confirm = await post(ctx.base, '/api/confirm-inference', { skillIds: [lonely.id] });
  assert.equal(confirm.status, 200);
  const data1 = (await get(ctx.base, '/api/skills')).body;
  const lonely1 = skillsByDir(data1, 'lonely')[0];
  assert.equal(lonely1.attribution.confirmed, true, '确认后不再显示待确认状态');
  assert.equal(lonely1.attribution.repo, 'hand/hand-repo');
  assert.equal(lonely1.pendingInference, null, '已确认的候选不再挂起');

  await runAnalysis(ctx.base);
  const data2 = (await get(ctx.base, '/api/skills')).body;
  assert.equal(skillsByDir(data2, 'lonely')[0].attribution.confirmed, true, '确认结果持久');

  // 手动归组优先级最高,可覆盖确认结果
  const assign = await post(ctx.base, '/api/overrides', { skillIds: [lonely.id], repo: 'custom/manual-repo' });
  assert.equal(assign.status, 200);
  const data3 = (await get(ctx.base, '/api/skills')).body;
  const lonely3 = skillsByDir(data3, 'lonely')[0];
  assert.equal(lonely3.attribution.method, 'overrides');
  assert.equal(lonely3.attribution.repo, 'custom/manual-repo');
  assert.equal(lonely3.attribution.manual, true);

  // 重新分析后手动归组保留
  await runAnalysis(ctx.base);
  const data4 = (await get(ctx.base, '/api/skills')).body;
  assert.equal(skillsByDir(data4, 'lonely')[0].attribution.method, 'overrides');
});

/* ---------- 12 失败重试与状态回看 ---------- */

test('12 翻译失败的块:错误可见、可重试、成功后缓存补齐', async () => {
  const gamma = skillsByDir((await get(ctx.base, '/api/skills')).body, 'gamma')[0];
  const t = await post(ctx.base, `/api/skills/${gamma.id}/translate`, { path: 'SKILL.md' });
  assert.equal(t.status, 200);
  const failed = t.body.blocks.filter((b) => b.status === 'failed');
  assert.ok(failed.length >= 1, '含 FAIL_TOKEN 的块应失败且不静默');
  assert.ok(failed.every((b) => b.error), '失败块带错误信息');

  // stub 关闭 FAIL_TOKEN 失败模式后重试成功
  await fetch(`http://127.0.0.1:${ctx.uapiPort}/__mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ failToken: false }),
  });
  const retry = await post(ctx.base, `/api/skills/${gamma.id}/retry`, { path: 'SKILL.md' });
  assert.equal(retry.status, 200);
  assert.ok(retry.body.retried >= 1, '重试了失败块');
  assert.ok(retry.body.blocks.every((b) => b.status !== 'failed'), '重试后全部成功');

  const again = await post(ctx.base, `/api/skills/${gamma.id}/translate`, { path: 'SKILL.md' });
  assert.ok(again.body.blocks.every((b) => b.status !== 'failed'), '缓存已补齐');
});

test('12 状态可回看:隐私提示、积分、进度、provider 配置', async () => {
  const st = (await get(ctx.base, '/api/status')).body;
  assert.equal(st.state.consentTranslate, true);
  assert.ok(st.state.creditsUsed > 0);
  assert.ok(st.state.lastAnalysis, '上次分析信息可回看');
  assert.equal(st.config.providers.translate.configured, true);
  assert.ok(st.phase, '进度结构存在');
  assert.ok(['done'].includes(st.phase.phase) || !st.running);
});

/* ---------- 13 静态 UI 冒烟 ---------- */

test('13 UI 冒烟:首页可渲染', async () => {
  const home = await get(ctx.base, '/');
  assert.equal(home.status, 200);
  assert.match(String(home.body), /app\.js/);
  const js = await get(ctx.base, '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const locales = await get(ctx.base, '/locales.json');
  assert.equal(locales.status, 200);
  assert.ok(locales.body.zh && locales.body.en, '语言包由服务端静态下发');
  const spa = await get(ctx.base, '/whatever');
  assert.equal(spa.status, 200, '未知路径 SPA 兜底回首页');
});

/* ---------- 14 设置:加密存储、掩码回显、无明文落盘 ---------- */

test('14 设置 API:密钥加密落盘、掩码回显、data 目录无明文', async () => {
  const save = await post(ctx.base, '/api/settings/providers', {
    translate: { apiKey: 'store-uapis-key-1234567890' },
    llm: { preset: 'custom', baseUrl: `http://127.0.0.1:${ctx.llmPort}/v1`, model: 'stub-model', apiKey: 'store-llm-key-abcdef0987' },
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.ok, true);

  const st = (await get(ctx.base, '/api/settings')).body;
  assert.ok(st.translate.maskedKey.includes('***'), 'key 只回掩码');
  assert.ok(st.llm.maskedKey.includes('***'));
  assert.equal(st.llm.preset, 'custom');
  assert.equal(st.llm.baseUrl, `http://127.0.0.1:${ctx.llmPort}/v1`);
  assert.ok(st.presets.length >= 3, '预设列表下发(DeepSeek/GLM/custom)');
  assert.ok(['dpapi', 'keychain', 'secret-tool', 'machine'].includes(st.credentialStoreKind));

  const whole = JSON.stringify(st);
  assert.ok(!whole.includes('store-uapis-key-1234567890'), '完整 key 不得出现在响应');
  assert.ok(!whole.includes('store-llm-key-abcdef0987'));

  // 落盘检查:data 下所有文件都不得含明文 key
  const files = fs.readdirSync(DATA, { recursive: true });
  let leaked = [];
  for (const f of files) {
    const full = path.join(DATA, String(f));
    if (!fs.statSync(full).isFile()) continue;
    const content = fs.readFileSync(full, 'utf8');
    if (content.includes('store-uapis-key-1234567890') || content.includes('store-llm-key-abcdef0987')) leaked.push(String(f));
  }
  assert.deepEqual(leaked, [], `以下文件出现明文 key: ${leaked.join(', ')}`);
});

test('14 设置:清除已存密钥(直接观察加密存储)', async () => {
  // 主实例 env 密钥优先级更高,观察不到 store;开一个无 env 的实例读同一 dataDir
  const app3 = await startApp({ dataDir: DATA, llmEnv: false, translateEnv: false });
  try {
    await post(app3.base, '/api/settings/providers', { translate: { apiKey: 'to-be-cleared-123456' } });
    let st = (await get(app3.base, '/api/settings')).body;
    assert.equal(st.translate.source, 'store');
    assert.match(st.translate.maskedKey, /\*\*\*/);

    const clear = await post(app3.base, '/api/settings/providers', { translate: { apiKey: null } });
    assert.equal(clear.status, 200);
    st = (await get(app3.base, '/api/settings')).body;
    assert.notEqual(st.translate.source, 'store', '清除后不再有存储密钥');
    assert.equal(st.translate.maskedKey, null, '无 env 且无 store → 掩码为空');
  } finally {
    await closeServer(app3.server);
  
  }
});

/* ---------- 15 连通测试(stub) ---------- */

test('15 连通测试:LLM models 探测、翻译免费探针与完整测试', async () => {
  // LLM:上一测试已把 stub 地址与存储密钥写入设置,空参 = 用已存配置
  const ok = await post(ctx.base, '/api/settings/test/llm', {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.ok(Array.isArray(ok.body.models), '返回模型列表');
  assert.ok(ok.body.models.every((m) => typeof m === 'string' && m), '模型统一只用 id 字符串');
  assert.ok(ok.body.models.includes('stub-model'));
  assert.ok(ok.body.latencyMs >= 0);
  // 测试通过 → 拉到的模型列表按服务商(preset|baseUrl)落盘缓存
  const providerKey = `custom|http://127.0.0.1:${ctx.llmPort}/v1`;
  const stAfter = (await get(ctx.base, '/api/settings')).body;
  assert.deepEqual(stAfter.llm.modelsCache[providerKey], ok.body.models, '测试成功后模型列表按服务商缓存');
  // 模拟重启:新实例读同一 dataDir,缓存仍在(候选不再回落到预设旧列表)
  const rebooted = await startApp({ dataDir: DATA, llmEnv: false, translateEnv: false });
  try {
    const stReboot = (await get(rebooted.base, '/api/settings')).body;
    assert.deepEqual(stReboot.llm.modelsCache[providerKey], ok.body.models, '重启后模型缓存仍在');
  } finally {
    await closeServer(rebooted.server);
  }

  const bad = await post(ctx.base, '/api/settings/test/llm', { apiKey: 'wrong-key' });
  assert.equal(bad.body.ok, false, '坏 key 应失败');
  assert.match(bad.body.error, /鉴权失败/);
  assert.deepEqual(
    (await get(ctx.base, '/api/settings')).body.llm.modelsCache[providerKey],
    ok.body.models,
    '失败的测试不写缓存');

  // 翻译免费探针:可达 + keyAccepted(env 的 stub-key 仍生效)
  const probe = await post(ctx.base, '/api/settings/test/translate', {});
  assert.equal(probe.body.reachable, true);
  assert.equal(probe.body.keyAccepted, true, 'stub:有 Bearer + 空 text → 400 = 鉴权通过');

  const invalid = await post(ctx.base, '/api/settings/test/translate', { apiKey: 'nope' });
  assert.equal(invalid.body.keyAccepted, false, '坏 key → 401');

  // 完整测试:真实调用 +1 次
  const callsBefore = ctx.uapi.stats().calls;
  const full = await post(ctx.base, '/api/settings/test/translate', { full: true });
  assert.equal(full.body.full.ok, true);
  assert.match(full.body.full.sample, /【译】hi/);
  assert.equal(ctx.uapi.stats().calls, callsBefore + 1, '完整测试只发起一次计费调用');
});

/* ---------- 16 跨源防护 ---------- */

test('16 跨源防护:伪造 Origin 的状态变更被拒,同源放行', async () => {
  const evil = await fetch(ctx.base + '/api/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: '{"accept":true}',
  });
  assert.equal(evil.status, 403);
  assert.equal((await evil.json()).error.code, 'forbidden_origin');

  const evilSettings = await fetch(ctx.base + '/api/settings/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.test' },
    body: '{"translate":{"apiKey":"evil-injected"}}',
  });
  assert.equal(evilSettings.status, 403);

  const sameOrigin = await fetch(ctx.base + '/api/analyze', {
    method: 'POST',
    headers: { Origin: ctx.base },
  });
  assert.equal(sameOrigin.status, 200, '同源(页面自身)POST 放行');
});

/* ---------- 20 清除上次警告 ---------- */

test('20 清除警告端点:幂等且只清 errors 不动其他状态', async () => {
  // 先确认契约:调用成功、响应结构正确
  const r = await post(ctx.base, '/api/clear-warnings');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const st = (await get(ctx.base, '/api/status')).body;
  assert.deepEqual(st.state.lastAnalysis.errors, [], '警告已清空');
  assert.ok(st.state.lastAnalysis.entities > 0, 'lastAnalysis 其他字段保留');
  assert.equal(st.state.consentTranslate, true, '同意状态不受影响');
});

/* ---------- 18 并发翻译去重 + 贴满字符打包 ---------- */

test('18 同一文档并发翻译只翻一份(in-flight 去重),打包贴满单次上限', async () => {
  const app4 = await startApp({ dataDir: path.join(TMP, 'data-inflight') });
  try {
    await post(app4.base, '/api/consent', { accept: true });
    await waitFor(async () => {
      const st = await get(app4.base, '/api/status');
      return !st.body.running;
    });

    const alpha = skillsByDir((await get(app4.base, '/api/skills')).body, 'alpha')[0];
    const before = ctx.uapi.stats().calls;
    const [r1, r2] = await Promise.all([
      post(app4.base, `/api/skills/${alpha.id}/translate`, { path: 'reference-long.md' }),
      post(app4.base, `/api/skills/${alpha.id}/translate`, { path: 'reference-long.md' }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const used = ctx.uapi.stats().calls - before;
    assert.equal(used, r1.body.calls, `并发两请求应共享同一份翻译(stub 调用 ${used} = 文档记录 ${r1.body.calls}),而不是翻两遍`);
    assert.ok(r1.body.calls >= 4, '4 万字符长文应分多次调用');
    assert.ok(ctx.uapi.stats().maxLen <= 10000, `单次调用不得超 1 万字符(max=${ctx.uapi.stats().maxLen})`);
    assert.ok(ctx.uapi.stats().maxLen > 2000, `打包应贴满打包目标(规避 524,max=${ctx.uapi.stats().maxLen})`);
  } finally {
    await closeServer(app4.server);
  
  }
});

/* ---------- 19 consent 触发的分析不做全量预翻 ---------- */

test('19 用户刚同意隐私时不启动全量预翻(避免与当前文档抢节流队列)', async () => {
  const app5 = await startApp({ dataDir: path.join(TMP, 'data-consent-noPre') });
  try {
    const before = ctx.uapi.stats().calls;
    await post(app5.base, '/api/consent', { accept: true });
    await waitFor(async () => {
      const st = await get(app5.base, '/api/status');
      return !st.body.running;
    });
    assert.equal(ctx.uapi.stats().calls, before, 'consent 触发的分析零翻译调用(不预翻)');

    // 手动更新时才补预翻(consent 已 true)
    await runAnalysis(app5.base);
    const afterManual = ctx.uapi.stats().calls;
    assert.ok(afterManual > before, '手动更新按同意状态执行预翻');
  } finally {
    await closeServer(app5.server);
  
  }
});

/* ---------- 21 翻译同意:撤回后不发新请求,缓存译文仍可查看 ---------- */

test('21 翻译同意:撤回后不发新请求,缓存译文仍可查看', async () => {
  const app = await startApp({ dataDir: path.join(TMP, 'data-consent-loop') });
  try {
    await post(app.base, '/api/consent', { accept: true });
    await waitFor(async () => {
      const st = await get(app.base, '/api/status');
      return !st.body.running;
    });
    const alpha = skillsByDir((await get(app.base, '/api/skills')).body, 'alpha')[0];
    const beforeCalls = ctx.uapi.stats().calls;
    const first = await post(app.base, `/api/skills/${alpha.id}/translate`, { path: 'SKILL.md' });
    assert.equal(first.status, 200, '同意后可翻译');
    assert.equal(first.body.cached, false);
    const afterCalls = ctx.uapi.stats().calls;
    assert.ok(afterCalls > beforeCalls, '首次翻译产生调用');

    const revoke = await post(app.base, '/api/consent', { accept: false });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.consentTranslate, false);
    const st = await get(app.base, '/api/status');
    assert.equal(st.body.state.consentTranslate, false, '撤回状态已持久化');

    const cachedView = await post(app.base, `/api/skills/${alpha.id}/translate`, { path: 'SKILL.md' });
    assert.equal(cachedView.status, 200, '撤回后缓存译文仍可查看');
    assert.equal(cachedView.body.cached, true);
    assert.equal(ctx.uapi.stats().calls, afterCalls, '撤回后不再发起新的翻译请求');

    await post(app.base, '/api/consent', { accept: true });
    const again = await post(app.base, `/api/skills/${alpha.id}/translate`, { path: 'SKILL.md' });
    assert.equal(again.status, 200, '重新同意后恢复');
    assert.equal(again.body.cached, true, '恢复后直接命中缓存');
    assert.equal(ctx.uapi.stats().calls, afterCalls, '缓存命中不重复调用');
  } finally {
    await closeServer(app.server);
  }
});

/* ---------- 22 配置发现:共享目录回退(网页/桌面同一 dataDir 的机制) ---------- */

test('22 配置发现:共享目录回退生效,显式配置仍最优先', () => {
  const fs = require('node:fs');
  const { loadConfig, configSearchCandidates, sharedConfigPath } = require('../lib/config');

  // 候选顺序:启动目录 → 仓库根 → 共享目录;注入不改进程状态
  const injected = configSearchCandidates({ cwd: '/tmp/x', repoDir: '/tmp/repo', appDataDir: '/tmp/ad' });
  assert.deepEqual(
    injected.map((p) => p.replace(/\\/g, '/')),
    ['/tmp/x/config.json', '/tmp/repo/config.json', sharedConfigPath('/tmp/ad').replace(/\\/g, '/')],
  );

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-cfg-'));
  // 默认数据目录:与桌面端 desktop_data_dir() 对齐(开箱即共用同一数据空间)
  const { DEFAULTS } = require('../lib/config');
  assert.ok(String(DEFAULTS.dataDir).includes('skills-lingo'), `默认 dataDir 为平台数据目录(${DEFAULTS.dataDir})`);
  assert.notEqual(DEFAULTS.dataDir, 'data');
  const fakeAppData = path.join(sandbox, 'appdata');
  const fakeCwd = path.join(sandbox, 'cwd');
  fs.mkdirSync(path.join(fakeAppData, 'skills-lingo'), { recursive: true });
  fs.mkdirSync(fakeCwd, { recursive: true });
  const shared = path.join(fakeAppData, 'skills-lingo', 'config.json');
  fs.writeFileSync(shared, JSON.stringify({ dataDir: path.join(sandbox, 'shared-data') }));

  const prevAppData = process.env.APPDATA;
  const prevCwd = process.cwd();
  process.env.APPDATA = fakeAppData;
  process.chdir(fakeCwd);
  try {
    // 无本地配置 → 回退到共享目录,dataDir 相对共享配置目录解析
    const viaShared = loadConfig(null);
    assert.equal(viaShared.configFile, shared);
    assert.equal(viaShared.dataDir, path.resolve(sandbox, 'shared-data'));

    // 启动目录有配置 → 优先于共享目录
    fs.writeFileSync(path.join(fakeCwd, 'config.json'), JSON.stringify({ dataDir: 'local-data' }));
    const viaCwd = loadConfig(null);
    assert.equal(viaCwd.configFile, path.join(fakeCwd, 'config.json'));
    assert.equal(viaCwd.dataDir, path.resolve(fakeCwd, 'local-data'));

    // 显式路径 → 压过一切
    const explicitCfg = loadConfig(shared);
    assert.equal(explicitCfg.configFile, shared);
  } finally {
    process.chdir(prevCwd);
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

/* ---------- 23 凭据损坏防护:坏文件先备份留档,存储仍可恢复使用 ---------- */

test('23 凭据损坏防护:坏 masterkey 被备份而非静默销毁,损坏后仍可恢复使用', async () => {
  const dir = path.join(TMP, 'data-credbackup');
  fs.mkdirSync(dir, { recursive: true });
  const backups = () => fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));

  // 场景 1:预置坏 .masterkey → 初始化应备份它并重建,存储照常工作
  fs.writeFileSync(path.join(dir, '.masterkey'), 'definitely-not-a-valid-masterkey!!');
  const app = await startApp({ dataDir: dir });
  try {
    assert.ok(backups().some((f) => f.startsWith('.masterkey.corrupt-')), '坏 .masterkey 已备份');
    const st = await get(app.base, '/api/settings');
    assert.ok(st.body.translate.maskedKey, '重建后存取正常(maskedKey 有值)');
    assert.ok(['dpapi', 'machine'].includes(st.body.credentialStoreKind), `凭据库类型正常(${st.body.credentialStoreKind})`);
  } finally {
    await closeServer(app.server);
  }

  // 场景 2:正常凭据落盘后,credentials.enc 被破坏 → 再次启动备份它,存储恢复可用
  fs.appendFileSync(path.join(dir, 'credentials.enc'), '},{garbage!!');
  const app2 = await startApp({ dataDir: dir });
  try {
    assert.ok(backups().some((f) => f.startsWith('credentials.enc.corrupt-')), '坏 credentials.enc 已备份');
    const st = await get(app2.base, '/api/settings');
    assert.ok(st.body.translate.maskedKey, '恢复后存取正常(maskedKey 有值)');
  } finally {
    await closeServer(app2.server);
  }
});

/* ---------- 17 无环境变量时走加密存储的密钥(端到端) ---------- */

test('17 存储密钥端到端:无环境变量时 LLM 概述与翻译均走加密存储', async () => {
  const app2 = await startApp({ dataDir: path.join(TMP, 'data-storeonly'), llmEnv: false, translateEnv: false });
  try {
    assert.equal(await providerConfigured(app2.base, 'llm'), false, '初始未配置');
    const save = await post(app2.base, '/api/settings/providers', {
      translate: { apiKey: 'stub-key' },
      llm: { preset: 'custom', baseUrl: `http://127.0.0.1:${ctx.llmPort}/v1`, model: 'stub-model', apiKey: 'stub-llm-key' },
    });
    assert.equal(save.body.analysisStarted, true, '配置完成自动触发分析');
    await runAnalysis(app2.base);

    assert.equal(await providerConfigured(app2.base, 'llm'), true, '存储密钥让 LLM 就绪');
    assert.equal(await providerConfigured(app2.base, 'translate'), true, '存储密钥让翻译就绪');

    const data = (await get(app2.base, '/api/skills')).body;
    const delta = data.skills.find((s) => s.dirName === 'delta');
    assert.equal(delta.summarySource, 'llm', '概述由存储密钥驱动的 LLM 生成');
    assert.equal(delta.attribution.repo, 'example/mono', '归属推断同样生效');

    // 翻译链路
    await post(app2.base, '/api/consent', { accept: true });
    await waitFor(async () => {
      const st = await get(app2.base, '/api/status');
      return !st.body.running;
    });
    const t = await post(app2.base, `/api/skills/${delta.id}/translate`, { path: 'SKILL.md' });
    assert.equal(t.status, 200, '翻译走存储密钥');
  } finally {
    await closeServer(app2.server);
  }
});

/* ---------- 24 v1.2.0 语言设置:摘要=描述,分类/仓库简介翻译缓存 ---------- */

test('24 语言设置:英文界面摘要=描述,分类/仓库简介翻译并缓存', async () => {
  // 先确保中文概述/分类缓存齐全,避免英文缓存因源分类后续变化而失效
  await runAnalysis(ctx.base);

  const switched = await post(ctx.base, '/api/settings/language', { language: 'en' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.language, 'en');
  assert.equal(switched.body.changed, true);
  await waitForIdle(ctx.base);

  const en = (await get(ctx.base, '/api/skills?lang=en')).body;
  assert.equal(en.language, 'en');

  const alphaEn = skillsByDir(en, 'alpha')[0];
  assert.equal(alphaEn.summarySource, 'description', '英文技能摘要 = frontmatter 描述');
  assert.equal(alphaEn.summary, alphaEn.description);
  assert.deepEqual(alphaEn.categories.sort(), ['【EN】种子分类A', '【EN】设计'].sort(), '种子分类翻译成英文');

  const cnEn = skillsByDir(en, 'chinese-one')[0];
  assert.equal(cnEn.summarySource, 'description');
  assert.ok(cnEn.summary.startsWith('【EN】'), '中文描述翻译成英文');
  assert.deepEqual(cnEn.categories, ['【EN】中文测试']);

  const deltaEn = skillsByDir(en, 'delta')[0];
  assert.equal(deltaEn.summarySource, 'description', '英文技能不生成 LLM 概述');
  assert.equal(deltaEn.summary, deltaEn.description);
  assert.deepEqual(deltaEn.categories, ['【EN】工程流程'], '中文概述缓存里的分类也翻译');

  const mono = en.groups.find((g) => g.repo === 'example/mono');
  assert.ok(mono.repoSummary.startsWith('【EN】'), '仓库简介翻译成英文');

  const cats = (await get(ctx.base, '/api/categories?lang=en')).body;
  // chips 为固定一级分类(与界面语言无关);卡片细分标签仍走翻译(上方已断言)
  assert.ok(cats.categories.some((c) => c.name === 'dev'), '一级分类进入筛选(工程流程归并到 dev)');

  const cacheFile = path.join(DATA, 'skills', cnEn.id, 'en.json');
  assert.ok(fs.existsSync(cacheFile), '英文概述缓存落盘');
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cached.lang, 'en');
  assert.equal(cached.summarySource, 'description');
  assert.ok(cached.sourceHash);
  const repoCache = path.join(DATA, 'summaries', 'repos', 'en.json');
  assert.ok(fs.existsSync(repoCache), '仓库简介翻译缓存落盘');
  assert.ok(fs.readFileSync(repoCache, 'utf8').includes('【EN】示例单仓库'));
  const labelCache = path.join(DATA, 'summaries', 'labels', 'en.json');
  assert.ok(fs.existsSync(labelCache), '分类标签翻译缓存落盘');
  assert.ok(fs.readFileSync(labelCache, 'utf8').includes('【EN】工程流程'));

  // 中文 → 英文再切换:元数据已缓存,不产生新的翻译调用
  await post(ctx.base, '/api/settings/language', { language: 'zh' });
  await waitForIdle(ctx.base);
  const callsBefore = ctx.uapi.stats().calls;
  await post(ctx.base, '/api/settings/language', { language: 'en' });
  await waitForIdle(ctx.base);
  assert.equal(ctx.uapi.stats().calls, callsBefore, '概述/分类/仓库简介翻译缓存命中');

  const zh = (await get(ctx.base, '/api/skills?lang=zh')).body;
  assert.equal(skillsByDir(zh, 'alpha')[0].summarySource, 'seed', '中文界面仍使用手写种子');
  assert.equal(skillsByDir(zh, 'delta')[0].summary, 'LLM 生成的中文概述');

  // 切回中文,避免影响后续用例
  await post(ctx.base, '/api/settings/language', { language: 'zh' });
  await waitForIdle(ctx.base);
});

/* ---------- 25 译文缓存按语言分存 + v1 懒迁移 ---------- */

test('25 译文缓存:按语言分存,v1 中文缓存懒迁移且不重译', async () => {
  const app = await startApp({ dataDir: path.join(TMP, 'data-lang-cache') });
  try {
    await post(app.base, '/api/consent', { accept: true });
    await waitForIdle(app.base);
    const data = (await get(app.base, '/api/skills')).body;
    const alpha = skillsByDir(data, 'alpha')[0];
    const alphaRaw = fs.readFileSync(path.join(FIXTURES, 'roots', 'agents', 'skills', 'alpha', 'SKILL.md'), 'utf8');
    const alphaHash = sha1(alphaRaw);
    const legacyFile = path.join(TMP, 'data-lang-cache', 'translations', alpha.id, `${alphaHash}.json`);
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({
      version: 1,
      skillId: alpha.id,
      docRelPath: 'SKILL.md',
      docHash: alphaHash,
      provider: 'uapipro',
      createdAt: '2026-01-01T00:00:00.000Z',
      blocks: [{ id: 'b0', type: 'paragraph', src: 'legacy', translated: '旧中文译文', status: 'ok' }],
      calls: 1,
      credits: 4,
    }));

    const before = ctx.uapi.stats().calls;
    const zh = await post(app.base, `/api/skills/${alpha.id}/translate`, { path: 'SKILL.md', lang: 'zh' });
    assert.equal(zh.status, 200);
    assert.equal(zh.body.cached, true);
    assert.equal(zh.body.lang, 'zh');
    assert.equal(zh.body.blocks[0].translated, '旧中文译文');
    assert.equal(ctx.uapi.stats().calls, before, '迁移命中不产生新调用');

    const newZhFile = path.join(TMP, 'data-lang-cache', 'translations', alpha.id, 'zh', `${alphaHash}.json`);
    assert.ok(fs.existsSync(newZhFile), 'v1 缓存已迁移到语言段');
    assert.ok(!fs.existsSync(legacyFile), '旧路径已清理');
    const migrated = JSON.parse(fs.readFileSync(newZhFile, 'utf8'));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.lang, 'zh');

    // 英文请求不得误命中中文缓存;英文界面下中文文档落到 en 语言段
    const cn = skillsByDir(data, 'chinese-one')[0];
    const cnRaw = fs.readFileSync(path.join(FIXTURES, 'roots', 'agents', 'skills', 'chinese-one', 'SKILL.md'), 'utf8');
    const cnHash = sha1(cnRaw);
    const en = await post(app.base, `/api/skills/${cn.id}/translate`, { path: 'SKILL.md', lang: 'en' });
    assert.equal(en.status, 200);
    assert.equal(en.body.cached, false);
    assert.equal(en.body.lang, 'en');
    assert.ok(en.body.blocks.some((b) => b.translated.startsWith('【EN】')), '英文译文来自英文目标语言');
    assert.ok(ctx.uapi.stats().hasLang('en'));
    assert.ok(fs.existsSync(path.join(TMP, 'data-lang-cache', 'translations', cn.id, 'en', `${cnHash}.json`)), '英文译文落到 en 语言段');
  } finally {
    await closeServer(app.server);
  }
});

/* ---------- 26 消息码契约 ---------- */

test('26 消息码契约:代表性错误返回稳定 code(+params)', async () => {
  const app = await startApp({ dataDir: path.join(TMP, 'data-codes'), llmEnv: false, translateEnv: true });
  try {
    const noIndex = await get(app.base, '/api/skills');
    assert.equal(noIndex.status, 503);
    assert.equal(noIndex.body.error.code, 'no_index');

    await runAnalysis(app.base);
    const data = (await get(app.base, '/api/skills')).body;
    const alpha = skillsByDir(data, 'alpha')[0];

    const noConsent = await post(app.base, `/api/skills/${alpha.id}/translate`, { path: 'SKILL.md', lang: 'zh' });
    assert.equal(noConsent.status, 409);
    assert.equal(noConsent.body.error.code, 'consent_required');

    // 清除翻译密钥 → provider_unconfigured(优先于 consent 校验)
    await post(app.base, '/api/settings/providers', { translate: { apiKey: null } });
    const noProvider = await post(app.base, `/api/skills/${alpha.id}/translate`, { path: 'SKILL.md', lang: 'zh' });
    assert.equal(noProvider.status, 503);
    assert.equal(noProvider.body.error.code, 'provider_unconfigured');

    const badDoc = await get(app.base, `/api/skills/${alpha.id}/doc?path=nope.md`);
    assert.equal(badDoc.status, 404);
    assert.equal(badDoc.body.error.code, 'doc_unreadable');
    assert.equal(badDoc.body.error.params.path, 'nope.md');

    const badReq = await post(app.base, '/api/overrides', {});
    assert.equal(badReq.status, 400);
    assert.equal(badReq.body.error.code, 'bad_request');

    const badKey = await post(app.base, '/api/settings/test/translate', { apiKey: 'nope' });
    assert.equal(badKey.body.keyAccepted, false);
    assert.equal(badKey.body.code, 'auth_failed');
  } finally {
    await closeServer(app.server);
  }
});

/* ---------- 27 手动预翻译目标语言 ---------- */

test('27 手动预翻译目标 = 当前界面语言,只翻非该语言入口文档', async () => {
  const app = await startApp({ dataDir: path.join(TMP, 'data-lang-pretranslate') });
  try {
    const switched = await post(app.base, '/api/settings/language', { language: 'en' });
    assert.equal(switched.status, 200);
    await waitForIdle(app.base);

    await post(app.base, '/api/consent', { accept: true });
    await waitForIdle(app.base);

    const before = ctx.uapi.stats();
    await post(app.base, '/api/analyze', { lang: 'en' });
    await waitForIdle(app.base);
    const after = ctx.uapi.stats();

    const newCalls = after.texts.slice(before.calls);
    const newLangs = after.langs.slice(before.calls);
    assert.ok(newCalls.length >= 1, '手动更新应预翻中文入口文档');
    assert.ok(newLangs.every((l) => l === 'en'), `预翻译目标语言应为 en,实际 ${[...new Set(newLangs)].join(',')}`);
    assert.ok(newCalls.some((t) => t.includes('这是一段中文正文')), '中文来源技能被译成英文');
    assert.ok(!newCalls.some((t) => t.includes('Alpha skill for testing')), '英文入口文档不做无谓翻译');
  } finally {
    await closeServer(app.server);
  }
});

/* ---------- 28 暂不处理:待推断技能移入自由技能且不再自动推断 ---------- */

test('28 暂不处理:overrides 空仓库 → 自由技能组,候选清空,后续分析不再推断', async () => {
  const app = await startApp({ dataDir: path.join(TMP, 'data-snooze') });
  try {
    await runAnalysis(app.base);
    const data0 = (await get(app.base, '/api/skills')).body;
    const lonely = skillsByDir(data0, 'lonely')[0];
    assert.ok(lonely.pendingInference, '前置:lonely 带待确认推断');

    const llmBefore = ctx.llm.stats().calls;
    const r = await post(app.base, '/api/overrides', { skillIds: [lonely.id], repo: '' });
    assert.equal(r.status, 200);

    const data1 = (await get(app.base, '/api/skills')).body;
    const unknown1 = data1.groups.find((g) => g.key === '__unknown__');
    assert.ok(unknown1, '自由技能组存在');
    assert.equal(unknown1.name, '自由技能');
    assert.equal(unknown1.nameKey, 'group.unknown');
    assert.ok(
      unknown1.subgroups.flatMap((s) => s.skills.map((x) => x.dirName)).includes('lonely'),
      '暂不处理的技能进入自由技能组',
    );
    const lonely1 = skillsByDir(data1, 'lonely')[0];
    assert.equal(lonely1.attribution.method, 'overrides');
    assert.equal(lonely1.attribution.manual, true);
    assert.equal(lonely1.attribution.repo, null);
    assert.equal(lonely1.pendingInference, null, '推断候选已清除');

    await runAnalysis(app.base);
    assert.equal(ctx.llm.stats().calls, llmBefore, '后续分析不再对已暂不处理的技能发起推断');
    const data2 = (await get(app.base, '/api/skills')).body;
    assert.equal(skillsByDir(data2, 'lonely')[0].attribution.method, 'overrides', '暂不处理结果持久');
  } finally {
    await closeServer(app.server);
  }
});
