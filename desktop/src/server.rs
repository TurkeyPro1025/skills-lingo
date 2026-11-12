//! HTTP API 层(与 Node api.js 契约一致):黑盒测试与前端共用的唯一接缝。
//! 跨源/DNS-rebinding 防护:非 GET 请求必须来自本机同源。

use crate::app::App;
use crate::languages::normalize_lang;
use crate::summaries::{
    fallback_summary, l1_of, resolve_repo_summary, resolve_stored_summary, source_categories, EntityRef,
    L1_ORDER, SUMMARY_META_VERSION,
};
use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, Request};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/", get(index_route))
        .route("/style.css", get(css_route))
        .route("/app.js", get(js_route))
        .route("/locales.json", get(locales_route))
        .route("/logo.png", get(logo_route))
        // 清理版图标文件本体;前端实际渲染用的是 app.js 内联常量(ICO_DUMP_TO/ICO_LINK,
        // 可继承 currentColor),这两条路由仅对外提供文件,无前端消费方
        .route("/dump_to.svg", get(|| async { asset("dump_to.svg", "image/svg+xml") }))
        .route("/link.svg", get(|| async { asset("link.svg", "image/svg+xml") }))
        .route("/api/status", get(status))
        .route("/api/skills", get(skills_list))
        .route("/api/categories", get(categories))
        .route("/api/skills/{id}", get(skill_detail))
        .route("/api/skills/{id}/doc", get(skill_doc))
        .route("/api/skills/{id}/file", get(skill_file))
        .route("/api/skills/{id}/translate", get(skill_translate_get).post(skill_translate))
        .route("/api/skills/{id}/retry", post(skill_retry))
        .route("/api/consent", post(consent))
        .route("/api/clear-warnings", post(clear_warnings))
        .route("/api/analyze", post(analyze))
        .route("/api/overrides", post(overrides))
        .route("/api/confirm-inference", post(confirm_inference))
        .route("/api/settings", get(settings))
        .route("/api/settings/language", post(settings_language))
        .route("/api/settings/providers", post(settings_providers))
        .route("/api/settings/test/llm", post(settings_test_llm))
        .route("/api/settings/test/translate", post(settings_test_translate))
        .route("/api/desktop-settings", get(desktop_settings_get).post(desktop_settings_set))
        .route("/api/open-external", post(open_external))
        .fallback(fallback)
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn(log_requests))
        .layer({
            let app_guard = app.clone();
            middleware::from_fn(move |req, next| {
                let app = app_guard.clone();
                async move { origin_guard(app, req, next).await }
            })
        })
        .with_state(app)
}

/* ---------- 静态资源 ---------- */

async fn index_route() -> Response {
    asset("index.html", "text/html; charset=utf-8")
}
async fn css_route() -> Response {
    asset("style.css", "text/css; charset=utf-8")
}
async fn js_route() -> Response {
    asset("app.js", "application/javascript; charset=utf-8")
}
async fn locales_route() -> Response {
    asset("locales.json", "application/json; charset=utf-8")
}
async fn logo_route() -> Response {
    asset("logo.png", "image/png")
}

fn asset(name: &str, mime: &str) -> Response {
    #[cfg(debug_assertions)]
    {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public");
        if let Ok(body) = std::fs::read(base.join(name)) {
            return ([(header::CONTENT_TYPE, mime.to_string())], body).into_response();
        }
        eprintln!("[http] 磁盘读取 {name} 失败,回退内嵌资源");
    }
    let body: &'static [u8] = match name {
        "index.html" => include_bytes!("../../public/index.html"),
        "style.css" => include_bytes!("../../public/style.css"),
        "app.js" => include_bytes!("../../public/app.js"),
        "locales.json" => include_bytes!("../../public/locales.json"),
        "logo.png" => include_bytes!("../../public/logo.png"),
        "dump_to.svg" => include_bytes!("../../public/dump_to.svg"),
        "link.svg" => include_bytes!("../../public/link.svg"),
        _ => return not_found(),
    };
    ([(header::CONTENT_TYPE, mime.to_string())], body).into_response()
}

async fn fallback(req: Request) -> Response {
    let path = req.uri().path().to_string();
    if path.starts_with("/api/") {
        return not_found();
    }
    // SPA 兜底:未知路径回首页
    asset("index.html", "text/html; charset=utf-8")
}

async fn log_requests(req: Request, next: Next) -> Response {
    if cfg!(debug_assertions) || std::env::var_os("SKILLS_LINGO_VERBOSE").is_some() {
        eprintln!("[http] {} {}", req.method(), req.uri().path());
    }
    next.run(req).await
}

/* ---------- 跨源防护 ---------- */

async fn origin_guard(app: Arc<App>, req: Request, next: Next) -> Response {
    if req.method() != axum::http::Method::GET && !is_authorized_local(&app, req.headers()) {
        return err_json("forbidden_origin", "拒绝跨源状态变更请求", None, StatusCode::FORBIDDEN);
    }
    next.run(req).await
}

