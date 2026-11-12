//! 配置加载(与 Node config.js 语义对齐):默认值 + JSON 文件深合并 + ~ 展开。

use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub roots: Vec<PathBuf>,
    pub lock_files: Vec<PathBuf>,
    pub data_dir: PathBuf,
    pub seeds_file: PathBuf,
    pub public_dir: Option<PathBuf>,
    pub translate: TranslateCfg,
    pub config_file: Option<PathBuf>,
    pub base_dir: PathBuf,
}

#[derive(Clone, Debug)]
pub struct TranslateCfg {
    pub name: String,
    pub endpoint: String,
    pub auth_header: String,
    pub auth_prefix: String,
    pub target_lang: String,
    pub style: String,
    pub context: String,
    pub preserve_format: bool,
    pub max_chars_per_call: usize,
    pub qps: u32,
    pub concurrency: usize,
    pub credits_per_call: u64,
    pub response_field: String,
    pub timeout_ms: u64,
}

impl Default for TranslateCfg {
    fn default() -> Self {
        Self {
            name: "uapipro".into(),
            endpoint: "https://uapis.cn/api/v1/ai/translate".into(),
            auth_header: "Authorization".into(),
            auth_prefix: "Bearer ".into(),
            target_lang: "zh".into(),
            style: "professional".into(),
            context: "technical".into(),
            preserve_format: true,
            max_chars_per_call: 10000,
            qps: 4,
            concurrency: 6,
            credits_per_call: 4,
            response_field: "data.translated_text".into(),
            timeout_ms: 45000,
        }
    }
}

fn default_roots() -> Vec<PathBuf> {
    // 全量支持根:与 lib/config.js DEFAULTS.roots、config.example.json 同步维护
    [
        "~/.agents/skills", "~/.claude/skills", "~/.codex/skills", "~/.cursor/skills",
        "~/.copilot/skills", "~/.gemini/skills", "~/.codeium/windsurf/skills", "~/.qwen/skills",
        "~/.trae/skills", "~/.roo/skills", "~/.config/opencode/skills", "~/.zcode/skills",
        "~/.workbuddy/skills", "~/.adal/skills",
        "~/.gemini/antigravity/skills", "~/.augment/skills", "~/.openclaw-autoclaw/skills",
        "~/.codebuddy/skills", "~/.commandcode/skills", "~/.continue/skills",
        "~/.snowflake/cortex/skills", "~/.config/crush/skills", "~/.dsh/skills",
        "~/.factory/skills", "~/.config/goose/skills", "~/.hermes/skills", "~/.iflow/skills",
        "~/.junie/skills", "~/.kilocode/skills", "~/.kiro/skills", "~/.kode/skills",
        "~/.mcpjam/skills", "~/.vibe/skills", "~/.mux/skills", "~/.neovate/skills",
        "~/.openclaw/skills", "~/.openhands/skills", "~/.pi/agent/skills", "~/.pochi/skills",
        "~/.qoder/skills", "~/.trae-cn/skills", "~/.zencoder/skills",
    ]
    .iter().map(|s| expand_home(s)).collect()
}

pub fn expand_home(p: &str) -> PathBuf {
    if p == "~" {
        return home_dir();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return home_dir().join(rest);
    }
    PathBuf::from(p)
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn deep_merge(target: &mut Value, src: &Value) {
    match (target, src) {
        (Value::Object(t), Value::Object(s)) => {
            for (k, v) in s {
                let entry = t.entry(k.clone()).or_insert(Value::Null);
                if entry.is_object() && v.is_object() {
                    deep_merge(entry, v);
                } else {
                    *entry = v.clone();
                }
            }
        }
        (t, s) => *t = s.clone(),
    }
}

/// 与 Node 一致的默认配置骨架
fn defaults_value() -> Value {
    serde_json::json!({
        "port": 4763,
        "host": "127.0.0.1",
        "roots": ["~/.agents/skills", "~/.zcode/skills", "~/.claude/skills"],
        "lockFiles": ["~/.agents/.skill-lock.json"],
        "dataDir": "data",
        "seedsFile": "seeds/summaries.json",
        "providers": {
            "translate": {},
            "llm": {}
        }
    })
}

/// 共享配置的约定位置(与 Node lib/config.js 对齐):放一份 config.json
/// 即可让网页版与桌面版天然使用同一 dataDir,无需启动参数。
fn shared_config_path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config"));
    base.join("skills-lingo").join("config.json")
}

