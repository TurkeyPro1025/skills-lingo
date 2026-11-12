//! 概述解析(读路径 + 翻译源,与 Node summaries.js 对齐):
//! - 中文界面:种子 → 中文缓存 → (分析阶段 LLM) → 原文描述。
//! - 非中文界面:card-summary = frontmatter 描述(英文直接使用,其它语言翻译);
//!   分类标签与仓库简介来自中文种子/中文概述缓存,翻译后写入该语言缓存。
//! 读路径不发起任何外部调用;缺失时先原文直出,等分析补齐。

use crate::cache::Cache;
use crate::util::sha1_hex;
use serde_json::Value;

/// 概述策略版本:非中文界面 = 描述 + 翻译元数据。旧索引(无此字段或低于 2)需重跑一次。
pub const SUMMARY_META_VERSION: i64 = 2;

/// 概述解析所需的实体字段(索引实体与扫描实体共同形状)
pub struct EntityRef<'a> {
    pub id: &'a str,
    pub dir_name: &'a str,
    pub description: &'a str,
    pub content_hash: &'a str,
}

/// 卡片三元组:概述 + 来源 + 分类
#[derive(Clone)]
pub struct Card {
    pub summary: String,
    pub summary_source: &'static str,
    pub categories: Vec<String>,
}

pub struct LocalizedSource {
    pub description: String,
    pub categories: Vec<String>,
}

fn seed_for<'a>(dir_name: &str, repo: Option<&str>, seeds: &'a Value) -> Option<&'a Value> {
    let sources = seeds.get("sources")?;
    let by_repo = repo.and_then(|r| sources.get(r));
    by_repo
        .and_then(|s| s.get("skills").and_then(|k| k.get(dir_name)))
        .or_else(|| sources.get("*").and_then(|s| s.get("skills").and_then(|k| k.get(dir_name))))
}

fn seed_str(seed: &Value, key: &str) -> Option<String> {
    seed.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn str_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|c| c.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

/* ---------- 一级分类体系(category-chips 用),与 Node summaries.js 的表保持一致 ---------- */
// 固定 7 个一级分类,顺序即展示序;细分标签读取时归并到一级,不重写缓存。
// 开发与工程 = 原「开发实践/工程流程」合并:真实数据里工程向标签占多数,拆两类边界争议大。
pub const L1_ORDER: [&str; 7] = ["dev", "writing", "learning", "design", "data", "life", "other"];

/// 分类名(一级中文名或历史细分名)→ 一级 id;未命中归 other。LLM 概述今后只产出一级中文名(见 llm.rs)。
pub fn to_l1(name: &str) -> &'static str {
    match name {
        "开发与工程" | "开发实践" | "前端开发" | "实现与编码" | "代码审查" | "调试" | "测试" | "任务分解"
        | "推荐系统" | "工程流程" | "项目管理" | "项目配置" | "规格与工单" | "会话管理" | "领域建模"
        | "需求文档" => "dev",
        "写作沟通" | "写作" | "沟通模式" | "演示文稿" => "writing",
        "学习研究" | "学习引导" | "教学材料" | "调研" => "learning",
        "设计创意" | "设计" | "视觉设计" | "设计智能" | "品牌视觉" | "设计系统" => "design",
        "数据分析" => "data",
        "生活效率" | "生活服务" | "旅游规划" | "旅行生活" => "life",
        _ => "other",
    }
}

/// 分类名数组 → 一级 id 数组(保持顺序与长度,卡片细分标签按索引对应)
pub fn l1_of(names: &[String]) -> Vec<&'static str> {
    names.iter().map(|n| to_l1(n)).collect()
}

/// 分类的来源:种子优先,其次中文 LLM 概述缓存
pub fn source_categories(entity: &EntityRef, repo: Option<&str>, seeds: &Value, cache: &Cache) -> Vec<String> {
    if let Some(seed) = seed_for(entity.dir_name, repo, seeds) {
        let cats = str_array(seed.get("categories"));
        if !cats.is_empty() {
            return cats;
        }
    }
    let cached = cache.read_skill(entity.id, "zh");
    if let Some(c) = cached.as_ref() {
        if c.get("contentHash").and_then(|h| h.as_str()) == Some(entity.content_hash) {
            let cats = str_array(c.get("categories"));
            if !cats.is_empty() {
                return cats;
            }
        }
    }
    Vec::new()
}

/// 非中文界面的翻译源:描述 + 中文分类标签
pub fn localized_source(entity: &EntityRef, repo: Option<&str>, seeds: &Value, cache: &Cache) -> LocalizedSource {
    LocalizedSource {
        description: entity.description.to_string(),
        categories: source_categories(entity, repo, seeds, cache),
    }
}