fn is_authorized_local(app: &App, headers: &HeaderMap) -> bool {
    let port = app.port.load(std::sync::atomic::Ordering::Relaxed);
    let allowed = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("::1:{port}"),
    ];
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default()
        .to_lowercase();
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    if !host.is_empty() && !allowed.contains(&host) {
        return false;
    }
    if let Some(origin) = headers.get("origin").and_then(|o| o.to_str().ok()) {
        let o = origin.to_lowercase();
        let origin_host = o
            .split_once("://")
            .map(|(_, rest)| rest.trim_start_matches('[').trim_end_matches(']').to_string())
            .unwrap_or_default();
        if !allowed.contains(&origin_host) {
            return false;
        }
    }
    true
}

/* ---------- 通用 ---------- */

fn err_json(code: &str, message: &str, params: Option<Value>, status: StatusCode) -> Response {
    let mut error = json!({ "code": code, "message": message });
    if let Some(p) = params {
        error["params"] = p;
    }
    (status, Json(json!({ "error": error }))).into_response()
}

fn not_found() -> Response {
    err_json("not_found", "资源不存在", None, StatusCode::NOT_FOUND)
}

fn pipeline_err(e: crate::pipeline::PipelineError) -> Response {
    let status = match e.code {
        "consent_required" => StatusCode::CONFLICT,
        "provider_unconfigured" => StatusCode::SERVICE_UNAVAILABLE,
        "doc_unreadable" | "bad_path" => StatusCode::NOT_FOUND,
        "bad_request" => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    err_json(e.code, &e.message, e.params, status)
}

fn parse_body(bytes: &Bytes) -> Value {
    if bytes.is_empty() {
        return json!({});
    }
    serde_json::from_slice(bytes).unwrap_or(json!({}))
}

fn current_entity(app: &App, id: &str) -> Option<Value> {
    let idx = app.cache.read_index()?;
    idx.get("entities")?
        .as_array()?
        .iter()
        .find(|e| e.get("id").and_then(|x| x.as_str()) == Some(id))
        .cloned()
}

/** 请求语言:?lang= 优先,否则服务端记住的界面语言(默认中文) */
fn request_lang(app: &App, query: Option<&HashMap<String, String>>) -> String {
    let from_query = query.and_then(|q| q.get("lang").map(|s| s.as_str()));
    if from_query.is_some() {
        return normalize_lang(from_query);
    }
    app.ui_language()
}

/** POST 请求语言:body.lang 优先,否则服务端记住的界面语言 */
fn body_lang(app: &App, payload: &Value) -> String {
    let from_body = payload.get("lang").and_then(|v| v.as_str());
    if from_body.is_some() {
        return normalize_lang(from_body);
    }
    app.ui_language()
}

/* ---------- GET 端点 ---------- */

async fn status(axum::extract::State(app): axum::extract::State<Arc<App>>) -> Response {
    let idx = app.cache.read_index();
    let mut state = app.cache.read_state();
    let translate_configured = app.translate_configured().await;
    let llm_configured = app.llm_configured().await;
    let ui_language = app.ui_language();
    if let Some(obj) = state.as_object_mut() {
        obj.insert("translateConfigured".into(), json!(translate_configured));
        obj.insert("llmConfigured".into(), json!(llm_configured));
        obj.insert("pipelineCalls".into(), json!(app.pipeline.provider.stats.calls()));
        obj.insert("pipelineCredits".into(), json!(app.pipeline.provider.stats.credits()));
    }
    let roots: Value = match &idx {
        Some(i) => i.get("roots").cloned().unwrap_or(Value::Null),
        None => json!(app.config.roots.iter().map(|r| json!({ "path": r.to_string_lossy() })).collect::<Vec<_>>()),
    };
    Json(json!({
        "phase": app.get_progress().await,
        "running": app.is_running().await,
        "hasIndex": idx.is_some(),
        "state": state,
        "config": {
            "roots": roots,
            "language": ui_language,
            "desktop": app.desktop,
            "providers": {
                "translate": { "name": app.config.translate.name, "configured": translate_configured },
                "llm": { "name": "openai-compat", "configured": llm_configured },
            },
        },
    }))
    .into_response()
}

fn entity_ref_of(e: &Value) -> EntityRef<'_> {
    EntityRef {
        id: e.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
        dir_name: e.get("dirName").and_then(|v| v.as_str()).unwrap_or_default(),
        description: e.get("description").and_then(|v| v.as_str()).unwrap_or_default(),
        content_hash: e.get("contentHash").and_then(|v| v.as_str()).unwrap_or_default(),
    }
}