pub fn load_config(config_file: Option<&Path>) -> Config {
    let found: Option<PathBuf> = config_file
        .map(|p| p.to_path_buf())
        .or_else(|| {
            let cwd = std::env::current_dir().ok()?;
            std::fs::metadata(cwd.join("config.json")).is_ok().then(|| cwd.join("config.json"))
        })
        .or_else(|| {
            let shared = shared_config_path();
            std::fs::metadata(&shared).is_ok().then_some(shared)
        })
        .filter(|p| p.exists());
    let base_dir = found
        .as_ref()
        .and_then(|p| p.parent().map(|x| x.to_path_buf()))
        .map(|p| absolutize(&p))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let mut cfg = defaults_value();
    if let Some(path) = &found {
        if let Ok(user) = serde_json::from_str::<Value>(&std::fs::read_to_string(path).unwrap_or_default()) {
            deep_merge(&mut cfg, &user);
        }
    }

    let s = |k: &str| cfg.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let roots: Vec<PathBuf> = cfg
        .get("roots")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(expand_home).collect())
        .unwrap_or_else(default_roots);
    let lock_files: Vec<PathBuf> = cfg
        .get("lockFiles")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(expand_home).collect())
        .unwrap_or_else(|| vec![expand_home("~/.agents/.skill-lock.json")]);

    let tc = cfg.pointer("/providers/translate").cloned().unwrap_or(Value::Null);
    let ts = |k: &str, d: &str| tc.get(k).and_then(|v| v.as_str()).unwrap_or(d).to_string();
    let translate = TranslateCfg {
        name: ts("name", "uapipro"),
        endpoint: ts("endpoint", "https://uapis.cn/api/v1/ai/translate"),
        auth_header: ts("authHeader", "Authorization"),
        auth_prefix: ts("authPrefix", "Bearer "),
        target_lang: ts("targetLang", "zh"),
        style: ts("style", "professional"),
        context: ts("context", "technical"),
        preserve_format: tc.get("preserveFormat").and_then(|v| v.as_bool()).unwrap_or(true),
        max_chars_per_call: tc.get("maxCharsPerCall").and_then(|v| v.as_u64()).unwrap_or(10000) as usize,
        qps: tc.get("qps").and_then(|v| v.as_u64()).unwrap_or(4).max(1) as u32,
        concurrency: tc.get("concurrency").and_then(|v| v.as_u64()).unwrap_or(6).max(1) as usize,
        credits_per_call: tc.get("creditsPerCall").and_then(|v| v.as_u64()).unwrap_or(4),
        response_field: ts("responseField", "data.translated_text"),
        timeout_ms: tc.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(45000),
    };

    // 相对路径基于配置文件目录(与 Node baseDir 语义一致;绝对路径/展开后的绝对路径直接生效)
    let data_dir = base_dir.join(expand_home(cfg.get("dataDir").and_then(|v| v.as_str()).unwrap_or("data")));
    let seeds_raw = cfg.get("seedsFile").and_then(|v| v.as_str()).unwrap_or("seeds/summaries.json");
    let seeds_file = base_dir.join(expand_home(seeds_raw));

    Config {
        port: cfg.get("port").and_then(|v| v.as_u64()).unwrap_or(4763) as u16,
        host: s("host").is_empty().then(|| "127.0.0.1".to_string()).unwrap_or(s("host")),
        roots,
        lock_files,
        data_dir,
        seeds_file,
        public_dir: cfg.get("publicDir").and_then(|v| v.as_str()).map(PathBuf::from),
        translate,
        config_file: found,
        base_dir,
    }
}

fn absolutize(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(p)
    }
}
