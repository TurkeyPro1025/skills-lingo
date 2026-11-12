//! 应用状态容器 + 分析编排(与 Node analyze.js 对齐):
//! 扫描 → 归属(瀑布) → 概述(种子→缓存→LLM→降级;非中文界面=描述+翻译元数据) → 入口文档预翻译(仅手动触发)。

use crate::attribution::{self, Attribution, Manifests, ResolveCtx};
use crate::cache::Cache;
use crate::config::Config;
use crate::credentials::CredentialStore;
use crate::llm::{self, LlmConfig, LlmProvider};
use crate::pipeline::Pipeline;
use crate::providers::ProviderSettings;
use crate::scanner::{self, Entity};
use crate::summaries::{
    fallback_summary, resolve_stored_summary, Card, EntityRef, SUMMARY_META_VERSION,
};
use crate::summary_translate::localize_summaries;
use crate::util::now_iso;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct App {
    pub config: Config,
    pub cache: Cache,
    pub creds: CredentialStore,
    pub providers: ProviderSettings,
    pub pipeline: Arc<Pipeline>,
    pub llm: LlmProvider,
    pub seeds: Value,
    pub presets: Value,
    pub analyzer: AnalyzerState,
    pub port: std::sync::atomic::AtomicU16,
    /// 桌面(Tauri 窗口)模式标记;--serve 模式为 false
    pub desktop: bool,
    /// 桌面设置:{ autostart, closeToExit }——同步锁,关窗事件(同步上下文)也要读
    pub desktop_settings: std::sync::RwLock<Value>,
    /// Tauri 句柄(窗口模式 setup 时注入,用于应用开机自启等)
    pub tauri_handle: std::sync::OnceLock<tauri::AppHandle>,
}

impl App {
    pub fn desktop_settings_file(&self) -> PathBuf {
        self.config.data_dir.join("desktop.json")
    }

    pub fn read_desktop_settings(&self) -> Value {
        self.desktop_settings.read().expect("desktop settings lock").clone()
    }

    pub fn desktop_close_to_exit(&self) -> bool {
        self.read_desktop_settings()
            .get("closeToExit")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    /// 更新桌面设置并落盘;返回最新值
    pub fn apply_desktop_settings(&self, patch: &Value) -> Value {
        let mut settings = self.desktop_settings.write().expect("desktop settings lock");
        if let Some(obj) = settings.as_object_mut() {
            if let Some(p) = patch.as_object() {
                for k in ["autostart", "closeToExit"] {
                    if let Some(v) = p.get(k).filter(|v| v.is_boolean()) {
                        obj.insert(k.to_string(), v.clone());
                    }
                }
            }
        }
        let _ = crate::util::write_json_atomic(&self.config.data_dir.join("desktop.json"), &settings);
        settings.clone()
    }

    /// 服务端记住的界面语言(摘要/译文目标语言)
    pub fn ui_language(&self) -> String {
        crate::languages::normalize_lang(self.cache.read_state().get("uiLanguage").and_then(|v| v.as_str()))
    }
}

#[derive(Default)]
pub struct AnalyzerState {
    pub progress: Mutex<Progress>,
    busy: tokio::sync::Mutex<()>,
    pub running: AtomicU64, // 0 = 空闲,>0 = 运行代数
    /// 分析进行中收到语言切换:等当前轮结束后按最新语言再跑一轮(增量,内容未变不调 API)
    pending_lang: Mutex<Option<String>>,
}

#[derive(Clone, Default, serde::Serialize)]
pub struct Stage {
    pub id: String,
    pub status: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Clone, Default)]
pub struct Progress {
    pub phase: String,
    pub code: Option<String>,
    pub params: Value,
    pub done: u64,
    pub total: u64,
    pub detail: String,
    pub started_at: Option<String>,
    pub errors: Vec<Value>,
    /// 任务面板阶段清单(顺序即执行序);status ∈ pending/running/done/skipped
    pub stages: Vec<Stage>,
}

