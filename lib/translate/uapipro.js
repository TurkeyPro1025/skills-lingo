'use strict';

/**
 * UApiPro (uapis.cn) AI 翻译适配器。
 * POST {endpoint}?target_lang={lang}  正文 { text, style, context, preserve_format }
 * 目标语言逐次传入(v1.2.0 跟随界面语言),配置里的 targetLang 仅作缺省回退。
 * 响应 data.translated_text。4 QPS 发射间隔 / 6 并发(官方上限 7,留 1 余量)/ 1 万字符/次 / 4 积分/次。
 * API key 只从注入的加密凭据存储读取(见 lib/credentials.js),不读环境变量,绝不落盘。
 */

const { createLimiter } = require('../util');

function createTranslateProvider(cfg, deps = {}) {
  const {
    endpoint,
    authHeader = 'Authorization',
    authPrefix = 'Bearer ',
    targetLang = 'zh',
    style = 'professional',
    context = 'technical',
    preserveFormat = true,
    maxCharsPerCall = 10000,
    qps = 4,
    concurrency = 6,
    creditsPerCall = 4,
    responseField = 'data.translated_text',
    timeoutMs = 60000,
  } = cfg;
  const keyGetter = deps.keyGetter || (() => ''); // 密钥只来自注入的加密存储,不读环境变量

  const gate = createLimiter(Math.ceil(1000 / qps), concurrency);
  const stats = { calls: 0, credits: 0, failures: 0 };

  function apiKey() {
    return keyGetter() || '';
  }

  function configured() {
    return Boolean(apiKey() && endpoint);
  }

  function pickResponseField(obj, fieldPath) {
    return fieldPath.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
  }

  /**
   * 翻译一段文本(≤ maxCharsPerCall 字符)。
   * targetLang 跟随界面语言(v1.2.0),缺省回落到配置里的默认语言。
   * @returns {Promise<{text: string, credits: number}>}
   */
  async function translateText(text, { targetLang: perCallLang } = {}) {
    if (text.length > maxCharsPerCall) {
      throw Object.assign(new Error(`文本超过单次上限(${text.length} > ${maxCharsPerCall} 字符),应由管线分块`), { code: 'too_long' });
    }
    return gate(async () => {
      const url = new URL(endpoint);
      url.searchParams.set('target_lang', perCallLang || targetLang);
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey()) headers[authHeader] = authPrefix + apiKey();

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text,
          style,
          context,
          preserve_format: preserveFormat,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      stats.calls++;
      stats.credits += creditsPerCall;

      if (!res.ok) {
        stats.failures++;
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 300);
        } catch { /* 忽略 */ }
        const err = new Error(`翻译服务返回 ${res.status}: ${detail}`);
        err.code = res.status === 429 ? 'rate_limited' : `http_${res.status}`;
        throw err;
      }
      const body = await res.json();
      const translated = pickResponseField(body, responseField);
      if (typeof translated !== 'string') {
        stats.failures++;
        throw new Error(`翻译服务响应缺少字段 ${responseField}`);
      }
      return { text: translated, credits: creditsPerCall };
    });
  }

  return {
    name: 'uapipro',
    configured,
    translateText,
    stats,
    get maxCharsPerCall() {
      return maxCharsPerCall;
    },
    get creditsPerCall() {
      return creditsPerCall;
    },
  };
}

module.exports = { createTranslateProvider };