fn card_of(app: &App, e: &Value, pending: &Map<String, Value>, lang: &str) -> Value {
    let mut roots_dedup: Vec<Value> = Vec::new();
    let mut seen_labels: Vec<String> = Vec::new();
    if let Some(arr) = e.get("appearances").and_then(|v| v.as_array()) {
        for ap in arr {
            let label = ap.get("rootLabel").and_then(|x| x.as_str()).unwrap_or_default().to_string();
            if !seen_labels.contains(&label) {
                seen_labels.push(label.clone());
                roots_dedup.push(json!({
                    "label": label,
                    "linked": ap.get("linked").and_then(|x| x.as_bool()).unwrap_or(false),
                }));
            }
        }
    }
    let copies_len = e.get("copies").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let dir_name = e.get("dirName").and_then(|v| v.as_str()).unwrap_or_default();
    let forked = e.get("forked").and_then(|v| v.as_bool()).unwrap_or(false);
    let version_label = e.get("versionLabel").and_then(|v| v.as_str());
    let display_name = match (forked, version_label) {
        (true, Some(vl)) => format!("{dir_name} · {vl}"),
        _ => dir_name.to_string(),
    };
    let attribution = e.get("attribution").filter(|a| a.is_object());
    let attribution_json = attribution.map(|a| {
        json!({
            "repo": a.get("repo").filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null),
            "method": a.get("method").filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null),
            "group": a.get("group").filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null),
            "sourceUrl": a.get("sourceUrl").filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null),
            "inferred": a.get("inferred").and_then(|x| x.as_bool()).unwrap_or(false),
            "confirmed": a.get("confirmed").and_then(|x| x.as_bool()).unwrap_or(false),
            "confidence": a.get("confidence").filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null),
            "upstream": a.get("upstream").filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null),
            "manual": a.get("manual").and_then(|x| x.as_bool()).unwrap_or(false),
        })
    });
    let confirmed = attribution
        .and_then(|a| a.get("confirmed").and_then(|x| x.as_bool()))
        .unwrap_or(false);
    let pending_json = match pending.get(e.get("id").and_then(|x| x.as_str()).unwrap_or_default()) {
        Some(p) if !p.is_null() && !confirmed => json!({
            "repo": p.get("repo").cloned().unwrap_or(Value::Null),
            "confidence": p.get("confidence").cloned().unwrap_or(Value::Null),
        }),
        _ => Value::Null,
    };
    // 概述按请求语言解析:非中文界面 = 语言缓存(未命中回退 frontmatter 描述)
    let er = entity_ref_of(e);
    let repo = attribution.and_then(|a| a.get("repo")).and_then(|x| x.as_str());
    let resolved = resolve_stored_summary(&er, repo, lang, &app.seeds, &app.cache)
        .unwrap_or_else(|| fallback_summary(&er, lang));
    // 一级分类按中文源归并(与界面语言无关);与 categories 按索引对应,供 chips 筛选。
    // 无标签卡(未配 LLM/生成失败)兜底 other:至少能在「其他」里被发现
    let mut l1_cats = l1_of(&source_categories(&er, repo, &app.seeds, &app.cache));
    if l1_cats.is_empty() {
        l1_cats.push("other");
    }
    json!({
        "id": e.get("id").cloned().unwrap_or(Value::Null),
        "dirName": dir_name,
        "name": e.get("name").cloned().unwrap_or(Value::Null),
        "displayName": display_name,
        "description": e.get("description").cloned().unwrap_or(Value::Null),
        "summary": resolved.summary,
        "summarySource": resolved.summary_source,
        "categories": resolved.categories,
        "categoriesL1": l1_cats,
        "roots": roots_dedup,
        "copyCount": 1 + copies_len,
        "forked": forked,
        "versionLabel": version_label,
        "entryLanguage": e.get("entryLanguage").cloned().unwrap_or(Value::Null),
        "docCount": e.get("docs").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
        "attribution": attribution_json,
        "pendingInference": pending_json,
    })
}

fn grouped_skills(app: &App, idx: &Value, lang: &str) -> Vec<Value> {
    let pending = last_inference_map(Some(idx));
    let mut group_order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, (u64, Option<String>, Vec<(Option<String>, Vec<Value>)>)> = HashMap::new();
    if let Some(entities) = idx.get("entities").and_then(|v| v.as_array()) {
        for e in entities {
            let repo = e.pointer("/attribution/repo").and_then(|v| v.as_str()).map(|s| s.to_string());
            let Some(repo) = repo else { continue };
            if !groups.contains_key(&repo) {
                group_order.push(repo.clone());
                groups.insert(repo.clone(), (0, None, Vec::new()));
            }
            let entry = groups.get_mut(&repo).unwrap();
            entry.0 += 1;
            if entry.1.is_none() {
                entry.1 = e.pointer("/attribution/sourceUrl").and_then(|v| v.as_str()).map(|s| s.to_string());
            }
            let sg_name = e.pointer("/attribution/group").and_then(|v| v.as_str()).map(|s| s.to_string());
            let card = card_of(app, e, &pending, lang);
            match entry.2.iter_mut().find(|(n, _)| *n == sg_name) {
                Some((_, list)) => list.push(card),
                None => entry.2.push((sg_name, vec![card])),
            }
        }
    }

    let mut out: Vec<(String, u64, Value)> = group_order
        .into_iter()
        .map(|repo| {
            let (count, source_url, subgroups) = groups.remove(&repo).unwrap();
            let mut sgs = subgroups;
            sgs.sort_by(|a, b| match (&a.0, &b.0) {
                (None, _) => std::cmp::Ordering::Greater,
                (_, None) => std::cmp::Ordering::Less,
                (Some(x), Some(y)) => x.cmp(y),
            });
            // repo 名含 '/',JSON pointer 无法寻址,用 get 链取
            // 中文界面用手写种子简介;其它语言用翻译缓存(分析阶段生成)
            let repo_summary = if lang == "zh" {
                app.seeds
                    .get("sources")
                    .and_then(|s| s.get(&repo))
                    .and_then(|s| s.get("repoSummary"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string()
            } else {
                resolve_repo_summary(&repo, lang, &app.seeds, &app.cache)
            };
            (
                repo.clone(),
                count,
                json!({
                    "key": repo,
                    "repo": repo,
                    "name": repo,
                    "sourceUrl": source_url,
                    "repoSummary": repo_summary,
                    "subgroups": sgs.into_iter().map(|(name, skills)| json!({
                        "name": name,
                        "skills": skills,
                    })).collect::<Vec<_>>(),
                    "count": count,
                }),
            )
        })
        .collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let unknown: Vec<Value> = idx
        .get("entities")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|e| e.pointer("/attribution/repo").map(|r| r.is_null()).unwrap_or(true))
                .map(|e| card_of(app, e, &pending, lang))
                .collect()
        })
        .unwrap_or_default();
    let mut result: Vec<Value> = out.into_iter().map(|x| x.2).collect();
    if !unknown.is_empty() {
        // 组名/简介带词条键:前端按界面语言渲染(中文「自由技能」/英文 "Standalone skills")
        result.push(json!({
            "key": "__unknown__",
            "repo": null,
            "name": "自由技能",
            "nameKey": "group.unknown",
            "sourceUrl": null,
            "repoSummary": "未找到安装记录、git 远端或 frontmatter 来源的技能。可手动归组或配置 LLM 后推断。",
            "repoSummaryKey": "group.unknownHint",
            "subgroups": [{ "name": null, "skills": unknown }],
            "count": unknown.len(),
        }));
    }
    result
}