/// 阶段 id 固定表,与 Node analyze.js 的 STAGE_IDS 一致
const STAGE_IDS: [&str; 6] = ["scan", "infer", "attribute", "summarize", "translateMeta", "pretranslate"];

impl Progress {
    fn to_json(&self) -> Value {
        json!({
            "phase": if self.phase.is_empty() { "idle" } else { self.phase.as_str() },
            "code": self.code,
            "params": self.params,
            "done": self.done,
            "total": self.total,
            "detail": self.detail,
            "startedAt": self.started_at,
            "errors": self.errors,
            "stages": self.stages,
        })
    }

    fn stage(&mut self, phase: &str, code: &str, params: Value, detail: impl Into<String>) {
        self.phase = phase.into();
        self.code = Some(code.into());
        self.params = params;
        let detail: String = detail.into();
        self.detail = detail;
    }

    fn stage_reset(&mut self) {
        self.stages = STAGE_IDS
            .iter()
            .map(|id| Stage { id: (*id).to_string(), status: "pending".into(), done: 0, total: 0 })
            .collect();
    }

    fn stage_status(&mut self, id: &str, status: &str) {
        if let Some(s) = self.stages.iter_mut().find(|s| s.id == id) {
            s.status = status.to_string();
        }
    }

    fn stage_progress(&mut self, id: &str, done: u64, total: Option<u64>) {
        if let Some(s) = self.stages.iter_mut().find(|s| s.id == id) {
            s.done = done;
            if let Some(t) = total {
                s.total = t;
            }
        }
    }

    fn stage_tick(&mut self, id: &str) {
        if let Some(s) = self.stages.iter_mut().find(|s| s.id == id) {
            s.done += 1;
        }
    }
}

/// 分析警告:code + params 供前端语言包渲染,message 保留中文回退
fn warn(progress: &mut Progress, code: &str, params: Value, message: String) {
    progress.errors.push(json!({ "code": code, "params": params, "message": message }));
}

impl App {
    pub async fn llm_config(&self) -> LlmConfig {
        let p = self.providers.get().await;
        let llm = p.get("llm").cloned().unwrap_or(Value::Null);
        LlmConfig {
            base_url: llm.get("baseUrl").and_then(|v| v.as_str()).unwrap_or_default().trim_end_matches('/').to_string(),
            api_key: self.creds.get("llm").await.unwrap_or_default(),
            model: llm.get("model").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        }
    }

    pub async fn translate_key(&self) -> String {
        self.creds.get("uapipro").await.unwrap_or_default()
    }

    pub async fn llm_configured(&self) -> bool {
        LlmProvider::configured(&self.llm_config().await)
    }

    pub async fn translate_configured(&self) -> bool {
        let key = self.translate_key().await;
        self.pipeline.provider.configured(&key)
    }

    /// 触发一轮分析(目标语言 = 显式传入,否则服务端记住的界面语言)。
    /// 若已在运行,记录语言待办并等待当轮结束后返回其索引(与 Node 单飞语义等价)。
    pub async fn run_analysis(&self, trigger: &str, lang: Option<String>) -> Value {
        let requested = lang.map(|l| crate::languages::normalize_lang(Some(&l)));
        if let Ok(_permit) = self.analyzer.busy.try_lock() {
            self.analyzer.running.store(1, Ordering::SeqCst);
            let current_lang = requested.clone().unwrap_or_else(|| self.ui_language());
            let index = analyze(self, trigger, &current_lang).await;
            self.analyzer.running.store(0, Ordering::SeqCst);
            // 分析期间排队的语言切换:按最新语言再跑一轮(缓存增量,内容未变零调用)
            let mut finished_lang = current_lang;
            loop {
                let pending = self.analyzer.pending_lang.lock().await.take();
                match pending {
                    Some(next) if next != finished_lang => {
                        let _ = analyze(self, "language", &next).await;
                        finished_lang = next;
                    }
                    _ => break,
                }
            }
            index
        } else {
            if let Some(l) = requested {
                *self.analyzer.pending_lang.lock().await = Some(l);
            }
            let _guard = self.analyzer.busy.lock().await;
            self.cache.read_index().unwrap_or(Value::Null)
        }
    }