/// 源文本哈希:描述或分类变化时使该语言的概述缓存失效。
/// 字节级对齐 Node 的 JSON.stringify({description, categories})(网页/桌面共用 dataDir)。
pub fn summary_source_hash(source: &LocalizedSource) -> String {
    let mut buf = String::from("{\"description\":");
    serde_json::to_string(&source.description).map(|s| buf.push_str(&s)).ok();
    buf.push_str(",\"categories\":[");
    for (i, cat) in source.categories.iter().enumerate() {
        if i > 0 {
            buf.push(',');
        }
        serde_json::to_string(cat).map(|s| buf.push_str(&s)).ok();
    }
    buf.push_str("]}");
    sha1_hex(&buf)
}

pub fn is_valid_localized_cache(cached: Option<&Value>, entity: &EntityRef, lang: &str, source: &LocalizedSource) -> bool {
    let Some(c) = cached else { return false };
    c.get("lang").and_then(|v| v.as_str()) == Some(lang)
        && c.get("contentHash").and_then(|h| h.as_str()) == Some(entity.content_hash)
        && c.get("summarySource").and_then(|v| v.as_str()) == Some("description")
        && c.get("sourceHash").and_then(|v| v.as_str()) == Some(summary_source_hash(source).as_str())
        && c.get("summary").and_then(|v| v.as_str()).is_some()
}

/// 读路径概述解析:zh = 种子→中文缓存;其它语言 = 校验通过的语言缓存,未命中回 None(由调用方降级)
pub fn resolve_stored_summary(
    entity: &EntityRef,
    repo: Option<&str>,
    lang: &str,
    seeds: &Value,
    cache: &Cache,
) -> Option<Card> {
    if lang == "zh" {
        if let Some(seed) = seed_for(entity.dir_name, repo, seeds) {
            if let Some(summary) = seed_str(seed, "summary") {
                return Some(Card {
                    summary,
                    summary_source: "seed",
                    categories: str_array(seed.get("categories")),
                });
            }
        }
        let cached = cache.read_skill(entity.id, "zh");
        if let Some(c) = cached.as_ref() {
            let hash_ok = c.get("contentHash").and_then(|h| h.as_str()) == Some(entity.content_hash);
            let summary = c.get("summary").and_then(|v| v.as_str());
            if let (true, Some(summary)) = (hash_ok, summary) {
                return Some(Card {
                    summary: summary.to_string(),
                    summary_source: match c.get("summarySource").and_then(|v| v.as_str()) {
                        Some("seed") => "seed",
                        _ => "llm",
                    },
                    categories: str_array(c.get("categories")),
                });
            }
        }
        return None;
    }

    let source = localized_source(entity, repo, seeds, cache);
    let cached = cache.read_skill(entity.id, lang);
    if is_valid_localized_cache(cached.as_ref(), entity, lang, &source) {
        let c = cached.unwrap();
        return Some(Card {
            summary: c.get("summary").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            summary_source: "description",
            categories: str_array(c.get("categories")),
        });
    }
    None
}

pub fn fallback_summary(entity: &EntityRef, lang: &str) -> Card {
    Card {
        summary: if entity.description.is_empty() {
            if lang == "zh" { "(无描述)".into() } else { "(no description)".into() }
        } else {
            entity.description.to_string()
        },
        summary_source: if lang == "zh" { "fallback" } else { "description" },
        categories: Vec::new(),
    }
}

/// 仓库简介:中文用种子原文;其它语言用翻译缓存(按源文本哈希校验)
pub fn resolve_repo_summary(repo: &str, lang: &str, seeds: &Value, cache: &Cache) -> String {
    let source = seeds
        .pointer(&format!("/sources/{}", json_pointer_escape(repo)))
        .and_then(|s| s.get("repoSummary"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if source.is_empty() {
        return String::new();
    }
    if lang == "zh" {
        return source.to_string();
    }
    let repo_data = cache.read_repo_summaries(lang);
    let entry = repo_data.pointer(&format!("/entries/{}", json_pointer_escape(repo)));
    if let Some(e) = entry {
        let hash_ok = e.get("sourceHash").and_then(|v| v.as_str()) == Some(sha1_hex(source).as_str());
        let summary = e.get("summary").and_then(|v| v.as_str()).unwrap_or_default();
        if hash_ok && !summary.is_empty() {
            return summary.to_string();
        }
    }
    String::new()
}

/// repo 名含 '/',JSON pointer 转义后寻址
fn json_pointer_escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}