/** 索引里的 lastInference → pendingInference 查找表 */
fn last_inference_map(idx: Option<&Value>) -> Map<String, Value> {
    idx.and_then(|i| i.get("lastInference"))
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

async fn skills_list(
    axum::extract::State(app): axum::extract::State<Arc<App>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(idx) = app.cache.read_index() else {
        return err_json("no_index", "尚未完成首次分析", None, StatusCode::SERVICE_UNAVAILABLE);
    };
    let lang = request_lang(&app, Some(&params));
    let pending = last_inference_map(Some(&idx));
    let cards: Vec<Value> = idx
        .get("entities")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(|e| card_of(&app, e, &pending, &lang)).collect())
        .unwrap_or_default();
    Json(json!({
        "scannedAt": idx.get("scannedAt").cloned().unwrap_or(Value::Null),
        "trigger": idx.get("trigger").cloned().unwrap_or(Value::Null),
        "language": lang,
        "summaryLang": idx.get("summaryLang").cloned().unwrap_or(json!("zh")),
        "roots": idx.get("roots").cloned().unwrap_or(json!([])),
        "stats": idx.get("stats").cloned().unwrap_or(json!({})),
        "groups": grouped_skills(&app, &idx, &lang),
        "skills": cards,
        "ignored": idx.get("ignored").cloned().unwrap_or(json!([])),
    }))
    .into_response()
}

async fn categories(
    axum::extract::State(app): axum::extract::State<Arc<App>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let idx = app.cache.read_index();
    let lang = request_lang(&app, Some(&params));
    // 一级分类按中文源归并计数(与界面语言无关);无标签卡计入 other 兜底
    let mut counts: HashMap<&str, u64> = HashMap::new();
    if let Some(arr) = idx.as_ref().and_then(|i| i.get("entities")).and_then(|v| v.as_array()) {
        for e in arr {
            let er = entity_ref_of(e);
            let repo = e.pointer("/attribution/repo").and_then(|v| v.as_str());
            let cats = source_categories(&er, repo, &app.seeds, &app.cache);
            if cats.is_empty() {
                *counts.entry("other").or_insert(0) += 1;
                continue;
            }
            let mut seen = HashSet::new();
            for l1 in l1_of(&cats) {
                if seen.insert(l1) {
                    *counts.entry(l1).or_insert(0) += 1;
                }
            }
        }
    }
    let list: Vec<Value> = L1_ORDER
        .iter()
        .filter(|id| counts.contains_key(*id))
        .map(|id| json!({ "name": id, "count": counts[*id] }))
        .collect();
    Json(json!({
        "language": lang,
        "categories": list,
    }))
    .into_response()
}

/* ---------- 技能详情 / 文档 / 文件 ---------- */

async fn skill_detail(
    axum::extract::State(app): axum::extract::State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let id_re = regex::Regex::new(r"^[A-Za-z0-9_-]+$").unwrap();
    if !id_re.is_match(&id) {
        return not_found();
    }
    let Some(e) = current_entity(&app, &id) else {
        return err_json("not_found", "技能不存在", Some(json!({ "id": id })), StatusCode::NOT_FOUND);
    };
    let lang = request_lang(&app, Some(&params));
    let idx = app.cache.read_index();
    let pending = last_inference_map(idx.as_ref());
    let mut card = card_of(&app, &e, &Map::new(), &lang);
    let real_path = e.get("realPath").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    // 重新读 SKILL.md frontmatter(详情页展示)
    let fm = std::fs::read_to_string(std::path::Path::new(&real_path).join("SKILL.md"))
        .map(|raw| crate::frontmatter::parse_frontmatter(&raw).data)
        .unwrap_or_default();
    if let Some(obj) = card.as_object_mut() {
        obj.insert("realPath".into(), json!(real_path));
        obj.insert(
            "frontmatter".into(),
            if fm.is_empty() { Value::Null } else { Value::Object(fm) },
        );
        obj.insert("docs".into(), e.get("docs").cloned().unwrap_or(json!([])));
        obj.insert("images".into(), e.get("images").cloned().unwrap_or(json!([])));
        obj.insert("copies".into(), e.get("copies").cloned().unwrap_or(json!([])));
        obj.insert("contentHash".into(), e.get("contentHash").cloned().unwrap_or(Value::Null));
        obj.insert(
            "lastInference".into(),
            pending.get(&id).cloned().unwrap_or(Value::Null),
        );
    }
    Json(card).into_response()
}

