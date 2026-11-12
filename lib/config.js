'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonIfExists } = require('./util');

/**
 * 默认数据目录:与桌面端(desktop_data_dir)对齐,两端开箱即共用同一数据空间。
 * Windows = %APPDATA%\skills-lingo;macOS = ~/Library/Application Support/skills-lingo;
 * Linux = XDG 数据目录(~/.local/share/skills-lingo);无法定位时兜底 ./data。
 */
function defaultDataDir() {
  if (process.platform === 'win32') {
    // 与桌面端 desktop_data_dir() 一致:APPDATA 缺失时兜底用户主目录下的 Roaming
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'skills-lingo');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'skills-lingo');
  }
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(xdg, 'skills-lingo');
  }
  return 'data';
}

const DEFAULTS = {
  port: 4763,
  host: '127.0.0.1',
  // 全量支持根(对照 skills CLI 官方 supported-agents 表 + 社区目录约定),
  // 与 config.example.json、桌面端 default_roots 同步维护;不存在的目录扫描时静默跳过
  roots: [
    '~/.agents/skills', '~/.claude/skills', '~/.codex/skills', '~/.cursor/skills',
    '~/.copilot/skills', '~/.gemini/skills', '~/.codeium/windsurf/skills', '~/.qwen/skills',
    '~/.trae/skills', '~/.roo/skills', '~/.config/opencode/skills', '~/.zcode/skills',
    '~/.workbuddy/skills', '~/.adal/skills',
    '~/.gemini/antigravity/skills', '~/.augment/skills', '~/.openclaw-autoclaw/skills',
    '~/.codebuddy/skills', '~/.commandcode/skills', '~/.continue/skills',
    '~/.snowflake/cortex/skills', '~/.config/crush/skills', '~/.dsh/skills',
    '~/.factory/skills', '~/.config/goose/skills', '~/.hermes/skills', '~/.iflow/skills',
    '~/.junie/skills', '~/.kilocode/skills', '~/.kiro/skills', '~/.kode/skills',
    '~/.mcpjam/skills', '~/.vibe/skills', '~/.mux/skills', '~/.neovate/skills',
    '~/.openclaw/skills', '~/.openhands/skills', '~/.pi/agent/skills', '~/.pochi/skills',
    '~/.qoder/skills', '~/.trae-cn/skills', '~/.zencoder/skills',
  ],
  lockFiles: ['~/.agents/.skill-lock.json'],
  dataDir: defaultDataDir(),
  // 种子随安装位置走(仓库内),不随启动目录——换目录启动也能拿到人工中文概述
  seedsFile: path.join(__dirname, '..', 'seeds', 'summaries.json'),
  providers: {
    translate: {
      name: 'uapipro',
      endpoint: 'https://uapis.cn/api/v1/ai/translate',
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      targetLang: 'zh',
      style: 'professional',
      context: 'technical',
      preserveFormat: true,
      maxCharsPerCall: 10000,
      qps: 4,
      concurrency: 6, // 翻译接口官方并发上限 7,留 1 余量
      creditsPerCall: 4,
      responseField: 'data.translated_text',
      timeoutMs: 45000, // uapipro 大包易 524(Cloudflare 超时),缩短干等窗口;失败由重试+二分兜底
    },
    llm: { name: 'openai-compat', baseUrl: '', model: '' },
  },
};

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * 共享配置的约定位置(桌面端同款逻辑):放一份 config.json 即可让网页版与
 * 桌面版天然使用同一 dataDir,无需启动参数(开机自启/托盘双击也生效)。
 */
function sharedConfigPath(appDataDir) {
  const base = appDataDir
    || process.env.APPDATA
    || path.join(os.homedir(), '.config');
  return path.join(base, 'skills-lingo', 'config.json');
}

/**
 * 配置搜索顺序:显式指定 → 启动目录 → 仓库根目录 → 共享目录。
 * @param {{cwd?: string, repoDir?: string, appDataDir?: string}} from 测试注入点
 */
function configSearchCandidates({ cwd, repoDir, appDataDir } = {}) {
  const cwdDir = cwd || process.cwd();
  const repo = repoDir || path.join(__dirname, '..');
  return [
    path.join(cwdDir, 'config.json'),
    path.join(repo, 'config.json'),
    sharedConfigPath(appDataDir),
  ];
}

/**
 * 配置只保存非敏感信息;API key 一律走网页设置页的加密存储,绝不落盘。
 * @param {string|null} configFile 显式配置文件路径;缺省按 configSearchCandidates 的顺序查找
 */
function loadConfig(configFile) {
  const explicit = configFile || process.env.SKILLS_LINGO_CONFIG || null;
  const candidates = explicit ? [explicit] : configSearchCandidates();
  const found = candidates.find((c) => c && fs.existsSync(c)) || null;
  const baseDir = found ? path.dirname(path.resolve(found)) : process.cwd();

  const user = found ? readJsonIfExists(found) : {};
  const cfg = deepMerge(structuredClone(DEFAULTS), user || {});

  cfg.configFile = found;
  cfg.baseDir = baseDir;
  cfg.roots = (cfg.roots || []).map(expandHome);
  cfg.lockFiles = (cfg.lockFiles || []).map(expandHome);
  cfg.dataDir = path.resolve(baseDir, expandHome(cfg.dataDir));
  cfg.seedsFile = path.resolve(baseDir, expandHome(cfg.seedsFile));
  cfg.publicDir = path.join(__dirname, '..', 'public');
  return cfg;
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

module.exports = { loadConfig, configSearchCandidates, sharedConfigPath, expandHome, DEFAULTS };