    pub async fn is_running(&self) -> bool {
        self.analyzer.running.load(Ordering::SeqCst) > 0
    }

    pub async fn get_progress(&self) -> Value {
        self.analyzer.progress.lock().await.to_json()
    }
}

fn entity_json(e: &Entity, attribution: &Attribution, summary: &str, summary_source: &str, categories: &[String]) -> Value {
    json!({
        "id": e.id,
        "realPath": e.real_path.to_string_lossy(),
        "dirName": e.dir_name,
        "name": e.name,
        "description": e.description,
        "entryLanguage": e.entry_language,
        "contentHash": e.content_hash,
        "docs": e.docs.iter().map(|d| json!({ "rel": d.rel, "size": d.size })).collect::<Vec<_>>(),
        "images": e.images,
        "forked": e.forked,
        "versionLabel": e.version_label,
        "appearances": e.appearances.iter().map(|a| json!({ "rootLabel": a.root_label, "linked": a.linked })).collect::<Vec<_>>(),
        "copies": e.copies.iter().map(|c| json!({
            "realPath": c.real_path.to_string_lossy(),
            "appearances": c.appearances.iter().map(|a| json!({ "rootLabel": a.root_label, "linked": a.linked })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "attribution": attribution.to_json(),
        "summary": summary,
        "summarySource": summary_source,
        "categories": categories,
    })
}

fn entity_ref_of(e: &Entity) -> EntityRef<'_> {
    EntityRef {
        id: &e.id,
        dir_name: &e.dir_name,
        description: &e.description,
        content_hash: &e.content_hash,
    }
}

fn enrich_body_preview(e: &mut Entity) {
    let skill_md = e.real_path.join("SKILL.md");
    let raw = match std::fs::read_to_string(&skill_md) {
        Ok(r) => r,
        Err(_) => return,
    };
    let fm = crate::frontmatter::parse_frontmatter(&raw);
    e.body_preview = fm.body.chars().take(4000).collect();
}

async fn analyze(app: &App, trigger: &str, lang: &str) -> Value {
    let mut progress = Progress {
        phase: "scan".into(),
        code: Some("progress.scanning".into()),
        params: json!({}),
        done: 0,
        total: 0,
        detail: "扫描技能根目录…".into(),
        started_at: Some(now_iso()),
        errors: Vec::new(),
        stages: Vec::new(),
    };
    progress.stage_reset();
    progress.stage_status("scan", "running");
    *app.analyzer.progress.lock().await = progress.clone();

    let usage0_calls = app.pipeline.provider.stats.calls();
    let usage0_credits = app.pipeline.provider.stats.credits();

    let overrides = app.cache.read_overrides();
    let overrides_entries = overrides.get("entries").cloned().unwrap_or(json!({}));

    // 清单:解析所有 lock 文件
    let mut manifests: Manifests = HashMap::new();
    for file in &app.config.lock_files.clone() {
        match attribution::read_manifest(file) {
            Some((_, entries)) => {
                manifests.insert(file.clone(), entries);
            }
            None => warn(
                &mut progress,
                "warning.manifest_unreadable",
                json!({ "file": file.to_string_lossy() }),
                format!("清单未识别或不可读: {}", file.display()),
            ),
        }
    }
    let mut known_repos: Vec<String> = Vec::new();
    for m in manifests.values() {
        for e in m.values() {
            if !e.repo.is_empty() && !known_repos.contains(&e.repo) {
                known_repos.push(e.repo.clone());
            }
        }
    }

    // 扫描(阻塞文件 IO 放线程池)
    let roots = app.config.roots.clone();
    let scan_result = tokio::task::spawn_blocking(move || scanner::scan(&roots))
        .await
        .unwrap_or_else(|_| scanner::ScanResult { entities: Vec::new(), ignored: Vec::new(), scanned_at: now_iso() });
    progress.stage_status("scan", "done");
    progress.stage_progress("scan", scan_result.entities.len() as u64, Some(scan_result.entities.len() as u64));
    *app.analyzer.progress.lock().await = progress.clone();

    progress.stage("attribute", "progress.attributingStart", json!({}), "归属分析…");
    progress.total = scan_result.entities.len() as u64;
    let mut entities = scan_result.entities;
    for e in entities.iter_mut() {
        enrich_body_preview(e);
    }

    let mut upstreams: HashMap<String, (String, String)> = HashMap::new();
    for e in &entities {
        if let Some(url) = attribution::find_source_url(&e.frontmatter) {
            upstreams.insert(e.dir_name.clone(), (url.clone(), attribution::repo_from_url(&url)));
        }
    }

    // LLM 推断(负结果也缓存:内容未变不再烧调用)
    let empty_inference: HashMap<String, Option<Attribution>> = HashMap::new();
    let base_ctx = ResolveCtx {
        manifests: &manifests,
        known_repos: &known_repos,
        upstreams: &upstreams,
        last_inference: &empty_inference,
    };
    let mut last_inference: HashMap<String, Option<Attribution>> = HashMap::new();

    let prev_index = app.cache.read_index();
    let prev_entities: HashMap<String, String> = prev_index
        .as_ref()
        .and_then(|v| v.get("entities").and_then(|x| x.as_array()).cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let id = e.get("id")?.as_str()?.to_string();
                    let hash = e.get("contentHash").and_then(|h| h.as_str()).unwrap_or_default().to_string();
                    Some((id, hash))
                })
                .collect()
        })
        .unwrap_or_default();
    let prev_inference: Map<String, Value> = prev_index
        .as_ref()
        .and_then(|v| v.get("lastInference").and_then(|x| x.as_object()).cloned())
        .unwrap_or_default();
    // 增量缓存:上次分析中断前已落盘的推断(hash 内嵌,优先于 index.lastInference——
    // 中断轮不会重写 entities,后者对新实体的 hash 校验必然落空)
    let incremental: Map<String, Value> = app
        .cache
        .read_inference()
        .get("entries")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let llm_cfg = app.llm_config().await;
    progress.stage_status("infer", if llm::LlmProvider::configured(&llm_cfg) { "running" } else { "skipped" });
    if llm::LlmProvider::configured(&llm_cfg) {
        for e in &entities {
            let o = overrides_entries.get(&e.id).and_then(|v| v.as_object());
            if o.map(|x| x.contains_key("repo")).unwrap_or(false) {
                continue; // 手动已归组
            }
            let base = attribution::resolve(e, &base_ctx, &overrides_entries, &app.config.lock_files);
            if base.repo.is_some() {
                continue;
            }
            if let Some(inc) = incremental.get(&e.id) {
                if inc.get("hash").and_then(|v| v.as_str()) == Some(e.content_hash.as_str()) {
                    last_inference.insert(
                        e.id.clone(),
                        attribution_from_index(inc.get("result").unwrap_or(&Value::Null)),
                    );
                    progress.stage_tick("infer");
                    continue;
                }
            }
            if let Some(prev) = prev_inference.get(&e.id) {
                if prev_entities.get(&e.id).map(|h| h == &e.content_hash).unwrap_or(false) {
                    last_inference.insert(
                        e.id.clone(),
                        attribution_from_index(prev),
                    );
                    progress.stage_tick("infer");
                    continue;
                }
            }
            progress.stage("attribute", "progress.inferring", json!({ "name": e.name }), format!("LLM 推断归属:{}", e.name));
            *app.analyzer.progress.lock().await = progress.clone();
            match app.llm.chat_json(&llm_cfg, &llm::build_inference_messages(e, &known_repos)).await {
                Ok(obj) => match llm::parse_inference(&obj) {
                    Some(parsed) => {
                        last_inference.insert(
                            e.id.clone(),
                            Some(Attribution {
                                repo: Some(parsed.repo),
                                source_url: None,
                                group: None,
                                method: Some("llm".into()),
                                inferred: true,
                                confidence: Some(parsed.confidence),
                                alternatives: parsed.alternatives,
                                confirmed: false,
                                upstream: base.upstream.clone(),
                                ..Default::default()
                            }),
                        );
                    }
                    None => {
                        last_inference.insert(e.id.clone(), None);
                    }
                },
                Err(err) => {
                    let msg: String = err.message.chars().take(120).collect();
                    warn(
                        &mut progress,
                        "warning.inference_failed",
                        json!({ "name": e.name, "error": msg }),
                        format!("LLM 推断失败({}): {}", e.name, msg),
                    );
                }
            }
            // 逐条实时落盘:后续阶段(概述/翻译)耗时更长,中途退出不白烧本次调用。
            // 调用失败(没有条目)不缓存,保留重试机会
            if let Some(v) = last_inference.get(&e.id) {
                let result_json = v.as_ref().map(|a| a.to_json()).unwrap_or(Value::Null);
                app.cache.append_inference(&e.id, &e.content_hash, &result_json);
            }
            progress.stage_tick("infer");
        }
    }
    if llm::LlmProvider::configured(&llm_cfg) {
        progress.stage_status("infer", "done");
    }

    // 最终遍:带推断结果与 overrides 走完整瀑布
    let ctx = ResolveCtx {
        manifests: &manifests,
        known_repos: &known_repos,
        upstreams: &upstreams,
        last_inference: &last_inference,
    };
    let mut attributions: HashMap<String, Attribution> = HashMap::new();
    progress.stage_status("attribute", "running");
    progress.stage_progress("attribute", 0, Some(entities.len() as u64));
    for (i, e) in entities.iter().enumerate() {
        progress.done = i as u64 + 1;
        progress.stage("attribute", "progress.attributing", json!({ "name": e.name }), format!("归属:{}", e.name));
        progress.stage_progress("attribute", i as u64 + 1, None);
        *app.analyzer.progress.lock().await = progress.clone();
        attributions.insert(e.id.clone(), attribution::resolve(e, &ctx, &overrides_entries, &app.config.lock_files));
    }
    progress.stage_status("attribute", "done");

    // 概述:中文界面走种子/LLM;其它语言 = 描述 + 翻译后的分类/仓库简介(写语言缓存)
    progress.phase = "summaries".into();
    progress.done = 0;
    progress.total = (entities.len() * 2) as u64;
    *app.analyzer.progress.lock().await = progress.clone();

    // 第一遍:保障中文概述缓存(任何界面语言都执行——新技能的分类标签由此产生,
    // 翻译阶段随后即可翻到;种子/缓存命中零调用,LLM 结果按 contentHash 落盘不重复调)
    let mut zh_cards: HashMap<String, Card> = HashMap::new();
    progress.stage_status("summarize", "running");
    progress.stage_progress("summarize", 0, Some((entities.len() * 2) as u64));
    for (i, e) in entities.iter().enumerate() {
        progress.done = i as u64 + 1;
        progress.stage("summaries", "progress.summarizing", json!({ "name": e.name }), format!("概述:{}", e.name));
        progress.stage_progress("summarize", i as u64 + 1, None);
        *app.analyzer.progress.lock().await = progress.clone();
        let a = attributions.get(&e.id).unwrap();
        if let Some(card) = ensure_zh_summary(app, e, a, &llm_cfg, &mut progress).await {
            zh_cards.insert(e.id.clone(), card);
        }
    }

    let api_key = app.translate_key().await;
    let provider_ready = app.pipeline.provider.configured(&api_key);
    let mut localized_cards: Option<HashMap<String, Card>> = None;
    progress.stage_status("translateMeta", "skipped");
    if lang != "zh" && provider_ready {
        let state = app.cache.read_state();
        if state.get("consentTranslate").and_then(|v| v.as_bool()).unwrap_or(false) {
            progress.stage_status("translateMeta", "running");
            progress.stage("summaries", "progress.translatingMeta", json!({}), "翻译概述/分类/仓库简介…");
            *app.analyzer.progress.lock().await = progress.clone();
            let refs: Vec<EntityRef<'_>> = entities.iter().map(entity_ref_of).collect();
            let repos: HashMap<String, Option<String>> = attributions
                .iter()
                .map(|(k, v)| (k.clone(), v.repo.clone()))
                .collect();
            if let Some(result) = localize_summaries(&refs, &repos, lang, &app.seeds, &app.cache, &app.pipeline, &api_key, true).await {
                if result.failed > 0 {
                    warn(
                        &mut progress,
                        "warning.meta_translate_failed",
                        json!({ "count": result.failed }),
                        format!("概述翻译失败 {} 项", result.failed),
                    );
                }
                localized_cards = Some(result.cards);
            }
            progress.stage_status("translateMeta", "done");
        }
    }

    // 第二遍:按界面语言出卡(纯读,不再调 LLM)
    let mut cards: HashMap<String, (String, String, Vec<String>)> = HashMap::new();
    for (i, e) in entities.iter().enumerate() {
        progress.done = entities.len() as u64 + i as u64 + 1;
        progress.stage_progress("summarize", entities.len() as u64 + i as u64 + 1, None);
        let card = resolve_card(e, lang, localized_cards.as_ref(), zh_cards.get(&e.id));
        cards.insert(e.id.clone(), (card.summary, card.summary_source.to_string(), card.categories));
    }
    progress.stage_status("summarize", "done");

    // 组装索引
    let lock_files_json: Vec<String> = app.config.lock_files.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let entities_json: Vec<Value> = entities
        .iter()
        .map(|e| {
            let (summary, source, categories) = cards.get(&e.id).cloned().unwrap_or_default();
            entity_json(e, attributions.get(&e.id).unwrap(), &summary, &source, &categories)
        })
        .collect();
    let linked_merged: u64 = entities.iter().map(|e| e.appearances.len().saturating_sub(1) as u64).sum();
    let attributed_count = attributions.values().filter(|a| a.repo.is_some()).count();
    // 与前端卡片 data-pending 同口径:已应用未确认 ∪ 未应用候选
    // (负结果推断缓存 value=None 无可确认项,不算;候选已有确认归属也不算)
    let mut pending_infer_ids: HashSet<&str> = attributions
        .iter()
        .filter(|(_, a)| a.inferred && !a.confirmed)
        .map(|(id, _)| id.as_str())
        .collect();
    pending_infer_ids.extend(
        last_inference
            .iter()
            .filter(|(id, cand)| {
                cand.is_some() && !attributions.get(*id).map(|a| a.confirmed).unwrap_or(false)
            })
            .map(|(id, _)| id.as_str()),
    );
    let inferred_count = pending_infer_ids.len();
    let last_inference_json: Map<String, Value> = last_inference
        .iter()
        .map(|(k, v)| (k.clone(), v.as_ref().map(|a| a.to_json()).unwrap_or(Value::Null)))
        .collect();

    let index = json!({
        "version": 1,
        "scannedAt": scan_result.scanned_at,
        "trigger": trigger,
        "summaryLang": lang,
        "metaVersion": SUMMARY_META_VERSION,
        "roots": app.config.roots.iter().map(|r| json!({
            "path": r.to_string_lossy(),
            "label": scanner::root_label_of(r),
        })).collect::<Vec<_>>(),
        "lockFiles": lock_files_json,
        "entities": entities_json,
        "ignored": scan_result.ignored,
        "lastInference": last_inference_json,
        "stats": {
            "entities": entities.len(),
            "attributed": attributed_count,
            "inferred": inferred_count,
            "linkedMerged": linked_merged,
        },
    });
    app.cache.write_index(&index);
    // 本轮推断结果已随 index.lastInference 落盘,增量缓存清空(避免文件无限增长)
    if llm::LlmProvider::configured(&llm_cfg) {
        app.cache.reset_inference();
    }

    // 入口文档预翻译:只在用户显式点「手动更新」时执行(知情、按需烧积分)。
    // 目标 = 当前界面语言:中文界面预翻英文入口,英文界面预翻中文入口。
    let state = app.cache.read_state();
    let consent = state.get("consentTranslate").and_then(|v| v.as_bool()).unwrap_or(false);
    if consent && trigger == "manual" && provider_ready {
        progress.phase = "pretranslate".into();
        let candidates: Vec<&Entity> = entities.iter().filter(|e| e.entry_language != lang).collect();
        progress.total = candidates.len() as u64;
        progress.done = 0;
        progress.stage_status("pretranslate", "running");
        progress.stage_progress("pretranslate", 0, Some(candidates.len() as u64));
        *app.analyzer.progress.lock().await = progress.clone();
        for e in &candidates {
            progress.done += 1;
            progress.stage("pretranslate", "progress.pretranslating", json!({ "name": e.name }), format!("预翻译:{}", e.name));
            progress.stage_progress("pretranslate", progress.done, None);
            *app.analyzer.progress.lock().await = progress.clone();
            if let Err(err) = app.pipeline.ensure_translation(&e.id, &e.real_path, "SKILL.md", &api_key, true, lang).await {
                if err.code != "provider_unconfigured" {
                    let msg: String = err.message.chars().take(120).collect();
                    warn(
                        &mut progress,
                        "warning.pretranslate_failed",
                        json!({ "name": e.name, "error": msg }),
                        format!("预翻译失败({}): {}", e.name, msg),
                    );
                }
            }
        }
        progress.stage_status("pretranslate", "done");
    }

    // 本轮未走到的阶段(如非手动触发的预翻译)标记为跳过
    for s in progress.stages.iter_mut() {
        if s.status == "pending" {
            s.status = "skipped".into();
        }
    }

    progress.stage(
        "done",
        "progress.done",
        json!({ "entities": index["stats"]["entities"], "attributed": index["stats"]["attributed"] }),
        &format!("完成:{} 个技能,归属 {} 个", entities.len(), attributed_count),
    );
    *app.analyzer.progress.lock().await = progress.clone();

    // 累计积分/调用数写入状态(增量)
    let mut next_state = app.cache.read_state();
    let errors_tail: Vec<Value> = progress.errors.iter().take(20).cloned().collect();
    next_state["lastAnalysis"] = json!({
        "at": now_iso(),
        "trigger": trigger,
        "entities": entities.len(),
        "errors": errors_tail,
    });
    let d_calls = app.pipeline.provider.stats.calls().saturating_sub(usage0_calls);
    let d_credits = app.pipeline.provider.stats.credits().saturating_sub(usage0_credits);
    if d_calls > 0 {
        let api_calls = next_state.get("apiCalls").and_then(|v| v.as_u64()).unwrap_or(0) + d_calls;
        let credits = next_state.get("creditsUsed").and_then(|v| v.as_u64()).unwrap_or(0) + d_credits;
        next_state["apiCalls"] = json!(api_calls);
        next_state["creditsUsed"] = json!(credits);
    }
    app.cache.write_state(&next_state);

    index
}

