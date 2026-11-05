import { mask, unmaskSegments, missingPlaceholders, appendPlaceholders } from "./tokenizer.js";
import { TranslationCache } from "./cache.js";
import { TaskQueue } from "./queue.js";
import { getProvider } from "./providers/index.js";
import {
    FAILURE_BACKOFF_MS,
    FAILURE_RECORD_LIMIT,
    RATE_LIMIT_PAUSE_MS,
    MAX_RATE_LIMIT_PAUSE_MS,
    OVERLOAD_PAUSE_MS,
    TRANSIENT_RETRIES,
    TRANSIENT_RETRY_DELAY_MS,
    URGENT_TIMEOUT_MS,
} from "../constants.js";
import { t } from "../i18n.js";
import { logger } from "../lib/logger.js";

const skip = () => ({ status: "skip" });
const done = (text, segments) => ({ status: "done", text, segments });
const error = (message) => ({ status: "error", message });
const ALWAYS = () => true;

// Changing any of these can turn a request that was refused into one that works.
const UNBLOCKING = new Set(["provider", "apiKey", "model", "baseUrl", "targetLanguage", "outgoingLanguage"]);

const PROBE_TEXT = {
    en: "Hello, nice to meet you. See you tomorrow!",
    ko: "안녕하세요, 만나서 반가워요. 내일 봐요!",
};

export class Translator {
    constructor({ settings, onError }) {
        this._settings = settings;
        this._onError = onError || (() => {});
        this._cache = new TranslationCache();
        this._queue = new TaskQueue(() => this._settings.current.maxConcurrent);
        this._inflight = new Map();

        this._starts = new Map();
        this._failures = new Map();
        this._aborters = new Set();
        this._pausedUntil = 0;
        this._blocked = null;
        this._spacing = 0;
        this._nextSlot = 0;
        this._unsubscribe = null;
        this._stopped = false;
    }

    start() {
        this._stopped = false;
        this._pausedUntil = 0;
        this._blocked = null;
        this._cache.load();
        this._unsubscribe =
            this._settings.onChange?.((id) => {
                if (!UNBLOCKING.has(id)) return;
                this._blocked = null;
                this._spacing = 0;
            }) ?? null;
    }

    stop() {
        this._stopped = true;
        this._unsubscribe?.();
        this._unsubscribe = null;
        this._blocked = null;
        this._queue.clear();
        for (const controller of this._aborters) {
            try {
                controller.abort();
            } catch {}
        }
        this._aborters.clear();
        this._inflight.clear();
        this._starts.clear();
        this._failures.clear();
        this._cache.save();
    }

    get cacheSize() {
        return this._cache.size;
    }

    clearCache() {
        const cleared = this._cache.size;
        this._cache.clear();
        this._failures.clear();
        return cleared;
    }

    peek(text) {
        const { masked, tokens } = mask(text);
        const key = this._cacheKey(masked, this._settings.current.targetLanguage);
        if (this._cache.has(key)) return this._restore(this._cache.get(key), tokens);
        if (text.length > this._settings.current.maxChars) return skip();
        return { status: "unknown" };
    }

    isCached(text) {
        return this._cache.has(this._cacheKey(mask(text).masked, this._settings.current.targetLanguage));
    }

    forget(text) {
        this._cache.delete(this._cacheKey(mask(text).masked, this._settings.current.targetLanguage));
    }

    // A translation belongs to the model that produced it, and to the way it was asked for.
    _cacheKey(masked, language) {
        const { provider, model } = this._settings.current;
        const backend = getProvider(provider);
        const engine = model || backend.defaults.model;
        const source = backend.cacheVersion ? `${provider}.${backend.cacheVersion}` : provider;
        return `${source}\u0001${engine}\u0001${language}\u0001${masked}`;
    }

    remember(text, translation, language) {
        // A placeholder's number indexes the source's own token list, so a pair whose two
        // sides mask differently cannot be stored as one.
        if (mask(text).tokens.length || mask(translation).tokens.length) return;
        this._cache.set(this._cacheKey(text, language), translation);
    }