fn safe_join(base: &str, rel: &str) -> Option<PathBuf> {
    if rel.contains('\0') {
        return None;
    }
    let base_p = std::path::Path::new(base);
    let full = crate::util::normalize_real_path(&base_p.join(rel));
    let norm_base = crate::util::normalize_real_path(base_p);
    if full != norm_base && !full.starts_with(&format!("{norm_base}\\")) {
        return None;
    }
    Some(base_p.join(rel))
}

async fn skill_doc(
    axum::extract::State(app): axum::extract::State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(e) = current_entity(&app, &id) else {
        return err_json("not_found", "技能不存在", Some(json!({ "id": id })), StatusCode::NOT_FOUND);
    };
    let rel_path = params.get("path").cloned().unwrap_or_else(|| "SKILL.md".to_string());
    let real_path = e.get("realPath").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let Some(safe) = safe_join(&real_path, &rel_path) else {
        return pipeline_err(crate::pipeline::PipelineError::with_params(
            "bad_path",
            format!("非法路径: {rel_path}"),
            json!({ "path": rel_path }),
        ));
    };
    let Ok(raw) = std::fs::read_to_string(&safe) else {
        return pipeline_err(crate::pipeline::PipelineError::with_params(
            "doc_unreadable",
            format!("文档不存在: {rel_path}"),
            json!({ "path": rel_path }),
        ));
    };
    let fm = crate::frontmatter::parse_frontmatter(&raw);
    let blocks = crate::translate_blocks::parse_blocks(&fm.body, 6000);
    Json(json!({
        "skillId": id,
        "path": rel_path,
        "language": crate::util::detect_language(&raw),
        "frontmatter": if fm.data.is_empty() { Value::Null } else { Value::Object(fm.data) },
        "blocks": blocks.iter().map(|b| json!({ "id": b.id, "type": b.kind, "markdown": b.text })).collect::<Vec<_>>(),
    }))
    .into_response()
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "md" => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn skill_file(
    axum::extract::State(app): axum::extract::State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(e) = current_entity(&app, &id) else {
        return err_json("not_found", "技能不存在", Some(json!({ "id": id })), StatusCode::NOT_FOUND);
    };
    let rel = params.get("path").cloned().unwrap_or_default();
    let real_path = e.get("realPath").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let Some(safe) = safe_join(&real_path, &rel) else {
        return err_json("not_found", &format!("文件不存在: {rel}"), Some(json!({ "path": rel })), StatusCode::NOT_FOUND);
    };
    let Ok(meta) = std::fs::metadata(&safe) else {
        return err_json("not_found", &format!("文件不存在: {rel}"), Some(json!({ "path": rel })), StatusCode::NOT_FOUND);
    };
    if !meta.is_file() {
        return err_json("not_found", &format!("文件不存在: {rel}"), Some(json!({ "path": rel })), StatusCode::NOT_FOUND);
    }
    let Ok(body) = std::fs::read(&safe) else {
        return err_json("not_found", &format!("文件不存在: {rel}"), Some(json!({ "path": rel })), StatusCode::NOT_FOUND);
    };
    let ext = safe
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime_of(&ext).to_string()),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        body,
    )
        .into_response()
}

/* ---------- 翻译端点 ---------- */

async fn skill_translate(
    axum::extract::State(app): axum::extract::State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    translate_or_retry(app, id, body, false).await
}

/// 渐进拉取:翻译进行中返回已落盘的部分结果(块级 status),供查看器增量渲染。
/// started = 该文档正在翻译(POST 尚未返回);blocks 为 null 表示首包尚未完成。
async fn skill_translate_get(
    axum::extract::State(app): axum::extract::State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(e) = current_entity(&app, &id) else {
        return err_json("not_found", "技能不存在", Some(json!({ "id": id })), StatusCode::NOT_FOUND);
    };
    let doc_path = params.get("path").cloned().unwrap_or_else(|| "SKILL.md".into());
    let real_path = e.get("realPath").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let raw = match std::fs::read_to_string(std::path::Path::new(&real_path).join(&doc_path)) {
        Ok(r) => r,
        Err(_) => return err_json("doc_unreadable", "文档不存在", Some(json!({ "path": doc_path })), StatusCode::NOT_FOUND),
    };
    let lang = request_lang(&app, Some(&params));
    let entry = app.pipeline.cached_translation(&id, &lang, &crate::util::sha1_hex(&raw));
    let blocks = entry.as_ref().and_then(|v| v.get("blocks")).cloned().unwrap_or(Value::Null);
    let arr = blocks.as_array();
    let is_status = |want: &str, b: &&Value| b.get("status").and_then(|s| s.as_str()) == Some(want);
    let partial = arr.map(|a| a.iter().any(|b| is_status("pending", &b))).unwrap_or(false);
    let dp = app.pipeline.doc_progress();
    let started = dp
        .as_ref()
        .map(|p| {
            p.get("skillId").and_then(|v| v.as_str()) == Some(&id)
                && p.get("doc").and_then(|v| v.as_str()) == Some(&doc_path)
        })
        .unwrap_or(false);
    // started 时优先用管线真值:单包文档首包=末包,落盘前 blocks 为 null。
    // 进度以「包」计:与接口调用一一对应(完成包数 = 文档级 calls)
    let dp_field = |name: &str| dp.as_ref().and_then(|p| p.get(name).cloned()).unwrap_or(json!(0));
    let done = if started {
        dp_field("callsDone")
    } else {
        entry.as_ref().and_then(|v| v.get("calls").cloned()).unwrap_or(json!(0))
    };
    let total = if started {
        dp_field("callsTotal")
    } else {
        entry.as_ref().and_then(|v| v.get("calls").cloned()).unwrap_or(json!(0))
    };
    let credits_estimated = if started {
        dp_field("creditsEstimated")
    } else {
        entry.as_ref().and_then(|v| v.get("credits").cloned()).unwrap_or(json!(0))
    };
    Json(json!({
        "started": started,
        "partial": partial,
        "done": done,
        "total": total,
        "creditsEstimated": credits_estimated,
        "blocks": blocks,
    }))
    .into_response()
}