/// 保障中文概述缓存(种子 → 中文缓存 → LLM,任何界面语言都执行):
/// 命中即零调用;LLM 生成结果按 contentHash 落盘,内容未变不重复调。
/// 未配置 LLM / 生成失败返回 None(出卡时降级为描述,分类由 other 兜底)。
async fn ensure_zh_summary(
    app: &App,
    e: &Entity,
    attribution: &Attribution,
    llm_cfg: &LlmConfig,
    progress: &mut Progress,
) -> Option<Card> {
    let er = entity_ref_of(e);
    if let Some(stored) = resolve_stored_summary(&er, attribution.repo.as_deref(), "zh", &app.seeds, &app.cache) {
        return Some(stored);
    }
    if llm::LlmProvider::configured(llm_cfg) {
        match app.llm.chat_json(llm_cfg, &llm::build_summary_messages(e)).await {
            Ok(obj) => {
                if let Some(parsed) = llm::parse_summary(&obj) {
                    app.cache.write_skill(
                        &e.id,
                        "zh",
                        &json!({
                            "id": e.id,
                            "lang": "zh",
                            "contentHash": e.content_hash,
                            "summary": parsed.summary,
                            "summarySource": "llm",
                            "categories": parsed.categories,
                            "createdAt": now_iso(),
                        }),
                    );
                    return Some(Card {
                        summary: parsed.summary,
                        summary_source: "llm",
                        categories: parsed.categories,
                    });
                }
            }
            Err(err) => {
                let msg: String = err.message.chars().take(120).collect();
                warn(
                    progress,
                    "warning.summary_failed",
                    json!({ "name": e.name, "error": msg }),
                    format!("LLM 概述失败({}): {}", e.name, msg),
                );
            }
        }
    }
    None
}