    translate(text, hooks = {}) {
        const { masked, tokens } = mask(text);
        const language = hooks.language || this._settings.current.targetLanguage;
        const key = this._cacheKey(masked, language);

        if (this._cache.has(key)) {
            return Promise.resolve(this._restore(this._cache.get(key), tokens));
        }

        if (text.length > this._settings.current.maxChars) return Promise.resolve(skip());

        if (hooks.ignoreBackoff) {
            this._failures.delete(key);
        } else {
            if (this._blocked) return Promise.resolve(error(this._blocked));
            if (this._isBackingOff(key)) return Promise.resolve(error(t("error.retryLater")));
        }

        if (hooks.onStart) this._onStart(key, hooks.onStart);

        const shouldRun = hooks.shouldRun ?? ALWAYS;
        let job = this._inflight.get(key);
        if (job) {
            job.waiters.add(shouldRun);
        } else {
            job = this._enqueue(key, masked, language, shouldRun, hooks.urgent === true);
            this._inflight.set(key, job);
        }

        return job.promise.then((outcome) =>
            outcome.status === "done" ? this._restore(outcome.masked, tokens) : outcome,
        );
    }

    // Several blocks can wait on one request, so it is only pointless once none of them wants it.
    _enqueue(key, masked, language, shouldRun, urgent) {
        const waiters = new Set([shouldRun]);
        const wanted = () => [...waiters].some((waiter) => waiter());
        const promise = this._queue
            .run(
                async () => {
                    if (!urgent) {
                        await this._awaitResume();
                        // A paced slot is seconds long; one reserved for a message scrolled
                        // away during the pause delays every message still on screen.
                        if (!wanted()) throw skipped();
                        await this._awaitSlot();
                    }
                    if (this._stopped) throw aborted();
                    if (!wanted()) throw skipped();
                    this._announceStart(key);
                    return this._callWithRetries(masked, language, urgent);
                },
                wanted,
                { urgent },
            )
            .then(
                (raw) => this._resolveSuccess(key, masked, raw),
                (err) => this._resolveFailure(key, err),
            )
            .finally(() => {
                this._inflight.delete(key);
                this._starts.delete(key);
            });
        return { waiters, promise };
    }

    async probe() {
        const { targetLanguage } = this._settings.current;
        const sample = targetLanguage === "en" ? PROBE_TEXT.ko : PROBE_TEXT.en;
        try {
            const raw = await this._callProvider(sample, targetLanguage, URGENT_TIMEOUT_MS);
            this._blocked = null;
            return { ok: true, text: stripWrappingQuotes(raw, sample).trim() };
        } catch (err) {
            logger.warn("connection test failed:", (err && err.message) || err);
            return { ok: false, message: describe(err) };
        }
    }

    _onStart(key, listener) {
        const waiting = this._starts.get(key);
        if (waiting === true) return listener();
        if (waiting) waiting.add(listener);
        else this._starts.set(key, new Set([listener]));
    }

    _announceStart(key) {
        const waiting = this._starts.get(key);
        this._starts.set(key, true);
        if (waiting === true || !waiting) return;
        for (const listener of waiting) {
            try {
                listener();
            } catch {}
        }
    }

    _restore(maskedValue, tokens) {
        if (typeof maskedValue !== "string") return skip();
        const segments = unmaskSegments(maskedValue, tokens);
        const text = segments
            .map((segment) => segment.value)
            .join("")
            .trim();
        return text ? done(text, trimEdges(segments)) : skip();
    }