async fn skill_retry(
    axum::extract::State(app): axum::extract::State<Arc<App>>,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    translate_or_retry(app, id, body, true).await
}

async fn translate_or_retry(app: Arc<App>, id: String, body: Bytes, retry: bool) -> Response {
    let Some(e) = current_entity(&app, &id) else {
        return err_json("not_found", "技能不存在", Some(json!({ "id": id })), StatusCode::NOT_FOUND);
    };
    let payload = parse_body(&body);
    let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("SKILL.md").to_string();
    let state = app.cache.read_state();
    let consented = state.get("consentTranslate").and_then(|v| v.as_bool()).unwrap_or(false);
    let lang = body_lang(&app, &payload);
    let real_path = e.get("realPath").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let api_key = app.translate_key().await;

    let calls0 = app.pipeline.provider.stats.calls();
    let credits0 = app.pipeline.provider.stats.credits();
    let result = if retry {
        app.pipeline.retry_failed(&id, std::path::Path::new(&real_path), &path, &api_key, consented, &lang).await
    } else {
        app.pipeline.ensure_translation(&id, std::path::Path::new(&real_path), &path, &api_key, consented, &lang).await
    };
    // 翻译调用后把本次增量(次数/积分)实时累计进 state
    let d_calls = app.pipeline.provider.stats.calls().saturating_sub(calls0);
    let d_credits = app.pipeline.provider.stats.credits().saturating_sub(credits0);
    if d_calls > 0 {
        let mut st = app.cache.read_state();
        if let Some(obj) = st.as_object_mut() {
            let api_calls = obj.get("apiCalls").and_then(|v| v.as_u64()).unwrap_or(0) + d_calls;
            let credits = obj.get("creditsUsed").and_then(|v| v.as_u64()).unwrap_or(0) + d_credits;
            obj.insert("apiCalls".into(), json!(api_calls));
            obj.insert("creditsUsed".into(), json!(credits));
        }
        app.cache.write_state(&st);
    }
    match result {
        Ok(v) => Json(v).into_response(),
        Err(err) => pipeline_err(err),
    }
}

/* ---------- 状态变更端点 ---------- */

async fn consent(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    let accept = payload.get("accept").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut state = app.cache.read_state();
    let ui_language = app.ui_language();
    if let Some(obj) = state.as_object_mut() {
        obj.insert("consentTranslate".into(), json!(accept));
    }
    app.cache.write_state(&state);
    if accept && !app.is_running().await {
        let app2 = app.clone();
        tokio::spawn(async move {
            app2.run_analysis("consent", Some(ui_language)).await;
        });
    }
    Json(json!({ "ok": true, "consentTranslate": accept })).into_response()
}

async fn clear_warnings(axum::extract::State(app): axum::extract::State<Arc<App>>) -> Response {
    let mut state = app.cache.read_state();
    if let Some(last) = state.get_mut("lastAnalysis").and_then(|v| v.as_object_mut()) {
        last.insert("errors".into(), json!([]));
    }
    app.cache.write_state(&state);
    Json(json!({ "ok": true })).into_response()
}

async fn analyze(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    let lang = body_lang(&app, &payload);
    if app.is_running().await {
        // 排队到当前轮之后(语言作为待办记录)
        let app2 = app.clone();
        tokio::spawn(async move {
            app2.run_analysis("manual", Some(lang)).await;
        });
        return Json(json!({ "ok": true, "started": false, "running": true })).into_response();
    }
    let app2 = app.clone();
    tokio::spawn(async move {
        app2.run_analysis("manual", Some(lang)).await;
    });
    Json(json!({ "ok": true, "started": true })).into_response()
}