/// 概述解析:中文界面走种子/缓存/LLM;其它语言用翻译后的描述/分类(翻译由 localize_summaries 预先生成)
/// 出卡(纯读):zh = 种子/缓存(ensure_zh_summary 已保障);其它语言 = 翻译缓存,未命中回退描述
fn resolve_card(
    e: &Entity,
    lang: &str,
    localized_cards: Option<&HashMap<String, Card>>,
    zh_card: Option<&Card>,
) -> Card {
    if lang != "zh" {
        if let Some(c) = localized_cards.and_then(|cards| cards.get(&e.id)) {
            return c.clone();
        }
        // 翻译不可用或失败:先原文直出(摘要 = frontmatter 描述)
        return fallback_summary(&entity_ref_of(e), lang);
    }
    zh_card.cloned().unwrap_or_else(|| fallback_summary(&entity_ref_of(e), "zh"))
}

fn attribution_from_index(v: &Value) -> Option<Attribution> {
    // JSON null = "推断不出"的负结果缓存,保持为 None(不能变成全空对象)
    if v.is_null() {
        return None;
    }
    Some(Attribution {
        repo: v.get("repo").and_then(|x| x.as_str()).map(|s| s.to_string()),
        method: v.get("method").and_then(|x| x.as_str()).map(|s| s.to_string()),
        source_url: v.get("sourceUrl").and_then(|x| x.as_str()).map(|s| s.to_string()),
        group: v.get("group").and_then(|x| x.as_str()).map(|s| s.to_string()),
        manifest: v.get("manifest").and_then(|x| x.as_str()).map(|s| s.to_string()),
        skill_folder_hash: v.get("skillFolderHash").and_then(|x| x.as_str()).map(|s| s.to_string()),
        installed_at: v.get("installedAt").and_then(|x| x.as_str()).map(|s| s.to_string()),
        inferred: v.get("inferred").and_then(|x| x.as_bool()).unwrap_or(false),
        confidence: v.get("confidence").and_then(|x| x.as_str()).map(|s| s.to_string()),
        confirmed: v.get("confirmed").and_then(|x| x.as_bool()).unwrap_or(false),
        upstream: v.get("upstream").filter(|x| !x.is_null()).cloned(),
        manual: v.get("manual").and_then(|x| x.as_bool()).unwrap_or(false),
        upstream_only: v.get("upstreamOnly").and_then(|x| x.as_bool()).unwrap_or(false),
        unknown: v.get("unknown").and_then(|x| x.as_bool()).unwrap_or(false),
        alternatives: v
            .get("alternatives")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|y| y.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
    })
}