    // Someone waiting on a message they sent is better served by it going out untranslated
    // than by a minute of retries.
    async _callWithRetries(maskedText, language, urgent = false) {
        const retries = urgent ? 0 : TRANSIENT_RETRIES;
        const timeout = urgent ? URGENT_TIMEOUT_MS : 0;
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await this._callProvider(maskedText, language, timeout);
            } catch (err) {
                if (attempt >= retries || this._stopped || !isTransient(err)) throw err;
                logger.warn(`transient failure (${err.message}); retry ${attempt + 1}/${retries}`);
                await sleep(TRANSIENT_RETRY_DELAY_MS * (attempt + 1));
            }
        }
    }

    _awaitResume() {
        const wait = this._pausedUntil - Date.now();
        return wait > 0 ? sleep(wait) : Promise.resolve();
    }

    // Once the backend has named its per-minute limit, requests are spread to stay under it
    // instead of bursting into the limit and waiting.
    async _awaitSlot() {
        if (!(this._spacing > 0)) return;
        const now = Date.now();
        const at = Math.max(now, this._nextSlot);
        this._nextSlot = at + this._spacing;
        if (at > now) await sleep(at - now);
    }

    _learnLimit(body) {
        const limit = perMinuteLimit(body);
        if (!limit) return;
        const spacing = Math.ceil((60000 / limit) * 1.05);
        if (spacing !== this._spacing)
            logger.info(`the backend allows ${limit} requests a minute; pacing them`);
        this._spacing = spacing;
    }

    _isBackingOff(maskedKey) {
        const failedAt = this._failures.get(maskedKey);
        if (failedAt == null) return false;
        if (Date.now() - failedAt < FAILURE_BACKOFF_MS) return true;
        this._failures.delete(maskedKey);
        return false;
    }

    async _callProvider(maskedText, language, timeout = 0) {
        const controller = new AbortController();
        this._aborters.add(controller);
        let timedOut = false;
        const timer =
            timeout > 0
                ? setTimeout(() => {
                      timedOut = true;
                      controller.abort();
                  }, timeout)
                : null;
        try {
            const settings = this._settings.current;
            const provider = getProvider(settings.provider);
            return await provider.translate({
                text: maskedText,

                settings:
                    language === settings.targetLanguage
                        ? settings
                        : { ...settings, targetLanguage: language },
                signal: controller.signal,
            });
        } catch (err) {
            throw timedOut ? timeoutError() : err;
        } finally {
            clearTimeout(timer);
            this._aborters.delete(controller);
        }
    }

    _resolveSuccess(key, masked, raw) {
        const cleaned = stripWrappingQuotes(raw, masked).trim();
        if (!cleaned || normalize(cleaned) === normalize(masked)) {
            this._cache.set(key, null);
            return skip();
        }
        const maskedTranslation = this._keepPlaceholders(cleaned, masked);
        this._cache.set(key, maskedTranslation);
        return { status: "done", masked: maskedTranslation };
    }

    _keepPlaceholders(translation, masked) {
        const missing = missingPlaceholders(translation, masked);
        if (missing.length === 0) return translation;

        logger.warn(
            `the model dropped ${missing.length} placeholder(s) [${missing.join(", ")}]; ` +
                "appending them so the mentions, links or code they stand for are not lost",
        );
        return appendPlaceholders(translation, missing);
    }

    _resolveFailure(maskedKey, err) {
        const message = (err && err.message) || String(err);

        if (err && err.name === "AbortError") return error(message);

        if (err && err.name === "SkippedError") return { status: "unknown" };

        // A rate limit and an overloaded backend both say "later", not "this message failed".
        if (err && (err.status === 429 || OVERLOADED.has(err.status))) {
            const fallback = err.status === 429 ? RATE_LIMIT_PAUSE_MS : OVERLOAD_PAUSE_MS;
            const after = Math.min(err.retryAfterMs || fallback, MAX_RATE_LIMIT_PAUSE_MS);
            this._pausedUntil = Math.max(this._pausedUntil, Date.now() + after);
            if (err.status === 429) this._learnLimit(err.body);
            logger.warn(
                `${err.status === 429 ? "rate limited" : "backend overloaded"}; retrying in ${Math.round(after / 1000)}s`,
            );
            return { status: "retry", after };
        }

        if (isFatal(err)) {
            const reason = describe(err);
            const first = this._blocked == null;
            this._blocked = reason;
            if (first) {
                logger.warn(`translation stopped until the settings change: ${message}`);
                this._onError(reason, { fatal: true });
            }
            return error(reason);
        }

        this._rememberFailure(maskedKey);
        logger.warn("translate failed:", message);
        this._onError(message, { fatal: false });
        return error(message);
    }

    _rememberFailure(maskedKey) {
        this._failures.set(maskedKey, Date.now());
        if (this._failures.size <= FAILURE_RECORD_LIMIT) return;
        const cutoff = Date.now() - FAILURE_BACKOFF_MS;
        for (const [key, at] of this._failures) {
            if (at < cutoff) this._failures.delete(key);
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 503 (Google) and 529 (Anthropic) mean the backend is overloaded; hammering it again within
// seconds only prolongs that.
const OVERLOADED = new Set([503, 529]);

function isTransient(err) {
    if (!err || err.name === "AbortError" || err.name === "SkippedError") return false;
    if (err.name === "ConfigError") return false;
    if (err.status === undefined) return true;
    return err.status === 408 || (err.status >= 500 && !OVERLOADED.has(err.status));
}

// Google names the quota a 429 hit; only a per-minute one says how to pace.
function perMinuteLimit(body) {
    let parsed;
    try {
        parsed = JSON.parse(String(body || ""));
    } catch {
        return 0;
    }
    const details = (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.details;
    if (!Array.isArray(details)) return 0;
    for (const detail of details) {
        for (const violation of detail?.violations ?? []) {
            const limit = Number(violation?.quotaValue);
            if (/PerMinute/i.test(String(violation?.quotaId ?? "")) && limit > 0) return limit;
        }
    }
    return 0;
}

// Gemini answers a bad key, and Anthropic an empty balance, with a plain 400.
const BAD_KEY_400 = /API[_ ]key[_ ](?:not[_ ]valid|invalid)/i;
const NO_BALANCE_400 = /credit balance is too low/i;

// Every request after one of these would be refused the same way, whatever the message.
function isFatal(err) {
    if (!err) return false;
    if (err.name === "ConfigError") return true;
    if (err.status === 401 || err.status === 402 || err.status === 403) return true;
    return (
        err.status === 400 &&
        (BAD_KEY_400.test(String(err.body || "")) || NO_BALANCE_400.test(String(err.body || "")))
    );
}

function describe(err) {
    if (!err) return "unknown";
    if (err.status === 402 || (err.status === 400 && NO_BALANCE_400.test(String(err.body || "")))) {
        return t("error.noBalance");
    }
    if (err.status === 401 || err.status === 403 || (err.status === 400 && isFatal(err))) {
        return t("error.badKey");
    }
    return err.message || String(err);
}

function timeoutError() {
    const err = new Error(t("error.timedOut"));
    err.name = "TimeoutError";
    return err;
}

function aborted() {
    const err = new Error("stopped");
    err.name = "AbortError";
    return err;
}

function skipped() {
    const err = new Error("skipped");
    err.name = "SkippedError";
    return err;
}

function normalize(value) {
    return String(value)
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]/gu, "");
}

const QUOTE_PAIRS = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["「", "」"],
    ["『", "』"],
];

function stripWrappingQuotes(value, source) {
    const text = String(value).trim();
    if (text.length < 2) return text;

    for (const [open, close] of QUOTE_PAIRS) {
        if (text[0] !== open || text[text.length - 1] !== close) continue;

        const inner = text.slice(1, -1);
        if (inner.includes(open) || inner.includes(close)) continue;

        const from = String(source ?? "").trim();
        if (from.length >= 2 && from[0] === open && from[from.length - 1] === close) continue;

        return inner.trim();
    }
    return text;
}

function trimEdges(segments) {
    const out = segments.slice();
    while (out.length && out[0].type === "text" && !out[0].value.trim()) out.shift();
    while (out.length && out[out.length - 1].type === "text" && !out[out.length - 1].value.trim()) out.pop();
    if (out.length && out[0].type === "text")
        out[0] = { type: "text", value: out[0].value.replace(/^\s+/, "") };
    const last = out.length - 1;
    if (last >= 0 && out[last].type === "text") {
        out[last] = { type: "text", value: out[last].value.replace(/\s+$/, "") };
    }
    return out;
}
