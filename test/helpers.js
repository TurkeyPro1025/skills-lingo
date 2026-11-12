'use strict';

/**
 * 测试装置:fixture 技能树构建 + stub provider(fake UApiPro / fake LLM)。
 * 全部测试不打真网、不需要真实 key(spec 故事 33)。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

/* ---------- fixture 技能树 ---------- */

const LONG_DOC_PARAS = 85; // 每段约 480 字符 → 4 万+ 字符,触发分块

function buildFixtures(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const agents = path.join(dir, 'roots', 'agents', 'skills');
  const zcodeA = path.join(dir, 'roots', 'zcodeA', 'skills');
  const claudeA = path.join(dir, 'roots', 'claudeA', 'skills');
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(zcodeA, { recursive: true });
  fs.mkdirSync(claudeA, { recursive: true });

  write(agents, 'alpha/SKILL.md', [
    '---',
    'name: alpha',
    'description: Alpha skill for testing with `npm install skill-x` and https://example.com/docs and ~/.agents/skills path.',
    '---',
    '',
    '# Alpha',
    '',
    `Run \`npm install skill-x\` first. See https://example.com/docs or the file at ~/.agents/skills/alpha.`,
    'Set $HOME_DIR before running. Then enjoy the prose. ' + 'word '.repeat(20).trim(),
    '',
    '```bash',
    'echo "code block never translated"',
    '```',
    '',
    '- list item one',
    '- list item two with `inline code`',
    '',
    '| col a | col b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n'));

  write(agents, 'alpha/reference-long.md', Array.from({ length: LONG_DOC_PARAS }, (_, i) =>
    `Paragraph ${i}: ${'The quick brown fox jumps over the lazy dog while testing chunk packing. '.repeat(8)}\n`).join('\n'));

  // 1x1 PNG(最小合法图,验证图片端点)
  write(agents, 'alpha/assets/pic.png', Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050502014b6e2f4a0000000049454e44ae426082',
    'hex',
  ));

  // decoy .git:lock 应优先于它
  write(agents, 'alpha/.git/config', '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/decoy/decoy-repo.git\n');

  write(agents, 'beta/SKILL.md', '---\nname: beta\ndescription: Beta installed by manual git clone.\n---\n\n# Beta\n\nBeta body text for reading.\n');
  write(agents, 'beta/.git/config', '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/hand/hand-repo.git\n');

  write(agents, 'gamma/SKILL.md', [
    '---',
    'name: gamma',
    'description: Gamma skill with upstream URL in frontmatter.',
    'source: https://github.com/up/upstream-repo',
    '---',
    '',
    '# Gamma',
    '',
    'FAIL_TOKEN gamma body line one.',
    'Gamma body line two for good measure.',
  ].join('\n'));

  write(agents, 'delta/SKILL.md', [
    '---',
    'name: delta',
    'description: >',
    '  Delta has no lock entry, no git, no url.',
    '  Folded multi-line description for yaml coverage.',
    '---',
    '',
    '# Delta',
    '',
    'Delta body that LLM may read to infer the origin repo example/mono.',
  ].join('\n'));

  write(agents, 'chinese-one/SKILL.md', '---\nname: chinese-one\ndescription: 中文技能,单栏直出不翻译。\n---\n\n# 中文技能\n\n这是一段中文正文,不需要翻译,直接展示即可。\n');

  write(agents, 'no-skill/README.md', '# not a skill\n');
  write(agents, 'nested/inner/SKILL.md', '# nested skill not at top level\n');

  // zcodeA / claudeA 的链接(junction on win32 无需管理员,symlink on POSIX)
  link(path.join(agents, 'alpha'), path.join(zcodeA, 'alpha'));
  link(path.join(agents, 'alpha'), path.join(claudeA, 'alpha'));

  // 内容一致的独立拷贝(不同文件夹名)→ 合并
  fs.mkdirSync(path.join(claudeA, 'alpha-copy'), { recursive: true });
  copyDir(path.join(agents, 'alpha'), path.join(claudeA, 'alpha-copy'));

  // 同名不同内容 → 版本分岔
  fs.mkdirSync(path.join(claudeA, 'beta'), { recursive: true });
  write(claudeA, 'beta/SKILL.md', '---\nname: beta\ndescription: Beta forked copy living in claudeA root.\n---\n\n# Beta (fork)\n\nForked content differs from the agents one.\n');

  // 仅存在于 claudeA 的独立技能,无任何归属线索 → 未知来源
  write(claudeA, 'lonely/SKILL.md', '---\nname: lonely\ndescription: Lonely skill with no attribution clues.\n---\n\n# Lonely\n\nNo lock, no git, no url. Lives only in claudeA.\n');

  // lock 清单(skills CLI v3 格式)
  const lock = {
    version: 3,
    skills: {
      alpha: {
        source: 'example/mono',
        sourceType: 'github',
        sourceUrl: 'https://github.com/example/mono.git',
        skillPath: '.claude/skills/sub/alpha/SKILL.md',
        skillFolderHash: 'aaaa',
        installedAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      'chinese-one': {
        source: 'example/cn',
        sourceType: 'github',
        sourceUrl: 'https://github.com/example/cn.git',
        skillPath: 'skills/chinese-one/SKILL.md',
        skillFolderHash: 'bbbb',
        installedAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(lock, null, 2));

  // 种子数据
  const seeds = {
    version: 1,
    sources: {
      'example/mono': {
        repoSummary: '示例单仓库,含 alpha 等。',
        skills: {
          alpha: { summary: '种子概述:alpha 是测试技能。', categories: ['种子分类A', '设计'] },
        },
      },
      'example/cn': {
        repoSummary: '中文示例仓库。',
        skills: {
          'chinese-one': { summary: '种子概述:中文测试技能。', categories: ['中文测试'] },
        },
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'seeds.json'), JSON.stringify(seeds, null, 2));

  return { roots: [agents, zcodeA, claudeA], lock: path.join(dir, 'lock.json'), seeds: path.join(dir, 'seeds.json') };
}

function write(base, rel, content) {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function link(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    // CI 无权限建 junction/symlink 时退化为拷贝(去重断言将跳过链接分支)
    copyDir(target, linkPath);
    return 'copy';
  }
  return 'link';
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/* ---------- stub: fake UApiPro ---------- */

function createFakeUApiPro() {
  const calls = [];
  let failMode = false;
  let failOverChars = 0; // >0 时:超过该字符数的调用返回 500,模拟大包失败
  let delayMs = 0; // 模拟真实翻译耗时,让并发可观察
  let active = 0;
  let maxConcurrent = 0;
  let failToken = true; // 含 FAIL_TOKEN 的文本失败,用于失败/重试链路测试

  function fakeTranslate(text, lang) {
    const prefix = lang === 'en' ? '【EN】' : '【译】';
    const lines = text.split('\n').map((l) =>
      (l === '' || l.startsWith('⟦S') || l.startsWith('⟦E')) ? l : `${prefix}${l}`);
    // 故意改写未受保护的敏感词,验证占位符保护
    return lines.join('\n').replace(/skill-x/g, '技能X');
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (req.method === 'GET' && url.pathname === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        calls: calls.length,
        maxLen: calls.reduce((m, c) => Math.max(m, c.len), 0),
        overLimit: calls.some((c) => c.len > 10000),
        firstTs: calls[0]?.ts ?? null,
        lastTs: calls[calls.length - 1]?.ts ?? null,
        texts: calls.map((c) => c.text.slice(0, 120)),
        langs: calls.map((c) => c.lang),
        maxConcurrent,
      }));
    }
    if (req.method === 'POST' && url.pathname === '/__mode') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const mode = JSON.parse(body);
        if (typeof mode.fail === 'boolean') failMode = mode.fail;
        if (typeof mode.failToken === 'boolean') failToken = mode.failToken;
        if (typeof mode.delay === 'number') delayMs = mode.delay;
        if (typeof mode.failOverChars === 'number') failOverChars = mode.failOverChars;
        res.writeHead(200); res.end('{}');
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/ai/translate') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer ') || /^Bearer (nope|wrong)/.test(auth)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'missing or invalid bearer' }));
        }
        const lang = url.searchParams.get('target_lang');
        if (lang !== 'zh' && lang !== 'en') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'target_lang required (zh|en)' }));
        }
        const payload = JSON.parse(body);
        if (!payload.text || payload.style !== 'professional' || payload.context !== 'technical') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'bad body fields' }));
        }
        calls.push({ len: payload.text.length, ts: Date.now(), text: payload.text, lang });
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        const finish = () => {
          active--;
          if (failMode || (failToken && payload.text.includes('FAIL_TOKEN')) || (failOverChars > 0 && payload.text.length > failOverChars)) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'stub translate failure' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            message: 'Translation completed successfully',
            data: { translated_text: fakeTranslate(payload.text, lang) },
            performance: { processing_time_ms: 5 },
          }));
        };
        if (delayMs > 0) setTimeout(finish, delayMs);
        else finish();
      });
      return;
    }
    // 免费可达性探针端点(连通测试用,无需鉴权)
    if (req.method === 'GET' && url.pathname === '/api/v1/status/usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ endpoints: [{ path: '/api/v1/ai/translate', count: calls.length }] }));
    }
    res.writeHead(404); res.end('{}');
  });

  return {
    server,
    stats: () => ({
      calls: calls.length,
      maxLen: calls.reduce((m, c) => Math.max(m, c.len), 0),
      overLimit: calls.some((c) => c.len > 10000),
      firstTs: calls[0]?.ts ?? null,
      lastTs: calls[calls.length - 1]?.ts ?? null,
      texts: calls.map((c) => c.text.slice(0, 120)),
      langs: calls.map((c) => c.lang),
      maxConcurrent,
      hasText: (sub) => calls.some((c) => c.text.includes(sub)),
      hasLang: (lang) => calls.some((c) => c.lang === lang),
    }),
    setFail: (f) => { failMode = f; },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ---------- stub: fake LLM(OpenAI 兼容) ---------- */

function createFakeLlm() {
  const calls = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (req.method === 'GET' && url.pathname === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ calls: calls.length }));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer ') || auth === 'Bearer wrong-key') {
          res.writeHead(401);
          return res.end('{"error":"no auth"}');
        }
        const payload = JSON.parse(body);
        const sys = payload.messages?.find((m) => m.role === 'system')?.content || '';
        const user = payload.messages?.find((m) => m.role === 'user')?.content || '';
        calls.push({ sys: sys.slice(0, 60), user: user.slice(0, 80) });
        let content;
        if (sys.includes('归属推断')) {
          // delta → 高置信度:自动纳入;lonely → 低置信度:仅作候选待确认;其余 → 无归属
          if (user.includes('技能名: delta')) {
            content = { repo: 'example/mono', confidence: 'high', alternatives: [] };
          } else if (user.includes('技能名: lonely')) {
            content = { repo: 'hand/hand-repo', confidence: 'low', alternatives: [] };
          } else {
            content = { repo: null, confidence: 'low' };
          }
        } else {
          content = { summary: 'LLM 生成的中文概述', categories: ['工程流程'] };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      });
      return;
    }
    // 连通测试用的模型列表端点(需鉴权)
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || auth === 'Bearer wrong-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'stub-model', name: 'Stub Model' }, { id: 'stub-model-pro', name: 'Stub Model Pro' }] }));
    }
    res.writeHead(404); res.end('{}');
  });

  return {
    server,
    stats: () => ({ calls: calls.length }),
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { buildFixtures, createFakeUApiPro, createFakeLlm, LONG_DOC_PARAS };