fn extract_skill_ids(payload: &Value) -> Option<Vec<String>> {
    let arr = payload.get("skillIds")?.as_array()?;
    if arr.is_empty() {
        return None;
    }
    Some(arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
}

async fn apply_repo_overrides(app: &Arc<App>, payload: &Value, set_repo: bool) -> Vec<String> {
    let skill_ids = extract_skill_ids(payload).unwrap_or_default();
    let mut data = app.cache.read_overrides();
    let entries = data.get_mut("entries").and_then(|v| v.as_object_mut()).unwrap();
    for id in &skill_ids {
        let mut entry = entries.get(id).and_then(|v| v.as_object()).cloned().unwrap_or_default();
        if set_repo {
            let repo = payload.get("repo").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            entry.insert("repo".into(), json!(repo));
            if repo.is_empty() {
                entry.remove("confirmInference");
            }
        } else {
            entry.insert("confirmInference".into(), json!(true));
            entry.remove("repo");
        }
        entries.insert(id.clone(), Value::Object(entry));
    }
    app.cache.write_overrides(&data);
    skill_ids
}

async fn overrides(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    if extract_skill_ids(&payload).is_none() {
        return err_json("bad_request", "skillIds 必须为非空数组", None, StatusCode::BAD_REQUEST);
    }
    let skill_ids = apply_repo_overrides(&app, &payload, true).await;
    let lang = body_lang(&app, &payload);
    let idx = app.run_analysis("overrides", Some(lang.clone())).await;
    Json(json!({ "ok": true, "affected": skill_ids, "groups": grouped_skills(&app, &idx, &lang) })).into_response()
}

async fn confirm_inference(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    if extract_skill_ids(&payload).is_none() {
        return err_json("bad_request", "skillIds 必须为非空数组", None, StatusCode::BAD_REQUEST);
    }
    let skill_ids = apply_repo_overrides(&app, &payload, false).await;
    let lang = body_lang(&app, &payload);
    let idx = app.run_analysis("confirm", Some(lang.clone())).await;
    Json(json!({ "ok": true, "affected": skill_ids, "groups": grouped_skills(&app, &idx, &lang) })).into_response()
}

/* ---------- 桌面设置(托盘/自启;仅桌面模式有实际效果,--serve 下只读写文件) ---------- */

async fn desktop_settings_get(axum::extract::State(app): axum::extract::State<Arc<App>>) -> Response {
    Json(app.read_desktop_settings()).into_response()
}

async fn desktop_settings_set(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    let latest = app.apply_desktop_settings(&payload);
    // 桌面模式:同步应用开机自启
    if let Some(handle) = app.tauri_handle.get() {
        crate::apply_autostart(handle, &latest);
    }
    Json(latest).into_response()
}

/** 桌面 WebView2 不处理 target=_blank:前端拦截后经此端点交给系统默认浏览器(仅 http/https) */
async fn open_external(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    let url = payload.get("url").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
    let scheme = url.split(':').next().unwrap_or_default().to_lowercase();
    if scheme != "http" && scheme != "https" {
        return err_json("bad_request", "仅支持 http/https 链接", None, StatusCode::BAD_REQUEST);
    }
    let handle = match app.tauri_handle.get() {
        Some(h) => h.clone(),
        None => return err_json("no_window", "当前无桌面窗口", None, StatusCode::SERVICE_UNAVAILABLE),
    };
    use tauri_plugin_opener::OpenerExt;
    match handle.opener().open_url(url, None::<&str>) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => err_json("open_failed", &format!("打开外部链接失败: {err}"), None, StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/* ---------- 设置 ---------- */

async fn settings_state(app: &App) -> Value {
    let stored_t = app.creds.get("uapipro").await;
    let stored_l = app.creds.get("llm").await;
    let llm_saved = app.providers.get().await.get("llm").cloned().unwrap_or(Value::Null);
    let translate_configured = app.translate_configured().await;
    let llm_configured = app.llm_configured().await;
    json!({
        "translate": {
            "configured": translate_configured,
            "source": if stored_t.is_some() { json!("store") } else { Value::Null },
            "maskedKey": crate::util::mask_secret(stored_t.as_deref()),
        },
        "llm": {
            "configured": llm_configured,
            "source": if stored_l.is_some() { json!("store") } else { Value::Null },
            "maskedKey": crate::util::mask_secret(stored_l.as_deref()),
            "preset": llm_saved.get("preset").cloned().unwrap_or(Value::Null),
            "baseUrl": llm_saved.get("baseUrl").cloned().unwrap_or(json!("")),
            "model": llm_saved.get("model").cloned().unwrap_or(json!("")),
            "modelsCache": llm_saved.get("modelsCache").cloned().unwrap_or(json!({})),
        },
        "credentialStoreKind": app.creds.kind().await,
        "language": app.ui_language(),
        "presets": app.presets.get("presets").cloned().unwrap_or(json!([])),
    })
}

async fn settings(axum::extract::State(app): axum::extract::State<Arc<App>>) -> Response {
    Json(settings_state(&app).await).into_response()
}

/// 语言(界面文案与译文目标语言;桌面端托盘/标题也从这里读)
async fn settings_language(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    let lang = normalize_lang(
        payload
            .get("language")
            .and_then(|v| v.as_str())
            .or_else(|| payload.get("lang").and_then(|v| v.as_str())),
    );
    let mut state = app.cache.read_state();
    // 与 Node 对齐:state.uiLanguage !== lang(缺失视为变化,会触发一轮语言分析)
    let changed = match state.get("uiLanguage").and_then(|v| v.as_str()) {
        Some(stored) => stored != lang,
        None => true,
    };
    if let Some(obj) = state.as_object_mut() {
        obj.insert("uiLanguage".into(), json!(lang));
    }
    app.cache.write_state(&state);
    let idx = app.cache.read_index();
    // 首次升级(索引没有 summaryLang/metaVersion)或语言变化时补一轮增量分析:
    // 生成该语言的概述/分类/仓库简介缓存;分析进行中则排队到当前轮之后。
    let needs_analysis = changed
        || idx.is_none()
        || idx.as_ref().and_then(|i| i.get("summaryLang")).and_then(|v| v.as_str()) != Some(lang.as_str())
        || idx.as_ref().and_then(|i| i.get("metaVersion")).and_then(|v| v.as_i64()) != Some(SUMMARY_META_VERSION);
    let was_running = app.is_running().await;
    if needs_analysis {
        let app2 = app.clone();
        let lang2 = lang.clone();
        tokio::spawn(async move {
            app2.run_analysis("language", Some(lang2)).await;
        });
    }
    Json(json!({
        "ok": true,
        "language": lang,
        "changed": changed,
        "analysisStarted": needs_analysis && !was_running,
        "queued": needs_analysis && was_running,
    }))
    .into_response()
}

async fn settings_providers(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    if let Some(t) = payload.get("translate") {
        if let Some(key) = t.get("apiKey") {
            if key.is_null() {
                app.creds.delete("uapipro").await;
            } else if let Some(k) = key.as_str() {
                let k = k.trim();
                if !k.is_empty() {
                    let _ = app.creds.set("uapipro", k).await;
                }
            }
        }
    }
    if let Some(l) = payload.get("llm") {
        if let Some(key) = l.get("apiKey") {
            if key.is_null() {
                app.creds.delete("llm").await;
            } else if let Some(k) = key.as_str() {
                let k = k.trim();
                if !k.is_empty() {
                    let _ = app.creds.set("llm", k).await;
                }
            }
        }
        let preset = app
            .presets
            .get("presets")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.iter().find(|p| p.get("id") == l.get("preset")))
            .cloned();
        let mut patch = Map::new();
        if let Some(p) = &preset {
            patch.insert("preset".into(), p.get("id").cloned().unwrap_or(Value::Null));
        }
        // 用户显式填写的地址优先(预设仅作默认值,如中转站换地址);否则回落预设地址
        match l.get("baseUrl").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            Some(b) => { patch.insert("baseUrl".into(), json!(b)); }
            None => {
                if let Some(pb) = preset
                    .as_ref()
                    .filter(|p| p.get("id").and_then(|v| v.as_str()) != Some("custom"))
                    .and_then(|p| p.get("baseUrl").cloned())
                {
                    patch.insert("baseUrl".into(), pb);
                }
            }
        }
        if let Some(m) = l.get("model").and_then(|v| v.as_str()) {
            patch.insert("model".into(), json!(m.trim()));
        }
        app.providers.update_llm(Value::Object(patch)).await;
    }
    let mut analysis_started = false;
    if !app.is_running().await && (app.translate_configured().await || app.llm_configured().await) {
        let app2 = app.clone();
        let lang = app.ui_language();
        tokio::spawn(async move {
            app2.run_analysis("settings", Some(lang)).await;
        });
        analysis_started = true;
    }
    Json(json!({
        "ok": true,
        "analysisStarted": analysis_started,
        "settings": settings_state(&app).await,
    }))
    .into_response()
}

async fn settings_test_llm(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    let preset = app
        .presets
        .get("presets")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().find(|p| p.get("id") == payload.get("preset")))
        .cloned();
    let saved = app.providers.get().await.get("llm").cloned().unwrap_or(Value::Null);
    let body_base = payload
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let base_url = body_base
        .or_else(|| preset.as_ref().and_then(|p| p.get("baseUrl").and_then(|v| v.as_str()).map(|s| s.to_string())))
        .or_else(|| saved.get("baseUrl").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    let api_key = match payload
        .get("apiKey")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(k) => k,
        None => app.creds.get("llm").await.unwrap_or_default(),
    };
    let model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| saved.get("model").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    if base_url.is_empty() {
        return err_json("bad_request", "缺少 API 地址(选择预设或填写自定义地址)", None, StatusCode::BAD_REQUEST);
    }
    let result = crate::connectivity::test_llm(&base_url, &api_key, &model).await;
    // 测试通过且拿到模型列表 → 按服务商落盘缓存(与 Node api.js llmProviderKey 同构):重启后候选仍以实测为准
    if result.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        let models: Vec<String> = result
            .get("models")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if !models.is_empty() {
            let preset_id = preset
                .as_ref()
                .and_then(|p| p.get("id").and_then(|v| v.as_str()))
                .unwrap_or("custom");
            app.providers
                .update_models_cache(&format!("{preset_id}|{base_url}"), models)
                .await;
        }
    }
    Json(result).into_response()
}

async fn settings_test_translate(axum::extract::State(app): axum::extract::State<Arc<App>>, body: Bytes) -> Response {
    let payload = parse_body(&body);
    let api_key = match payload
        .get("apiKey")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(k) => k,
        None => app.creds.get("uapipro").await.unwrap_or_default(),
    };
    let full = payload.get("full").and_then(|v| v.as_bool()).unwrap_or(false);
    let lang = body_lang(&app, &payload);
    let result = crate::connectivity::test_translate(
        &app.config.translate.endpoint,
        &api_key,
        full,
        &lang,
        &app.config.translate.style,
        &app.config.translate.context,
    )
    .await;
    Json(result).into_response()
}
