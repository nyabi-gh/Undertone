import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (e) {
        failures += 1;
        console.error(`FAIL  ${name}\n      ${e.message}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (e) {
        failures += 1;
        console.error(`FAIL  ${name}\n      ${e.message}`);
    }
}

const { mask, unmask, missingPlaceholders, appendPlaceholders } =
    await import("../src/translation/tokenizer.js");
const { LanguageDetector } = await import("../src/translation/language-detector.js");
const { normalizeBaseUrl } = await import("../src/lib/net.js");

check("tokenizer masks discord tokens and round-trips", () => {
    const original = "hey <@123456789012345678> look `const x = 1` https://example.com/a 😄";
    const { masked, tokens } = mask(original);
    assert.equal(tokens.length, 3, "mention + inline code + url");
    assert.ok(!masked.includes("123456789012345678"), "raw id is hidden from the model");
    assert.equal(unmask(masked, tokens), original);
});

check("tokenizer tolerates the model rewriting brackets", () => {
    const { tokens } = mask("call <@1> now");
    assert.equal(unmask("지금 [0] 호출해", tokens), "지금 <@1> 호출해");
});

check("tokenizer: a literal 【0】 in the source does not collide", () => {
    const original = "【0】 https://example.com/x";
    const { masked, tokens } = mask(original);
    assert.equal(masked, "【0】 【1】");
    assert.equal(unmask(masked, tokens), original);
});

check("tokenizer: ordinary '(1)' in a translation is not swallowed", () => {
    const { tokens } = mask("see https://a.example and https://b.example");
    assert.equal(
        unmask("【0】 와 【1】 를 보세요 (1)", tokens),
        "https://a.example 와 https://b.example 를 보세요 (1)",
    );
});

check("tokenizer: a dropped placeholder is detected, an intact translation is not flagged", () => {
    const { masked } = mask("hey <@1> see https://a.example now");
    assert.equal(masked, "hey \u30100\u3011 see \u30101\u3011 now");

    assert.deepEqual(missingPlaceholders("\u30100\u3011 \u30101\u3011 \ubd10", masked), []);
    assert.deepEqual(missingPlaceholders("[1] \ubd10 [0]", masked), [], "loose brackets still count");
    assert.deepEqual(missingPlaceholders("\u30101\u3011 \ubd10", masked), [0], "the mention vanished");
    assert.deepEqual(missingPlaceholders("\uc548\ub155", masked), [0, 1], "both vanished");

    assert.deepEqual(
        missingPlaceholders("\uc548\ub155", "\uc548\ub155\ud558\uc138\uc694"),
        [],
        "nothing to lose",
    );
});

check("tokenizer: appending a dropped placeholder brings the token back", () => {
    const original = "hey <@123456789012345678> see https://a.example now";
    const { masked, tokens } = mask(original);

    const dropped = "\u30100\u3011 \uc774\uc81c \ubd10";
    const missing = missingPlaceholders(dropped, masked);
    assert.deepEqual(missing, [1]);

    const repaired = appendPlaceholders(dropped, missing);
    assert.equal(unmask(repaired, tokens), "<@123456789012345678> \uc774\uc81c \ubd10 https://a.example");
    assert.equal(appendPlaceholders(dropped, []), dropped, "an intact translation is untouched");
});

check("tokenizer: mismatched brackets are not placeholders", () => {
    const { tokens } = mask("call <@1> now");
    assert.equal(unmask("[0】 호출", tokens), "[0】 호출");
});

const { TaskQueue } = await import("../src/translation/queue.js");

await checkAsync("queue: clear() rejects waiting tasks instead of hanging", async () => {
    const queue = new TaskQueue(() => 1);
    const first = queue.run(() => new Promise((r) => setTimeout(() => r("a"), 20)));
    const second = queue.run(() => Promise.resolve("b"));
    queue.clear();
    await assert.rejects(second, (e) => e.name === "AbortError");
    assert.equal(await first, "a");
});

const detector = new LanguageDetector({ current: { skipThreshold: 30 } });

check("language detector: english needs translation", () => {
    assert.equal(detector.needsTranslation("Hello everyone, how are you?"), true);
});
check("language detector: korean is skipped", () => {
    assert.equal(detector.needsTranslation("안녕하세요 여러분 오늘 날씨 좋네요"), false);
});
check("language detector: laughter (jamo) is skipped", () => {
    assert.equal(detector.needsTranslation("ㅋㅋㅋㅋㅋ"), false);
});
check("language detector: japanese needs translation", () => {
    assert.equal(detector.needsTranslation("こんにちは、元気ですか"), true);
});
check("language detector: too short is skipped", () => {
    assert.equal(detector.needsTranslation("k"), false);
});

installBdApiStub();

const { setLocale, t, UI_LANGUAGES, stringKeys } = await import("../src/i18n.js");
setLocale("en");

const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf8"));
const bundlePath = join(root, "dist", `${meta.name}.plugin.js`);

let Plugin;
check("bundle loads under stub BdApi (BetterDiscord-style wrapper)", () => {
    Plugin = loadPlugin(bundlePath);
    assert.equal(typeof Plugin, "function", "module.exports is the plugin class");
});

check("plugin instance has the BetterDiscord lifecycle", () => {
    const instance = new Plugin({ name: meta.name, version: meta.version });
    assert.equal(typeof instance.start, "function");
    assert.equal(typeof instance.stop, "function");
    assert.equal(typeof instance.getSettingsPanel, "function");
});

check("getSettingsPanel returns a panel spec with an onChange", () => {
    const instance = new Plugin({ name: meta.name });
    const [panel] = instance.getSettingsPanel().type().props.children;
    assert.ok(Array.isArray(panel.__spec.settings) && panel.__spec.settings.length > 0);
    assert.equal(typeof panel.__spec.onChange, "function");
});

check("start() and stop() do not throw (webpack lookup fails gracefully)", () => {
    const instance = new Plugin({ name: meta.name });
    instance.start();
    instance.stop();
});

await checkAsync("start(): the message patch lands once Discord loads the chat modules", async () => {
    const webpack = BdApi.Webpack;
    const previousAfter = BdApi.Patcher.after;
    const patched = [];
    const owner = { MessageContent: function MessageContent() {} };
    let loaded = false;
    let release;
    const chatModules = new Promise((resolve) => {
        release = resolve;
    });

    BdApi.Webpack = {
        ...webpack,
        getWithKey: () => (loaded ? [owner, "MessageContent"] : [null, null]),
        getByKeys: () => null,
        waitForModule: () => chatModules,
        Filters: { ...webpack.Filters, byKeys: () => () => false },
    };
    BdApi.Patcher.after = (_name, _module, key) => {
        patched.push(key);
        return () => {};
    };

    const instance = new Plugin({ name: meta.name });
    try {
        instance.start();
        assert.deepEqual(patched, [], "nothing is patched while the chat chunk is missing");

        loaded = true;
        release();
        await flush();

        assert.deepEqual(patched, ["MessageContent"], "the patch is installed without a restart");
    } finally {
        instance.stop();
        BdApi.Webpack = webpack;
        BdApi.Patcher.after = previousAfter;
    }
});

await checkAsync("stop() drops a pending wait so a late module never patches", async () => {
    const webpack = BdApi.Webpack;
    const previousAfter = BdApi.Patcher.after;
    const patched = [];
    const owner = { MessageContent: function MessageContent() {} };
    let loaded = false;
    let release;
    const chatModules = new Promise((resolve) => {
        release = resolve;
    });

    BdApi.Webpack = {
        ...webpack,
        getWithKey: () => (loaded ? [owner, "MessageContent"] : [null, null]),
        getByKeys: () => null,
        waitForModule: () => chatModules,
        Filters: { ...webpack.Filters, byKeys: () => () => false },
    };
    BdApi.Patcher.after = (_name, _module, key) => {
        patched.push(key);
        return () => {};
    };

    try {
        const instance = new Plugin({ name: meta.name });
        instance.start();
        instance.stop();

        loaded = true;
        release();
        await flush();

        assert.deepEqual(patched, [], "a stopped plugin does not patch anything");
    } finally {
        BdApi.Webpack = webpack;
        BdApi.Patcher.after = previousAfter;
    }
});

await checkAsync("queue: work whose caller lost interest is dropped, not run", async () => {
    const queue = new TaskQueue(() => 1);
    let ran = 0;
    const block = queue.run(() => new Promise((r) => setTimeout(r, 20)));
    const skipped = queue.run(
        () => {
            ran += 1;
        },
        () => false,
    );
    const kept = queue.run(() => {
        ran += 1;
        return "ok";
    });

    await assert.rejects(skipped, (e) => e.name === "SkippedError");
    await block;
    assert.equal(await kept, "ok", "a dropped task must not block the queue");
    assert.equal(ran, 1, "the dropped task never ran");
});

const { TranslationCache } = await import("../src/translation/cache.js");
const { Translator } = await import("../src/translation/translator.js");
const {
    CACHE_LIMIT,
    CACHE_KEY,
    LEGACY_CACHE_KEYS,
    NAME,
    LEGACY_NAMES,
    TRANSIENT_RETRIES,
    MAX_OUTPUT_TOKENS,
    FAILURE_BACKOFF_MS,
    MAX_FAILURE_RETRIES,
} = await import("../src/constants.js");

check("cache: save() keeps the newest entries, not the oldest", () => {
    const saved = captureSave(() => {
        const cache = new TranslationCache();
        for (let i = 0; i < CACHE_LIMIT + 5; i += 1) cache.set(`k${i}`, `v${i}`);
        cache.save();
    });
    assert.equal(saved.length, CACHE_LIMIT);
    assert.ok(
        saved.some(([key]) => key === `k${CACHE_LIMIT + 4}`),
        "the most recent translation must survive trimming",
    );
    assert.ok(!saved.some(([key]) => key === "k0"), "the oldest entry is dropped first");
});

check('cache: a "no translation needed" verdict survives a restart', () => {
    const saved = captureSave(() => {
        const cache = new TranslationCache();
        cache.set("ko\u0001already korean", null);
        cache.set("ko\u0001bonjour", "안녕");
        cache.save();
    });

    assert.equal(saved.length, 2);

    const reloaded = new TranslationCache();
    const previous = BdApi.Data.load;
    BdApi.Data.load = (_name, key) => (key === CACHE_KEY ? saved : null);
    try {
        reloaded.load();
    } finally {
        BdApi.Data.load = previous;
    }
    assert.ok(reloaded.has("ko\u0001already korean"));
    assert.equal(reloaded.get("ko\u0001already korean"), null);
    assert.equal(reloaded.get("ko\u0001bonjour"), "안녕");
});

check("cache: clearing empties the store and the saved copy", () => {
    const saved = captureSave(() => {
        const cache = new TranslationCache();
        cache.set("ko\u0001hello there", "안녕");
        assert.equal(cache.size, 1);
        cache.clear();
        assert.equal(cache.size, 0);
    });

    assert.deepEqual(saved, []);
});

await checkAsync("translator: a shared cache key restores each message's own tokens", async () => {
    const previous = BdApi.Net.fetch;
    BdApi.Net.fetch = async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "안녕 【0】" } }] }), {
            status: 200,
        });
    try {
        const translator = new Translator({ settings: stubSettings() });
        const first = await translator.translate("hi <@111111111111111111>");
        const second = await translator.translate("hi <@222222222222222222>");
        assert.equal(first.text, "안녕 <@111111111111111111>");
        assert.equal(second.text, "안녕 <@222222222222222222>");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: a link the model dropped is put back, and cached that way", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;

        return new Response(
            JSON.stringify({ choices: [{ message: { content: "\uc9c0\uae08 \u30100\u3011 \ubd10" } }] }),
            {
                status: 200,
            },
        );
    };
    try {
        const translator = new Translator({ settings: stubSettings() });
        const source = "look <@111111111111111111> at https://a.example now";

        const first = await translator.translate(source);
        assert.equal(
            first.text,
            "\uc9c0\uae08 <@111111111111111111> \ubd10 https://a.example",
            "the url the model swallowed is appended instead of vanishing",
        );
        assert.ok(
            first.segments.some((seg) => seg.type === "token" && seg.value === "https://a.example"),
            "it comes back as a token segment, not as literal text",
        );

        const second = await translator.translate(source);
        assert.equal(calls, 1, "served from the cache");
        assert.equal(second.text, first.text, "the cache holds the repaired translation, not the lossy one");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: an intact translation is left exactly as the model wrote it", async () => {
    const previous = BdApi.Net.fetch;
    BdApi.Net.fetch = async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "\u30100\u3011 \ubd10" } }] }), {
            status: 200,
        });
    try {
        const translator = new Translator({ settings: stubSettings() });
        const result = await translator.translate("look at https://a.example");
        assert.equal(result.text, "https://a.example \ubd10", "nothing is appended when nothing was lost");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: a failed translation is not retried immediately", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response("nope", { status: 500 });
    };
    try {
        const translator = new Translator({ settings: stubSettings() });
        const before = Date.now();
        const failed = await translator.translate("hello there");
        assert.equal(failed.status, "error");
        assert.equal(calls, 1 + TRANSIENT_RETRIES, "a 5xx is retried before the user sees it");
        assert.ok(failed.retryAt >= before + FAILURE_BACKOFF_MS, "it says when asking again is worth it");

        const afterFirst = calls;
        const waiting = await translator.translate("hello there");
        assert.equal(waiting.status, "error");
        assert.equal(calls, afterFirst, "the second attempt is served from the failure backoff");
        assert.equal(waiting.retryAt, failed.retryAt, "and points at the same moment");

        assert.equal((await translator.translate("hello there", { ignoreBackoff: true })).status, "error");
        assert.ok(calls > afterFirst, "an explicit retry bypasses the backoff");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: pending is reported on start, not on enqueue", async () => {
    const previous = BdApi.Net.fetch;
    BdApi.Net.fetch = async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "안녕" } }] }), { status: 200 });
    try {
        const translator = new Translator({ settings: stubSettings() });

        let started = false;
        const promise = translator.translate("hello there", { onStart: () => (started = true) });
        assert.equal(started, false, "enqueueing must not announce a start");
        await promise;
        assert.equal(started, true);

        const dropped = await translator.translate("something else entirely", {
            shouldRun: () => false,
        });
        assert.equal(dropped.status, "unknown");
        assert.equal(translator._failures.size, 0, "a drop is not a failure");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: a 429 pauses everything instead of failing", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response(
            JSON.stringify({
                error: {
                    code: 429,
                    status: "RESOURCE_EXHAUSTED",
                    details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }],
                },
            }),
            { status: 429 },
        );
    };
    try {
        const translator = new Translator({ settings: stubSettings() });
        const result = await translator.translate("hello there");

        assert.equal(result.status, "retry", "a quota verdict is not this message's failure");
        assert.equal(result.after, 7000, "the server's retryDelay is honoured");
        assert.ok(translator._pausedUntil > Date.now(), "every other request is held back");
        assert.equal(translator._failures.size, 0, "a 429 must not enter the failure backoff");

        const before = calls;
        const pending = translator.translate("a different message");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(calls, before, "no provider call while paused");

        translator._pausedUntil = 0;
        assert.equal((await pending).status, "retry");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("provider: a chain of thought never reaches the message list", async () => {
    const previous = BdApi.Net.fetch;
    const reply =
        (content, finish = "stop") =>
        async () =>
            new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }), {
                status: 200,
            });
    try {
        BdApi.Net.fetch = reply("<thought>Let me consider the tone.</thought>안녕하세요");
        assert.equal(
            (await new Translator({ settings: stubSettings() }).translate("hi there")).text,
            "안녕하세요",
        );

        BdApi.Net.fetch = reply("<thought>*  Input: ...\n*  Option 1: ...", "length");
        const cut = await new Translator({ settings: stubSettings() }).translate("hi there");
        assert.equal(cut.status, "error");
        assert.equal(cut.message, t("error.reasoningOnly"));
        assert.notEqual(cut.message, t("error.emptyResponse"));
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: a configuration error is not retried", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "bad model" }), { status: 400 });
    };
    try {
        const translator = new Translator({ settings: stubSettings() });
        assert.equal((await translator.translate("hello there")).status, "error");
        assert.equal(calls, 1, "a 400 says the same thing every time");

        calls = 0;
        const settings = stubSettings();
        settings.current.apiKey = "";
        assert.equal((await new Translator({ settings }).translate("hello there")).status, "error");
        assert.equal(calls, 0);
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("deepl: protects placeholders with its own ignore tags", async () => {
    const previous = BdApi.Net.fetch;
    let seen = null;
    BdApi.Net.fetch = async (url, options) => {
        seen = { url, options, body: JSON.parse(options.body) };
        return new Response(
            JSON.stringify({
                translations: [{ detected_source_language: "EN", text: "안녕 <x>0</x> 3 &lt; 5" }],
            }),
            { status: 200 },
        );
    };
    try {
        const settings = stubSettings();
        Object.assign(settings.current, { provider: "deepl", baseUrl: "", model: "" });
        settings.current.apiKey = "abc:fx";

        const result = await new Translator({ settings }).translate("hi <@1> 3 < 5");

        assert.equal(seen.url, "https://api-free.deepl.com/v2/translate", "a :fx key uses the free host");
        assert.equal(seen.options.headers.Authorization, "DeepL-Auth-Key abc:fx");
        assert.equal(seen.body.target_lang, "KO");
        assert.deepEqual(seen.body.ignore_tags, ["x"]);
        assert.equal(seen.body.tag_handling, "xml");

        assert.equal(seen.body.text[0], "hi <x>0</x> 3 &lt; 5");
        assert.equal(result.text, "안녕 <@1> 3 < 5");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("deepl: a pro key is sent to the pro host", async () => {
    const previous = BdApi.Net.fetch;
    let url = null;
    BdApi.Net.fetch = async (requested) => {
        url = requested;
        return new Response(JSON.stringify({ translations: [{ text: "안녕" }] }), { status: 200 });
    };
    try {
        const settings = stubSettings();
        Object.assign(settings.current, { provider: "deepl", baseUrl: "", apiKey: "no-suffix-key" });
        await new Translator({ settings }).translate("hello there");
        assert.equal(url, "https://api.deepl.com/v2/translate");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

check("net: a plain-http base url is refused before the key is sent", () => {
    assert.throws(() => normalizeBaseUrl("http://evil.example"), /https/);
    assert.equal(normalizeBaseUrl("  https://api.deepseek.com/  "), "https://api.deepseek.com");
    assert.equal(normalizeBaseUrl("api.deepseek.com"), "https://api.deepseek.com");
});

const { renderSegments } = await import("../src/ui/rich-text.js");
const { blockHeight, keepPlace, whenSteady, disconnectScroll } = await import("../src/ui/scroll.js");

check("scroll: a translation arriving above the viewport does not move what is being read", () => {
    const previous = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (node) => node.style ?? {};
    try {
        const above = scrollScene({ anchorTop: 40 });
        keepPlace(above.anchor, 22);
        assert.equal(above.scroller.scrollTop, 522, "the scroller gives back exactly what was added");

        const inView = scrollScene({ anchorTop: 300 });
        keepPlace(inView.anchor, 22);
        assert.equal(inView.scroller.scrollTop, 500, "growing in view pushes what is below, as it should");

        const shrank = scrollScene({ anchorTop: 40 });
        keepPlace(shrank.anchor, -22);
        assert.equal(shrank.scroller.scrollTop, 478, "a block that gives space back moves the page too");

        const loose = { parentElement: null, getBoundingClientRect: () => ({ top: 0 }) };
        keepPlace(loose, 22);

        assert.equal(blockHeight(null), 0);
        assert.equal(
            blockHeight({
                style: { marginTop: "2px", marginBottom: "0px" },
                getBoundingClientRect: () => ({ height: 20 }),
            }),
            22,
            "the block's margin is part of what it pushed",
        );
    } finally {
        globalThis.getComputedStyle = previous;
    }
});

await checkAsync("scroll: a block never lands on screen while the reader is scrolling", async () => {
    const previous = { style: globalThis.getComputedStyle, document: globalThis.document };
    globalThis.getComputedStyle = (node) => node.style ?? {};

    let onScroll = null;
    globalThis.document = {
        addEventListener: (type, handler) => {
            if (type === "scroll") onScroll = handler;
        },
        removeEventListener: () => {
            onScroll = null;
        },
    };
    try {
        const scene = scrollScene({ anchorTop: 300 });
        const landed = [];

        whenSteady(scene.anchor, () => landed.push("still"));
        assert.deepEqual(landed, ["still"], "a reader sitting still is shown it at once");

        onScroll();
        whenSteady(scene.anchor, () => landed.push("scrolling"));
        assert.deepEqual(landed, ["still"], "mid-scroll it waits instead of pushing the page");

        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.deepEqual(landed, ["still", "scrolling"], "and lands once the scrolling stops");

        const passed = scrollScene({ anchorTop: 40 });
        onScroll();
        whenSteady(passed.anchor, () => landed.push("above"));
        assert.deepEqual(
            landed,
            ["still", "scrolling", "above"],
            "off screen it lands immediately; keepPlace hides the growth",
        );

        onScroll();
        const cancel = whenSteady(scene.anchor, () => landed.push("dropped"));
        cancel();
        onScroll();
        assert.equal(landed.length, 3, "a block whose message went away never lands");
    } finally {
        disconnectScroll();
        globalThis.getComputedStyle = previous.style;
        globalThis.document = previous.document;
    }
});

const { Settings, SETTINGS_CLASS } = await import("../src/settings.js");
const { STYLES } = await import("../src/ui/styles.js");
const { CUSTOM_MODEL } = await import("../src/translation/providers/index.js");

check("rich text: discord tokens render as elements, not raw markup", () => {
    const stores = {
        userName: (id) => (id === "1" ? "냐비" : null),
        channelName: () => "일반",
        roleName: () => null,
    };
    const nodes = renderSegments(
        [
            { type: "text", value: "안녕 " },
            { type: "token", value: "<@1>" },
            { type: "token", value: "<@2>" },
            { type: "token", value: "<#9>" },
            { type: "token", value: "<:hi:5>" },
            { type: "token", value: "`x = 1`" },
        ],
        stores,
        "g1",
    );

    assert.equal(nodes[0], "안녕 ");
    assert.deepEqual(nodes[1].props.children, ["@냐비"]);
    assert.equal(nodes[2], "<@2>", "an unknown user falls back to the raw token");
    assert.deepEqual(nodes[3].props.children, ["#일반"]);
    assert.equal(nodes[4].type, "img");
    assert.ok(nodes[4].props.src.includes("/5.webp"), nodes[4].props.src);
    assert.equal(nodes[5].type, "code");
    assert.deepEqual(nodes[5].props.children, ["x = 1"]);
});

await checkAsync("translator: only a real wrapping quote is stripped", async () => {
    const previous = BdApi.Net.fetch;
    const reply = (content) => async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    try {
        BdApi.Net.fetch = reply('"안녕하세요"');
        assert.equal(
            (await new Translator({ settings: stubSettings() }).translate("hello")).text,
            "안녕하세요",
        );

        BdApi.Net.fetch = reply('"가" 그리고 "나"');
        assert.equal(
            (await new Translator({ settings: stubSettings() }).translate("a and b")).text,
            '"가" 그리고 "나"',
            "a string that merely starts and ends with a quote keeps both",
        );
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("cache: a translation belongs to the model that made it", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: `안녕 ${calls}` } }] }), {
            status: 200,
        });
    };
    try {
        const settings = stubSettings();
        const translator = new Translator({ settings });
        assert.equal((await translator.translate("hello there")).text, "안녕 1");
        assert.equal(translator.peek("hello there").status, "done", "the same model reuses it");

        settings.current.model = "deepseek-v4-pro";
        assert.equal(translator.peek("hello there").status, "unknown", "another model has not answered");
        assert.equal((await translator.translate("hello there")).text, "안녕 2");

        settings.current.model = "deepseek-flash";
        assert.equal(translator.peek("hello there").text, "안녕 1", "each model keeps its own answer");

        settings.current.model = "";
        assert.equal(
            translator.peek("hello there").text,
            "안녕 1",
            "a blank model means the backend default, which is what answered first",
        );
    } finally {
        BdApi.Net.fetch = previous;
    }
});

check("cache: the key shape changed, so what an older build saved is thrown away", () => {
    assert.equal(CACHE_KEY, "cache-v4");
    assert.ok(LEGACY_CACHE_KEYS.includes("cache-v3"), "entries with no model in the key must go");

    const deleted = [];
    const previous = BdApi.Data;
    BdApi.Data = {
        load: (_name, key) => (key === "cache-v3" ? [["kohello", "안녕"]] : null),
        save: () => {},
        delete: (_name, key) => deleted.push(key),
    };
    try {
        new TranslationCache().load();
    } finally {
        BdApi.Data = previous;
    }
    assert.ok(deleted.includes("cache-v3"));
});

await checkAsync("a script that spends more tokens per character gets more room", async () => {
    const previous = BdApi.Net.fetch;
    const budgets = [];
    BdApi.Net.fetch = async (_url, options) => {
        budgets.push(JSON.parse(options.body).max_tokens);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };
    try {
        const settings = stubSettings();
        const text = "the quick brown fox jumps over the lazy dog. ".repeat(20);

        settings.current.targetLanguage = "ko";
        await new Translator({ settings }).translate(text);

        settings.current.targetLanguage = "th";
        await new Translator({ settings }).translate(text);

        assert.equal(budgets[0], text.length + 256);
        assert.ok(budgets[1] > budgets[0] * 2, "Thai was being cut off at the Latin-sized budget");
        assert.ok(budgets[1] <= MAX_OUTPUT_TOKENS, "and the ceiling still holds");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("reasoning is stripped even when the model loses a tag", async () => {
    const previous = BdApi.Net.fetch;
    const answers = [
        "<think>the tone is casual</think>안녕하세요",
        "let me think about the tone\n</think>\n안녕하세요",
        "<think>the tone is casual\n\nstill thinking",
    ];
    try {
        const results = [];
        for (const content of answers) {
            BdApi.Net.fetch = async () =>
                new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
            results.push(await new Translator({ settings: stubSettings() }).translate("hello there"));
        }

        assert.equal(results[0].text, "안녕하세요");
        assert.equal(results[1].text, "안녕하세요", "an orphan closer was showing the reasoning instead");
        assert.equal(results[2].status, "error", "leaked reasoning is never shown as the translation");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

check("settings: an edit reported twice is stored once, keybinds included", () => {
    const settings = new Settings();
    const seen = [];
    settings.onChange((id, value) => seen.push([id, value]));

    const panel = settings._panelSpec();
    const field = panelFields(settings).find((entry) => entry.id === "hotkey");

    field.onChange(["Control", "Alt", "K"]);
    panel.onChange("general", "hotkey", ["Control", "Alt", "K"]);
    assert.deepEqual(settings.current.hotkey, ["Control", "Alt", "K"]);
    assert.equal(seen.length, 1, "the panel reports one edit from two places");

    panel.onChange("general", "hotkey", ["Control", "Alt", "K"]);
    assert.equal(seen.length, 1, "re-recording the same combo changes nothing");
});

check("translator: a pair it was handed is used instead of asking again", () => {
    const translator = new Translator({ settings: stubSettings() });

    translator.remember("hello there", "안녕하세요", "ko");
    assert.equal(translator.peek("hello there").text, "안녕하세요");

    translator.remember("call <@1> now", "지금 <@1> 호출", "ko");
    assert.equal(
        translator.peek("call <@1> now").status,
        "unknown",
        "a pair carrying tokens cannot be numbered from one side",
    );
});

check("translator: an over-long message is re-checked after maxChars is raised", () => {
    const settings = stubSettings();
    settings.current.maxChars = 10;
    const translator = new Translator({ settings });
    assert.equal(translator.peek("this message is definitely too long").status, "skip");
    settings.current.maxChars = 3000;
    assert.equal(
        translator.peek("this message is definitely too long").status,
        "unknown",
        "the skip must not have been cached",
    );
});

check("settings: data saved under the previous plugin name is carried over", () => {
    const previous = BdApi.Data;
    const store = new Map([
        [`${LEGACY_NAMES[0]}::settings`, { apiKey: "sk-old", guildIds: "123456789012345678" }],
    ]);
    BdApi.Data = {
        load: (name, key) => store.get(`${name}::${key}`) ?? null,
        save: (name, key, value) => store.set(`${name}::${key}`, value),
        delete: (name, key) => store.delete(`${name}::${key}`),
    };
    try {
        const settings = new Settings();
        assert.equal(settings.current.apiKey, "sk-old", "the key must survive a rename");
        assert.deepEqual([...settings.guildIdSet], ["123456789012345678"]);
        assert.ok(store.has(`${NAME}::settings`), "carried-over values are rewritten under the new name");
    } finally {
        BdApi.Data = previous;
    }
});

check("settings: every panel field persists, not just the switches", () => {
    const settings = new Settings();
    const fields = panelFields(settings);

    const edits = {
        apiKey: "sk-typed-in-the-panel",
        guildIds: "1339590547421007964",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.example.com",
        skipThreshold: 55,
        maxChars: 1200,
        maxConcurrent: 5,
        translateBots: false,
        showPending: false,
    };

    for (const [id, value] of Object.entries(edits)) {
        const field = fields.find((entry) => entry.id === id);
        assert.ok(field, `panel is missing "${id}"`);
        assert.equal(typeof field.onChange, "function", `"${id}" has no onChange of its own`);
        field.onChange(value);
        assert.equal(settings.current[id], value, `"${id}" did not persist`);
    }

    assert.deepEqual([...settings.guildIdSet], [edits.guildIds]);
});

const { getLanguage, badgeFor, LANGUAGE_OPTIONS } = await import("../src/languages.js");

check("i18n: strings switch language and interpolate", () => {
    setLocale("ko");
    assert.equal(t("block.pending"), "번역 중…");
    assert.equal(t("toast.failed", { message: "HTTP 429" }), "번역 실패 · HTTP 429");
    setLocale("en");
    assert.equal(t("block.pending"), "Translating…");
    assert.ok(!/[가-힣]/.test(t("settings.provider.note")), "the English table must not leak Korean");
    setLocale("xx");
    assert.equal(t("block.pending"), "Translating…", "an unknown locale falls back to English");
});

check("i18n: every key exists in every table", () => {
    setLocale("en");
    for (const { value } of LANGUAGE_OPTIONS) assert.ok(value, "language option needs a value");

    const [reference, ...rest] = UI_LANGUAGES;
    const expected = stringKeys(reference).sort();
    assert.ok(expected.length > 50, "the reference table should hold every string the plugin shows");

    for (const locale of rest) {
        assert.deepEqual(
            stringKeys(locale).sort(),
            expected,
            `${locale} drifted; the missing keys would quietly come out in ${reference}`,
        );
    }
});

await checkAsync("target language: drives the prompt and the cache key", async () => {
    const previous = BdApi.Net.fetch;
    const prompts = [];
    BdApi.Net.fetch = async (_url, options) => {
        prompts.push(JSON.parse(options.body).messages[0].content);
        return new Response(JSON.stringify({ choices: [{ message: { content: "translated" } }] }), {
            status: 200,
        });
    };
    try {
        const settings = stubSettings();
        settings.current.targetLanguage = "en";
        const translator = new Translator({ settings });
        await translator.translate("안녕하세요 여러분");
        assert.match(prompts[0], /into natural, colloquial English/);

        settings.current.targetLanguage = "ja";
        assert.equal(translator.peek("안녕하세요 여러분").status, "unknown");
        await translator.translate("안녕하세요 여러분");
        assert.match(prompts[1], /into natural, colloquial Japanese/);
    } finally {
        BdApi.Net.fetch = previous;
    }
});

check("detector: a missing threshold falls back instead of disabling everything", () => {
    for (const skipThreshold of [undefined, null, NaN, "", {}]) {
        const detect = new LanguageDetector({ current: { skipThreshold, targetLanguage: "ko" } });
        assert.equal(detect.needsTranslation("hello everyone"), true, `broken by ${String(skipThreshold)}`);
    }

    const zero = new LanguageDetector({ current: { skipThreshold: 0, targetLanguage: "ko" } });
    assert.equal(zero.needsTranslation("hello everyone"), false);
});

check("detector: judges against the chosen target language", () => {
    const settings = { current: { skipThreshold: 30, targetLanguage: "ko" } };
    const detect = new LanguageDetector(settings);

    assert.equal(detect.needsTranslation("Hello everyone"), true);
    assert.equal(detect.needsTranslation("안녕하세요 여러분"), false);

    settings.current.targetLanguage = "ja";
    assert.equal(detect.needsTranslation("こんにちは、元気ですか"), false, "already Japanese");
    assert.equal(detect.needsTranslation("안녕하세요 여러분"), true, "Korean needs translating now");

    settings.current.targetLanguage = "en";
    assert.equal(detect.needsTranslation("안녕하세요 여러분"), true);
    assert.equal(
        detect.needsTranslation("Hello everyone"),
        true,
        "a Latin-script target cannot be pre-filtered, so the model decides",
    );

    assert.equal(getLanguage("nope").code, "ko", "an unknown code falls back to the default");
});

check("languages: regional variants are distinct targets", () => {
    assert.equal(getLanguage("pt-BR").name, "Brazilian Portuguese");
    assert.equal(getLanguage("pt-PT").name, "European Portuguese");
    assert.equal(badgeFor("pt-BR"), "PT-BR", "a regional code needs its own badge");
    assert.equal(badgeFor("ko"), "KO");
    assert.ok(
        LANGUAGE_OPTIONS.some((option) => option.value === "pt-BR"),
        "the panel must offer Brazilian Portuguese",
    );
});

check("settings: a target saved before the split becomes Brazilian", () => {
    const previous = BdApi.Data;
    const store = new Map([[`${NAME}::settings`, { targetLanguage: "pt", koreanThreshold: 45 }]]);
    BdApi.Data = {
        load: (name, key) => store.get(`${name}::${key}`) ?? null,
        save: (name, key, value) => store.set(`${name}::${key}`, value),
        delete: (name, key) => store.delete(`${name}::${key}`),
    };
    try {
        const settings = new Settings();
        assert.equal(settings.current.targetLanguage, "pt-BR");
        assert.equal(settings.current.skipThreshold, 45, "the renamed threshold carries over");
        assert.ok(!("koreanThreshold" in settings.current), "the old key is dropped");
    } finally {
        BdApi.Data = previous;
    }
});

check("settings: a retired DeepSeek model name moves to its successor", () => {
    const previous = BdApi.Data;
    const store = new Map([
        [
            `${NAME}::settings`,
            {
                provider: "deepseek",
                model: "deepseek-v4-flash",
                profiles: { deepseek: { apiKey: "k", model: "deepseek-v4-flash", baseUrl: "" } },
            },
        ],
    ]);
    BdApi.Data = {
        load: (name, key) => store.get(`${name}::${key}`) ?? null,
        save: (name, key, value) => store.set(`${name}::${key}`, value),
        delete: (name, key) => store.delete(`${name}::${key}`),
    };
    try {
        const settings = new Settings();
        assert.equal(settings.current.model, "deepseek-flash");
        assert.equal(settings.current.profiles.deepseek.model, "deepseek-flash");
        assert.ok(!settings.usesCustomModel, "it lands on the list, not in the text field");
    } finally {
        BdApi.Data = previous;
    }
});

check("settings: the model field lists what is known and offers a way past the list", () => {
    const settings = new Settings();
    const field = (id) => panelFields(settings).find((entry) => entry.id === id);

    settings.set("provider", "deepseek");
    assert.equal(field("model").type, "dropdown");
    assert.deepEqual(
        field("model").options.map((option) => option.value),
        ["deepseek-flash", "deepseek-v4-pro", CUSTOM_MODEL],
    );

    settings.set("provider", "gemini");
    assert.deepEqual(
        field("model").options.map((option) => option.value),
        ["gemini-3.5-flash-lite", "gemini-3.8-flash", CUSTOM_MODEL],
    );

    settings.set("provider", "deepl");
    assert.equal(field("model"), undefined, "DeepL has no model at all");
    assert.equal(field("customModel"), undefined, "so there is nothing to type in either");
});

check("settings: a model too new for this build can be typed in", () => {
    const settings = new Settings();
    const field = (id) => panelFields(settings).find((entry) => entry.id === id);

    settings.set("provider", "gemini");
    assert.equal(field("customModel"), undefined, "the text field stays away until it is asked for");

    settings.set("model", CUSTOM_MODEL);
    assert.equal(settings.current.model, "", "the dropdown entry is never stored as a model name");
    assert.equal(field("model").value, CUSTOM_MODEL, "the dropdown keeps showing where the name comes from");
    assert.equal(field("customModel").type, "text");

    field("customModel").onChange("  gemini-4-pro-preview  ");
    assert.equal(settings.current.model, "gemini-4-pro-preview", "a pasted name is trimmed and kept");
    assert.equal(field("model").value, CUSTOM_MODEL);
    assert.equal(field("customModel").value, "gemini-4-pro-preview");

    settings.set("model", CUSTOM_MODEL);
    assert.equal(settings.current.model, "gemini-4-pro-preview", "re-picking it does not wipe the name");

    settings.set("model", "gemini-3.5-flash-lite");
    assert.equal(field("customModel"), undefined, "back on the list, the text field goes away");
});

check("settings: a typed-in model survives switching backends and back", () => {
    const settings = new Settings();
    settings.set("provider", "deepseek");
    settings.set("model", "deepseek-v5-turbo");

    settings.set("provider", "gemini");
    assert.equal(settings.current.model, "gemini-3.5-flash-lite", "the other backend keeps its own model");

    settings.set("provider", "deepseek");
    assert.equal(settings.current.model, "deepseek-v5-turbo", "the typed-in name was remembered");
});

await checkAsync("a typed-in model is the one the request asks for", async () => {
    const previous = BdApi.Net.fetch;
    let body = null;
    BdApi.Net.fetch = async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: "안녕" } }] }), {
            status: 200,
        });
    };
    try {
        const settings = stubSettings();
        settings.current.model = "deepseek-v5-turbo";
        await new Translator({ settings }).translate("hello there");
        assert.equal(body.model, "deepseek-v5-turbo");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("a field the model refuses is dropped, not the whole translation", async () => {
    const previous = BdApi.Net.fetch;
    const sent = [];
    BdApi.Net.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        sent.push(body);

        // What OpenAI's reasoning models answer to the request shape every other model takes.
        if ("temperature" in body) return unsupported("value", "temperature");
        if ("max_tokens" in body) return unsupported("parameter", "max_tokens");
        return new Response(JSON.stringify({ choices: [{ message: { content: "안녕" } }] }), {
            status: 200,
        });
    };
    try {
        const settings = stubSettings();
        settings.current.model = "some-reasoning-model";
        const result = await new Translator({ settings }).translate("hello there");

        assert.equal(result.text, "안녕", "the translation still arrives");
        assert.equal(sent.length, 3, "one retry per refused field, and no more");
        const last = sent[2];
        assert.ok(!("temperature" in last) && !("max_tokens" in last));
        assert.equal(last.max_completion_tokens, MAX_OUTPUT_TOKENS, "the renamed budget covers reasoning");
        assert.equal(last.model, "some-reasoning-model", "nothing else about the request moved");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("a refused model name is a configuration error, not something to retry", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return unsupported("parameter", "model");
    };
    try {
        const settings = stubSettings();
        settings.current.model = "no-such-model";
        const result = await new Translator({ settings }).translate("hello there");

        assert.equal(result.status, "error");
        assert.equal(calls, 1, "a request without a model would be nonsense");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

check("settings: switching provider swaps defaults and keeps both keys", () => {
    const settings = new Settings();
    settings.set("apiKey", "sk-deepseek");

    settings.set("provider", "gemini");
    assert.equal(settings.current.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
    assert.equal(settings.current.model, "gemini-3.5-flash-lite");
    assert.equal(settings.current.apiKey, "", "a provider with no saved key starts empty");

    settings.set("apiKey", "gemini-key");
    settings.set("provider", "deepseek");
    assert.equal(settings.current.apiKey, "sk-deepseek", "the first key was remembered");
    assert.equal(settings.current.baseUrl, "https://api.deepseek.com");

    settings.set("provider", "gemini");
    assert.equal(settings.current.apiKey, "gemini-key", "so was the second");
});

await checkAsync("gemini: request shape targets the OpenAI-compatible endpoint", async () => {
    const previous = BdApi.Net.fetch;
    let seen = null;
    BdApi.Net.fetch = async (url, options) => {
        seen = { url, options };
        return new Response(JSON.stringify({ choices: [{ message: { content: "안녕" } }] }), {
            status: 200,
        });
    };
    try {
        const settings = stubSettings();
        Object.assign(settings.current, {
            provider: "gemini",
            model: "gemini-3.1-flash-lite",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        });
        await new Translator({ settings }).translate("hello there");

        assert.equal(seen.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
        assert.equal(seen.options.headers.Authorization, "Bearer test-key");
        const body = JSON.parse(seen.options.body);
        assert.equal(body.model, "gemini-3.1-flash-lite");
        assert.equal(body.messages[0].role, "system");
        assert.ok(!("thinking" in body), "the DeepSeek-only field must not leak to Google");
        assert.equal(
            body.reasoning_effort,
            "minimal",
            "Gemini cannot stop reasoning, only keep it to the least",
        );

        settings.current.model = "gemini-3.8-flash";
        await new Translator({ settings }).translate("hello again");
        assert.equal(JSON.parse(seen.options.body).reasoning_effort, "low", "Flash has no minimal level");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: clearing the cache also lifts the failure backoff", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response("nope", { status: 400 });
    };
    try {
        const translator = new Translator({ settings: stubSettings() });
        assert.equal((await translator.translate("hello there")).status, "error");
        assert.equal((await translator.translate("hello there")).status, "error");
        assert.equal(calls, 1, "the second attempt is held by the backoff");

        translator.clearCache();
        assert.equal((await translator.translate("hello there")).status, "error");
        assert.equal(calls, 2);
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: every block waiting on the same text is told it started", async () => {
    const previous = BdApi.Net.fetch;
    BdApi.Net.fetch = async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "안녕" } }] }), { status: 200 });
    try {
        const translator = new Translator({ settings: stubSettings() });
        const started = [];
        const both = await Promise.all([
            translator.translate("hello there", { onStart: () => started.push("first") }),
            translator.translate("hello there", { onStart: () => started.push("second") }),
        ]);

        assert.deepEqual(started, ["first", "second"]);
        assert.equal(both[0].text, both[1].text);
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("manual mode: nothing is sent until it is asked for", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "안녕" } }] }), {
            status: 200,
        });
    };
    try {
        const settings = stubSettings();
        const translator = new Translator({ settings });

        assert.equal(translator.peek("hello there").status, "unknown");
        assert.equal(calls, 0, "peek() must never reach the provider");

        assert.equal((await translator.translate("hello there")).text, "안녕");
        assert.equal(calls, 1);
    } finally {
        BdApi.Net.fetch = previous;
    }
});

check("settings: the stored api key is never rendered into the panel", () => {
    const settings = new Settings();
    settings.set("apiKey", "  sk-abcdefgh1234  ");

    const field = panelFields(settings).find((entry) => entry.id === "apiKey");
    assert.equal(field.value, "", "the panel must not carry the key");
    assert.ok(!JSON.stringify(field).includes("abcdefgh"), "no part of the key may leak into the panel");
    assert.ok(field.placeholder.includes("1234"), "a last-4 fingerprint identifies the saved key");

    settings.set("apiKey", "");
    assert.equal(settings.current.apiKey, "sk-abcdefgh1234");

    settings.set("apiKey", "-");
    assert.equal(settings.current.apiKey, "");
});

const { parseHotkey, matchesHotkey, keysFromString } = await import("../src/hotkey.js");

check("hotkey: a combo is parsed, and nonsense disables it instead of throwing", () => {
    assert.deepEqual(parseHotkey(["Control", "Shift", "T"]), {
        ctrl: true,
        shift: true,
        alt: false,
        meta: false,
        key: "t",
    });
    assert.deepEqual(parseHotkey(["Alt", "k"]), {
        ctrl: false,
        shift: false,
        alt: true,
        meta: false,
        key: "k",
    });
    assert.equal(parseHotkey(["Meta", "K"]).meta, true, "macOS Command");

    assert.deepEqual(parseHotkey("Ctrl+Shift+T"), parseHotkey(["Control", "Shift", "T"]));
    assert.deepEqual(keysFromString("Ctrl+Shift+T"), ["Control", "Shift", "T"]);
    assert.deepEqual(keysFromString("cmd+K"), ["Meta", "K"]);

    assert.equal(parseHotkey([]), null);
    assert.equal(parseHotkey(""), null);
    assert.equal(parseHotkey(["Control", "Shift"]), null, "a modifier alone is not a shortcut");
    assert.equal(parseHotkey(["Control", "T", "K"]), null, "two keys is not a shortcut");
});

check("settings: a hotkey saved as text becomes a recordable keybind", () => {
    const previous = BdApi.Data;
    const store = new Map([[`${NAME}::settings`, { hotkey: "Ctrl+Shift+T", outgoingHotkey: "Alt+K" }]]);
    BdApi.Data = {
        load: (name, key) => store.get(`${name}::${key}`) ?? null,
        save: (name, key, value) => store.set(`${name}::${key}`, value),
        delete: (name, key) => store.delete(`${name}::${key}`),
    };
    try {
        const settings = new Settings();
        assert.deepEqual(settings.current.hotkey, ["Control", "Shift", "T"]);
        assert.deepEqual(settings.current.outgoingHotkey, ["Alt", "K"]);
    } finally {
        BdApi.Data = previous;
    }
});

check("hotkey: only the exact combo fires, and never mid-composition", () => {
    const combo = parseHotkey("Ctrl+Shift+T");
    const event = (overrides) => ({
        key: "T",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        ...overrides,
    });

    assert.ok(matchesHotkey(combo, event()));
    assert.ok(!matchesHotkey(combo, event({ altKey: true })), "an extra modifier is a different combo");
    assert.ok(!matchesHotkey(combo, event({ ctrlKey: false })));
    assert.ok(!matchesHotkey(combo, event({ key: "R" })));
    assert.ok(!matchesHotkey(combo, event({ repeat: true })), "holding the key must not spam the toggle");

    assert.ok(!matchesHotkey(combo, event({ isComposing: true })));
    assert.ok(!matchesHotkey(null, event()));
});

const { isLegacyCopy, asCurrent, handOff } = await import("../src/rename.js");
const bridgePath = join(root, "dist", "Undertone.plugin.js");

check("rename: Undertone.plugin.js is this build under the 1.5 name, so 1.5 updaters take it", () => {
    const bridge = readFileSync(bridgePath, "utf8");
    const current = readFileSync(bundlePath, "utf8");
    const oldCheck = /@name\s+Undertone\s/;
    assert.ok(oldCheck.test(bridge), "1.5.x releases only install a file named Undertone");
    assert.ok(!oldCheck.test(current));
    assert.equal(
        asCurrent(bridge, "Undertone"),
        current,
        "the hand-off must write exactly the release build",
    );
    assert.ok(isLegacyCopy({ name: "Undertone" }));
    assert.ok(!isLegacyCopy({ name: NAME }));
});

check("rename: started as Undertone, the plugin hands off instead of translating", () => {
    const previous = BdApi.DOM.addStyle;
    let styled = false;
    BdApi.DOM.addStyle = () => (styled = true);
    try {
        const instance = new Plugin({ name: "Undertone" });
        instance.start();
        instance.stop();
    } finally {
        BdApi.DOM.addStyle = previous;
    }
    assert.equal(styled, false);
});

await checkAsync("rename: the hand-off writes Mollu, turns it on and removes Undertone", async () => {
    const bridge = readFileSync(bridgePath, "utf8");
    const files = new Map([["plugins/Undertone.plugin.js", bridge]]);
    const fs = {
        existsSync: (file) => files.has(file),
        readFileSync: (file) => files.get(file),
        writeFileSync: (file, text) => files.set(file, text),
        unlinkSync: (file) => files.delete(file),
    };
    const path = { join: (...parts) => parts.join("/") };
    const previous = BdApi.Plugins;
    const enabled = [];
    BdApi.Plugins = {
        folder: "plugins",
        get: (name) => (files.has(`plugins/${name}.plugin.js`) ? { name } : null),
        enable: (name) => enabled.push(name),
    };
    try {
        const meta = { name: "Undertone", filename: "Undertone.plugin.js" };
        assert.equal(await handOff(meta, { fs, path, timeoutMs: 0 }), true);
        assert.deepEqual([...files.keys()], [`plugins/${NAME}.plugin.js`]);
        assert.equal(files.get(`plugins/${NAME}.plugin.js`), readFileSync(bundlePath, "utf8"));
        assert.deepEqual(enabled, [NAME]);

        files.clear();
        files.set("plugins/Undertone.plugin.js", bridge);
        BdApi.Plugins.get = () => null;
        assert.equal(await handOff(meta, { fs, path, timeoutMs: 0 }), false);
        assert.ok(files.has("plugins/Undertone.plugin.js"), "Undertone stays until Mollu is running");
    } finally {
        BdApi.Plugins = previous;
    }
});

check("rename: what Undertone saved replaces what Mollu 1.4 left behind, and moves only once", () => {
    const previous = BdApi.Data;
    const store = new Map([
        ["Mollu::settings", { apiKey: "sk-from-1.4", targetLanguage: "ja" }],
        ["Mollu::" + CACHE_KEY, [["old", "오래된"]]],
        ["Undertone::settings", { apiKey: "sk-from-1.5", targetLanguage: "ko" }],
        ["Undertone::" + CACHE_KEY, [["new", "새것"]]],
    ]);
    BdApi.Data = {
        load: (name, key) => store.get(`${name}::${key}`) ?? null,
        save: (name, key, value) => store.set(`${name}::${key}`, value),
        delete: (name, key) => store.delete(`${name}::${key}`),
    };
    try {
        const instance = new Plugin({ name: NAME });
        assert.equal(instance._settings.current.apiKey, "sk-from-1.5", "the settings read are Undertone's");
        assert.deepEqual(store.get(`${NAME}::${CACHE_KEY}`), [["new", "새것"]]);
        assert.ok(!store.has("Undertone::settings") && !store.has(`Undertone::${CACHE_KEY}`));

        store.set(`${NAME}::settings`, { apiKey: "sk-changed-in-mollu" });
        assert.equal(new Plugin({ name: NAME })._settings.current.apiKey, "sk-changed-in-mollu");
    } finally {
        BdApi.Data = previous;
    }
});

const { downloadUrlFor, readVersion, isNewer, Updater, verifySignature } = await import("../src/updater.js");

check("updater: the download url is the latest release asset, from meta.source and nowhere else", () => {
    assert.equal(
        downloadUrlFor("https://github.com/nyabi-gh/undertone"),
        "https://github.com/nyabi-gh/undertone/releases/latest/download/Mollu.plugin.js",
    );
    assert.equal(
        downloadUrlFor("https://github.com/nyabi-gh/undertone.git"),
        downloadUrlFor("https://github.com/nyabi-gh/undertone"),
    );

    assert.equal(downloadUrlFor("http://github.com/nyabi-gh/undertone"), null);
    assert.equal(downloadUrlFor("https://evil.example/nyabi-gh/undertone"), null);
    assert.equal(downloadUrlFor("https://github.com/nyabi-gh/undertone/../../other"), null);
    assert.equal(downloadUrlFor(""), null);
    assert.equal(downloadUrlFor(undefined), null);
});

await checkAsync("updater: a repository with no release reports unavailable, not a failure", async () => {
    const results = [];
    const updater = new Updater({
        meta: { source: "https://github.com/nyabi-gh/undertone", version: "1.0.0" },
        settings: { current: { autoUpdate: true } },
        onResult: (result) => results.push(result),
    });

    const previous = BdApi.Net.fetch;
    BdApi.Net.fetch = async () => new Response("Not Found", { status: 404 });
    try {
        assert.equal(await updater.check({ announce: true }), null);
    } finally {
        BdApi.Net.fetch = previous;
    }
    assert.deepEqual(results, [{ status: "unavailable" }]);
});

check("updater: a downloaded file is only written when it is a newer Mollu build", () => {
    const banner = (name, version) => `/**\n * @name ${name}\n * @version ${version}\n */\nvar x = 1;`;
    assert.equal(readVersion(banner("Mollu", "1.2.0")), "1.2.0");
    assert.equal(readVersion(banner("Mollu2", "1.2.0")), null);
    assert.equal(readVersion(banner("NotMollu", "1.2.0")), null);
    assert.equal(readVersion("var x = 1;"), null);
    assert.equal(readVersion(undefined), null);

    assert.ok(isNewer("1.10.0", "1.9.0"), "a string compare would call this older");
    assert.ok(isNewer("1.0.1", "1.0.0"));
    assert.ok(isNewer("2.0", "1.9.9"));
    assert.ok(!isNewer("1.0.0", "1.0.0"));
    assert.ok(!isNewer("1.0.0", "1.1.0"), "a local build ahead of the remote is never overwritten");
});

check("settings: the advanced section carries a working cache-clear button", () => {
    let cleared = 0;
    const settings = new Settings({ clearCache: () => (cleared += 1) });
    const advanced = settings._panelSpec().settings.find((entry) => entry.id === "advanced");
    assert.ok(advanced, "the advanced category is missing");

    const button = advanced.settings.find((entry) => entry.id === "clearCache");
    assert.equal(button.type, "button");

    assert.ok(!("onChange" in button));

    button.onClick();
    assert.equal(cleared, 1);
});

check("settings: the modal joins Discord's focus locks, or the one under it takes every keystroke", () => {
    const { getModule } = BdApi.Webpack;
    const { useRef } = BdApi.React;
    const locked = [];
    const modal = { id: "modal" };
    let field = { closest: (selector) => (selector === ".bd-modal-root" ? modal : null) };

    BdApi.Webpack.getModule = () => (ref) => locked.push(ref);
    BdApi.React.useRef = () => ({ current: field });
    try {
        const panel = new Settings().buildPanel();
        panel.type();
        assert.equal(locked.length, 1);
        assert.equal(locked[0].current, modal, "the whole modal is locked, so Done stays reachable");

        field = { closest: () => null };
        panel.type();
        assert.equal(locked[1].current, field, "outside a BetterDiscord modal the panel locks itself");
    } finally {
        BdApi.Webpack.getModule = getModule;
        BdApi.React.useRef = useRef;
    }
});

check("settings: the panel's dropdown lists open under their button, not in the corner", () => {
    const root = new Settings().buildPanel().type();
    assert.equal(root.props.className, SETTINGS_CLASS);
    assert.match(
        STYLES,
        new RegExp(`\\.${SETTINGS_CLASS} \\.bd-select-options \\{\\s*position-anchor: auto;`),
    );
});

check("settings: the panel is a live component, not a one-shot spec", () => {
    const settings = new Settings();
    const panel = settings.buildPanel();
    assert.equal(typeof panel.type, "function", "a plain spec cannot react to a provider change");

    const [rendered] = panel.type().props.children;
    assert.ok(
        rendered.__spec.settings
            .flatMap((entry) => entry.settings ?? entry)
            .some((entry) => entry.id === "provider"),
    );

    assert.match(String(rendered.props.key), /^panel-/);
});

check("settings: the panel rebuilds when its shape changes, and never mid-typing", () => {
    const settings = new Settings();
    const { useState, useEffect } = BdApi.React;
    let bumps = 0;
    let unmount = null;

    BdApi.React.useState = (init) => [
        typeof init === "function" ? init() : init,
        () => {
            bumps += 1;
        },
    ];
    BdApi.React.useEffect = (fn) => {
        unmount = fn();
    };
    try {
        settings.buildPanel().type();
        assert.equal(typeof unmount, "function", "the panel has to unsubscribe when it goes away");

        settings.set("provider", "gemini");
        assert.equal(bumps, 1, "another backend brings different fields");

        settings.set("model", CUSTOM_MODEL);
        assert.equal(bumps, 2, "the text field has to appear");

        settings.set("model", "gemini-4-pro-preview");
        assert.equal(bumps, 2, "remounting the field being typed into would eat the cursor");

        settings.set("model", "gemini-3.5-flash-lite");
        assert.equal(bumps, 3, "picking from the list again takes the text field away");
    } finally {
        unmount?.();
        BdApi.React.useState = useState;
        BdApi.React.useEffect = useEffect;
    }
});

check("settings: listeners fire and unsubscribe, and pasted values are trimmed", () => {
    const settings = new Settings();
    const seen = [];
    const unsubscribe = settings.onChange((id, value) => seen.push([id, value]));

    settings.set("showPending", false);
    settings.set("apiKey", "  sk-test  ");
    assert.deepEqual(seen[0], ["showPending", false]);
    assert.equal(settings.current.apiKey, "sk-test");

    unsubscribe();
    settings.set("showErrors", true);
    assert.equal(seen.length, 2, "no callbacks after unsubscribe");
});

const { MessagePatch } = await import("../src/message-patch.js");
const { ContextMenus } = await import("../src/context-menu.js");
const { BlockControls } = await import("../src/ui/block-controls.js");
const { TranslationBlock } = await import("../src/ui/translation-block.js");

check("target servers: the list gates by default, the toggle opens every server", () => {
    const inList = "1101573652786446417";

    const resolve = (overrides, list, msg) => patchWith(overrides, list)._resolve(message(msg));
    const guildOf = (overrides, list, msg) => resolve(overrides, list, msg).guildId;

    assert.equal(guildOf({}, inList), inList);
    assert.equal(guildOf({}, "222222222222222222"), undefined, "outside the list");
    assert.equal(guildOf({}), undefined, "an empty list translates nothing");

    assert.equal(guildOf({ allGuilds: true }), inList, "the toggle needs no list");
    assert.equal(
        resolve({ allGuilds: true }, "", { channel_id: "dm" }).ok,
        undefined,
        "the server toggle does not reach direct messages",
    );
    assert.equal(guildOf({ allGuilds: true, apiKey: "" }), undefined, "still needs a key");
    assert.equal(
        guildOf({ allGuilds: true }, "", { author: { id: "me" } }),
        undefined,
        "the toggle must not bypass the author filters",
    );

    assert.equal(guildOf({ allGuilds: true }, "", { type: 20 }), inList);
    assert.equal(guildOf({ allGuilds: true }, "", { type: 7 }), undefined, "a join notice has no body");
});

check("direct messages: off by default, and the switch opens them on their own", () => {
    const resolve = (overrides, msg) => patchWith(overrides, "")._resolve(message(msg));
    const dm = { channel_id: "dm" };

    assert.equal(resolve({}, dm).ok, undefined, "off by default");
    assert.equal(resolve({ allGuilds: true }, dm).ok, undefined, "the server toggle is not enough");

    assert.equal(resolve({ translateDms: true }, dm).ok, true, "no server list needed");
    assert.equal(resolve({ translateDms: true }, dm).guildId, null, "a dm belongs to no server");
    assert.equal(resolve({ translateDms: true }, { channel_id: "group" }).ok, true, "group dms count too");

    assert.equal(
        resolve({ translateDms: true }, { channel_id: "unknown" }).ok,
        undefined,
        "an unresolved channel is still not a dm",
    );
    assert.equal(resolve({ translateDms: true, apiKey: "" }, dm).ok, undefined, "still needs a key");
    assert.equal(
        resolve({ translateDms: true }, { ...dm, author: { id: "me" } }).ok,
        undefined,
        "the switch must not bypass the author filters",
    );

    assert.equal(resolve({ translateDms: true }, {}).ok, undefined, "it opens dms only, not servers");
});

check("diagnostics: a skipped message reports why", () => {
    const reasonFor = (overrides, msg) => patchWith(overrides, "")._resolve(message(msg)).reason;

    assert.match(reasonFor({}), /no target server/);
    assert.match(reasonFor({ allGuilds: true }, { author: { id: "me" } }), /own message/);
    assert.match(reasonFor({ allGuilds: true }, { channel_id: "dm" }), /direct message translation is off/);
    assert.match(reasonFor({ allGuilds: true }, { channel_id: "unknown" }), /not a server channel/);
    assert.match(reasonFor({ allGuilds: true, apiKey: "" }), /no api key/);
    assert.match(reasonFor({ allGuilds: true }, { content: "   " }), /no text content/);
});

const { OutgoingPatch } = await import("../src/outgoing-patch.js");

check("outgoing: the gate opens only for a target server with the toggle on", () => {
    const inList = "1101573652786446417";
    const pick = (overrides, content = "안녕하세요", channelId = "c") =>
        outgoingWith(overrides, inList)._pick([channelId, { content }]);

    assert.equal(pick({ translateOutgoing: true }), "안녕하세요");

    assert.equal(pick({}), null, "off by default");
    assert.equal(pick({ translateOutgoing: true, apiKey: "" }), null, "no key");
    assert.equal(pick({ translateOutgoing: true }, "안녕하세요", "dm"), null, "dms stay closed by default");
    assert.equal(
        pick({ translateOutgoing: true, translateDms: true }, "안녕하세요", "dm"),
        "안녕하세요",
        "the dm switch opens outgoing translation too",
    );
    assert.equal(
        pick({ translateOutgoing: true, translateDms: true }, "안녕하세요", "unknown"),
        null,
        "an unresolved channel is neither a server nor a dm",
    );
    assert.equal(pick({ translateOutgoing: true }, "   "), null, "nothing to translate");

    assert.equal(pick({ translateOutgoing: true }, "/giphy 안녕"), null);

    assert.equal(pick({ translateOutgoing: true, outgoingLanguage: "ko" }), null);

    assert.equal(pick({ translateOutgoing: true }, "hello there"), "hello there");
    assert.equal(
        outgoingWith({ translateOutgoing: true }, "222222222222222222")._pick([
            "c",
            { content: "안녕하세요" },
        ]),
        null,
        "outside the target list",
    );
});

await checkAsync(
    "outgoing: a translation replaces the content, a failure never eats the message",
    async () => {
        const done = { status: "done", text: "hello there" };
        const sent = [];
        const original = function (channelId, message) {
            sent.push(message.content);
            return "sent";
        };

        const patch = outgoingWith({ translateOutgoing: true }, "1101573652786446417", {
            translate: async () => done,
        });
        await patch._onSend(null, ["c", { content: "안녕하세요" }], original);
        assert.deepEqual(sent, ["hello there"]);

        const failures = [];
        const failing = outgoingWith(
            { translateOutgoing: true },
            "1101573652786446417",
            { translate: async () => ({ status: "error", message: "HTTP 401" }) },
            (message) => failures.push(message),
        );
        await failing._onSend(null, ["c", { content: "안녕하세요" }], original);
        assert.deepEqual(sent, ["hello there", "안녕하세요"]);
        assert.deepEqual(failures, ["HTTP 401"]);

        const throwing = outgoingWith({ translateOutgoing: true }, "1101573652786446417", {
            translate: async () => {
                throw new Error("boom");
            },
        });
        await throwing._onSend(null, ["c", { content: "안녕하세요" }], original);
        assert.deepEqual(sent, ["hello there", "안녕하세요", "안녕하세요"]);
    },
);

await checkAsync(
    "outgoing: the block under your own message is translated afresh, not what you typed",
    async () => {
        const translator = new Translator({ settings: stubSettings() });
        translator.translate = async () => ({ status: "done", text: "that's not it" });
        const patch = outgoingWith({ translateOutgoing: true }, "1101573652786446417", translator);

        await patch._onSend(null, ["c", { content: "그게아닌뒈~" }], () => "sent");
        assert.equal(translator.peek("that's not it").status, "unknown");
    },
);

check("outgoing: the gate is skipped without a promise when it does not apply", () => {
    const patch = outgoingWith({}, "1101573652786446417");
    const result = patch._onSend(null, ["c", { content: "안녕하세요" }], () => "sent");

    assert.equal(result, "sent");
});

await checkAsync("outgoing: a message that needs no translation waits for the one before it", async () => {
    const sent = [];
    const original = (_channelId, message) => {
        sent.push(message.content);
        return "sent";
    };
    const patch = outgoingWith({ translateOutgoing: true }, "1101573652786446417", {
        translate: async (text) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { status: "done", text: `EN:${text}` };
        },
    });

    const first = patch._onSend(null, ["c", { content: "안녕하세요 반가워요" }], original);
    const second = patch._onSend(null, ["c", { content: "👍 https://example.com" }], original);
    assert.equal(typeof second?.then, "function", "the second send is held, not sent on the spot");
    const elsewhere = patch._onSend(null, ["other", { content: "👍" }], original);
    assert.equal(elsewhere, "sent", "another channel is not held up");

    assert.deepEqual(await Promise.all([first, second]), ["sent", "sent"]);
    assert.deepEqual(sent, ["👍", "EN:안녕하세요 반가워요", "👍 https://example.com"]);
    assert.equal(patch._tails.size, 0, "nothing is left waiting once the channel is quiet");
});

await checkAsync("outgoing: a translation Discord would refuse is sent as typed", async () => {
    const sent = [];
    const failures = [];
    const patch = outgoingWith(
        { translateOutgoing: true },
        "1101573652786446417",
        { translate: async () => ({ status: "done", text: "a".repeat(2001) }) },
        (message) => failures.push(message),
    );
    await patch._onSend(null, ["c", { content: "안녕하세요" }], (_c, m) => sent.push(m.content));
    assert.deepEqual(sent, ["안녕하세요"]);
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes("2000"));
});

await checkAsync("outgoing: a rate limit is reported in words", async () => {
    const failures = [];
    const patch = outgoingWith(
        { translateOutgoing: true },
        "1101573652786446417",
        { translate: async () => ({ status: "retry", after: 20000 }) },
        (message) => failures.push(message),
    );
    await patch._onSend(null, ["c", { content: "안녕하세요" }], () => "sent");
    assert.deepEqual(failures, [t("error.busy")]);
});

await checkAsync("queue: an urgent task does not wait for a free slot", async () => {
    const queue = new TaskQueue(() => 1);
    let release;
    const busy = queue.run(() => new Promise((resolve) => (release = resolve)));
    const urgent = await queue.run(() => "now", undefined, { urgent: true });
    assert.equal(urgent, "now");
    release("done");
    assert.equal(await busy, "done");
});

await checkAsync("translator: a request still runs while any block waiting on it is on screen", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "안녕" } }] }), { status: 200 });
    };
    try {
        const settings = stubSettings();
        settings.current.maxConcurrent = 1;
        const translator = new Translator({ settings });

        let release;
        translator._queue.run(() => new Promise((resolve) => (release = resolve)));

        let firstAlive = true;
        const first = translator.translate("hello there", { shouldRun: () => firstAlive });
        const second = translator.translate("hello there", { shouldRun: () => true });
        firstAlive = false;
        await flush();
        release();

        assert.equal((await second).status, "done", "the block still on screen gets its translation");
        assert.equal((await first).status, "done");
        assert.equal(calls, 1);
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: a refused key stops every request and says so once", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 });
    };
    try {
        const listeners = new Set();
        const settings = {
            ...stubSettings(),
            onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
        };
        const reported = [];
        const translator = new Translator({
            settings,
            onError: (message, { fatal }) => reported.push([message, fatal]),
        });
        translator.start();

        const first = await translator.translate("hello there");
        assert.equal(first.status, "error");
        assert.equal(first.message, t("error.badKey"));
        assert.ok(!("retryAt" in first), "asking again with a refused key cannot help");
        assert.equal((await translator.translate("another message entirely")).status, "error");
        assert.equal(calls, 1, "nothing more is sent with a key that was refused");
        assert.deepEqual(reported, [[t("error.badKey"), true]]);

        for (const listener of listeners) listener("showPending", false);
        await translator.translate("yet another message");
        assert.equal(calls, 1, "an unrelated setting does not lift the stop");

        for (const listener of listeners) listener("apiKey", "new-key");
        await translator.translate("yet another message");
        assert.equal(calls, 2, "a new key is tried");
        translator.stop();
        assert.equal(listeners.size, 0);
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: an urgent request is not retried", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response("{}", { status: 500 });
    };
    try {
        const translator = new Translator({ settings: stubSettings() });
        assert.equal((await translator.translate("hello there", { urgent: true })).status, "error");
        assert.equal(calls, 1);
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: the connection test reports the answer or the reason", async () => {
    const previous = BdApi.Net.fetch;
    try {
        BdApi.Net.fetch = async () =>
            new Response(JSON.stringify({ choices: [{ message: { content: "안녕하세요" } }] }), {
                status: 200,
            });
        assert.deepEqual(await new Translator({ settings: stubSettings() }).probe(), {
            ok: true,
            text: "안녕하세요",
        });

        BdApi.Net.fetch = async () => new Response("{}", { status: 402 });
        assert.deepEqual(await new Translator({ settings: stubSettings() }).probe(), {
            ok: false,
            message: t("error.noBalance"),
        });
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync(
    "a long answer the reasoning crowded out is asked for again with room to spare",
    async () => {
        const previous = BdApi.Net.fetch;
        const budgets = [];
        BdApi.Net.fetch = async (_url, options) => {
            const body = JSON.parse(options.body);
            budgets.push(body.max_tokens);
            const cut = budgets.length === 1;
            return new Response(
                JSON.stringify({
                    choices: [
                        {
                            finish_reason: cut ? "length" : "stop",
                            message: { content: cut ? null : "긴 번역" },
                        },
                    ],
                }),
                { status: 200 },
            );
        };
        try {
            const result = await new Translator({ settings: stubSettings() }).translate(
                "a long message ".repeat(40),
            );
            assert.equal(result.text, "긴 번역");
            assert.equal(budgets.length, 2);
            assert.ok(budgets[0] < MAX_OUTPUT_TOKENS);
            assert.equal(budgets[1], MAX_OUTPUT_TOKENS);
        } finally {
            BdApi.Net.fetch = previous;
        }
    },
);

check("detector: Japanese and Chinese are told apart by their kana", () => {
    const settings = { current: { targetLanguage: "ko", skipThreshold: 30 } };
    const cjk = new LanguageDetector(settings);
    const chinese = "你好，我们今天晚上一起去吃饭吧";
    const japanese = "日本語の勉強は本当に難しいと思います";

    assert.equal(cjk.needsTranslation(chinese, "ja"), true, "Chinese is not Japanese");
    assert.equal(cjk.needsTranslation(japanese, "ja"), false);
    assert.equal(cjk.needsTranslation(japanese, "zh"), true, "Japanese is not Chinese");
    assert.equal(cjk.needsTranslation(chinese, "zh"), false);
    assert.equal(
        cjk.needsTranslation("我昨天和朋友一起玩了这个游戏，名字叫ポケモン，真的很好玩", "zh"),
        false,
        "one borrowed word is not Japanese",
    );
});

check("hotkey: a Hangul input source or Option still reaches the letter on the key", () => {
    const combo = parseHotkey("Ctrl+Shift+T");
    const event = (overrides) => ({
        key: "T",
        code: "KeyT",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        ...overrides,
    });
    assert.ok(matchesHotkey(combo, event({ key: "ㅆ" })), "Hangul 2-set gives ㅆ for Shift+T");
    assert.ok(
        matchesHotkey(
            parseHotkey("Alt+T"),
            event({ key: "†", ctrlKey: false, shiftKey: false, altKey: true }),
        ),
    );
    assert.ok(!matchesHotkey(combo, event({ key: "Y", code: "KeyT" })), "a layout's own letter wins");
    assert.ok(!matchesHotkey(combo, event({ key: "ㅛ", code: "KeyY" })));
});

check("cache: a translation that keeps being read outlives newer ones", () => {
    const saved = captureSave(() => {
        const cache = new TranslationCache();
        cache.set("k0", "v0");
        for (let i = 1; i < CACHE_LIMIT + 5; i += 1) {
            cache.set(`k${i}`, `v${i}`);
            if (i === CACHE_LIMIT) cache.get("k0");
        }
        cache.save();
    });
    assert.ok(saved.some(([key]) => key === "k0"));
    assert.ok(!saved.some(([key]) => key === "k1"));
});

const { PROVIDER_OPTIONS } = await import("../src/translation/providers/index.js");

function providerSettings(provider, model, baseUrl) {
    const settings = stubSettings();
    Object.assign(settings.current, { provider, model, baseUrl });
    return settings;
}

await checkAsync("openai: GPT-6 is asked with reasoning at its least and no temperature", async () => {
    const previous = BdApi.Net.fetch;
    let seen = null;
    BdApi.Net.fetch = async (url, options) => {
        seen = { url, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ choices: [{ message: { content: "안녕" } }] }), { status: 200 });
    };
    try {
        const settings = providerSettings("openai", "gpt-6-luna", "https://api.openai.com/v1");
        assert.equal((await new Translator({ settings }).translate("hello there")).text, "안녕");
        assert.equal(seen.url, "https://api.openai.com/v1/chat/completions");
        assert.equal(seen.body.reasoning_effort, "none");
        assert.ok(!("temperature" in seen.body));
        assert.ok(!("max_tokens" in seen.body));
        assert.ok(seen.body.max_completion_tokens > 0);

        settings.current.model = "gpt-6.1-sol";
        await new Translator({ settings }).translate("hello there");
        assert.equal(seen.body.reasoning_effort, "low", "GPT-6.1 Sol cannot switch reasoning off");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("claude: a Messages API request, answered by its text blocks", async () => {
    const previous = BdApi.Net.fetch;
    let seen = null;
    let reply = claudeAnswer("안녕");
    BdApi.Net.fetch = async (url, options) => {
        seen = { url, headers: options.headers, body: JSON.parse(options.body) };
        return new Response(JSON.stringify(reply), { status: 200 });
    };
    try {
        const settings = providerSettings("claude", "claude-haiku-4-5", "https://api.anthropic.com/v1");
        assert.equal((await new Translator({ settings }).translate("hello there")).text, "안녕");
        assert.equal(seen.url, "https://api.anthropic.com/v1/messages", "a pasted /v1 is not doubled");
        assert.equal(seen.headers["x-api-key"], "test-key");
        assert.equal(seen.headers["anthropic-version"], "2023-06-01");
        assert.ok(!("Authorization" in seen.headers));
        assert.equal(seen.body.model, "claude-haiku-4-5");
        assert.equal(typeof seen.body.system, "string");
        assert.deepEqual(seen.body.messages, [{ role: "user", content: "hello there" }]);
        assert.equal(seen.body.output_config.format.type, "json_schema", "the answer is one JSON field");
        assert.ok(!("effort" in seen.body.output_config), "Haiku 4.5 has no effort control");
        assert.ok(!("temperature" in seen.body));
        assert.ok(!("fallbacks" in seen.body));

        settings.current.model = "claude-haiku-5-5";
        await new Translator({ settings }).translate("hello again");
        assert.equal(seen.body.output_config.effort, "low", "Haiku 5.5 takes effort");
        assert.equal(seen.body.output_config.format.type, "json_schema");
        assert.ok(!("fallbacks" in seen.body), "Haiku has no server-side fallback");

        settings.current.model = "claude-sonnet-5";
        reply = {
            stop_reason: "end_turn",
            content: [{ type: "thinking", thinking: "" }, ...claudeAnswer("안녕하세요").content],
        };
        assert.equal((await new Translator({ settings }).translate("hi there")).text, "안녕하세요");
        assert.equal(seen.body.output_config.effort, "low");

        settings.current.model = "claude-sonnet-5-5";
        await new Translator({ settings }).translate("good morning");
        assert.equal(seen.body.fallbacks, "default");
        assert.equal(seen.headers["anthropic-beta"], "server-side-fallback-2026-07-01");

        reply = { stop_reason: "refusal", content: [] };
        const refused = await new Translator({ settings }).translate("something else");
        assert.equal(refused.status, "error");
        assert.equal(refused.message, t("error.refused"));
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("claude: only the translation field is shown, and a cut-off answer is not", async () => {
    const previous = BdApi.Net.fetch;
    let reply = claudeAnswer("내일 봐");
    BdApi.Net.fetch = async () => new Response(JSON.stringify(reply), { status: 200 });
    try {
        const settings = providerSettings("claude", "claude-haiku-5-5", "https://api.anthropic.com");
        assert.equal((await new Translator({ settings }).translate("see you tomorrow")).text, "내일 봐");

        reply = {
            stop_reason: "max_tokens",
            content: [{ type: "text", text: '{"translation": "내일 ' }],
        };
        const cut = await new Translator({ settings }).translate("see you tomorrow");
        assert.equal(cut.status, "error", "half a JSON answer is never put on screen");
        assert.equal(cut.message, t("error.reasoningOnly"));
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("claude: a model that refuses effort is asked again, still for JSON", async () => {
    const previous = BdApi.Net.fetch;
    const bodies = [];
    BdApi.Net.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        bodies.push(body);
        if (body.output_config.effort) {
            return new Response(
                JSON.stringify({
                    type: "error",
                    error: {
                        type: "invalid_request_error",
                        message: "This model does not support the effort parameter.",
                    },
                }),
                { status: 400 },
            );
        }
        return new Response(JSON.stringify(claudeAnswer("안녕")), { status: 200 });
    };
    try {
        const settings = providerSettings("claude", "claude-opus-4-1", "https://api.anthropic.com");
        assert.equal((await new Translator({ settings }).translate("hello there")).text, "안녕");
        assert.equal(bodies.length, 2);
        assert.ok(!("effort" in bodies[1].output_config));
        assert.equal(bodies[1].output_config.format.type, "json_schema");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

check("cache: a Claude answer saved before the answer format is not served again", () => {
    const settings = providerSettings("claude", "claude-haiku-5-5", "https://api.anthropic.com");
    const translator = new Translator({ settings });
    translator._cache.set("claude\u0001claude-haiku-5-5\u0001ko\u0001hello there", null);
    translator._cache.set(
        "claude\u0001claude-haiku-5-5\u0001ko\u0001good night",
        "good night\n\nTranslation: 잘 자",
    );
    assert.equal(translator.peek("hello there").status, "unknown", "a verdict from the free-text answer");
    assert.equal(translator.peek("good night").status, "unknown", "a translation from the free-text answer");

    settings.current.provider = "deepseek";
    settings.current.model = "deepseek-flash";
    translator._cache.set("deepseek\u0001deepseek-flash\u0001ko\u0001hello there", "안녕");
    assert.equal(translator.peek("hello there").text, "안녕", "other backends keep what they saved");
});

await checkAsync("claude: an empty balance stops translation like a refused key", async () => {
    const previous = BdApi.Net.fetch;
    BdApi.Net.fetch = async () =>
        new Response(
            JSON.stringify({
                type: "error",
                error: {
                    type: "invalid_request_error",
                    message: "Your credit balance is too low to access the Anthropic API.",
                },
            }),
            { status: 400 },
        );
    try {
        const settings = providerSettings("claude", "claude-haiku-4-5", "https://api.anthropic.com");
        const reported = [];
        const translator = new Translator({
            settings,
            onError: (message, info) => reported.push([message, info.fatal]),
        });
        const result = await translator.translate("hello there");
        assert.equal(result.message, t("error.noBalance"));
        assert.deepEqual(reported, [[t("error.noBalance"), true]]);
    } finally {
        BdApi.Net.fetch = previous;
    }
});

check("providers: exactly the five supported backends are offered", () => {
    assert.deepEqual(
        PROVIDER_OPTIONS.map((option) => option.value),
        ["deepseek", "gemini", "openai", "claude", "deepl"],
    );
});

check("detector: a Latin-alphabet target skips only what is clearly written in it", () => {
    const latin = new LanguageDetector({ current: { targetLanguage: "en", skipThreshold: 30 } });
    const cases = [
        ["en", "what are you doing with that thing", false],
        ["en", "que es muy bueno para mí", true],
        ["en", "ok thanks", true],
        ["en", "안녕하세요 반가워요 hello", true],
        ["es", "que es muy bueno para mí", false],
        ["es", "o que você está fazendo agora", true],
        ["pt-BR", "o que você está fazendo agora", false],
        ["pt-PT", "o que você está fazendo agora", false],
        ["fr", "je ne sais pas ce que tu veux", false],
        ["fr", "ich bin nicht sicher was du willst", true],
        ["de", "ich bin nicht sicher was du willst", false],
        ["id", "aku tidak tahu apa yang kamu mau", false],
        ["vi", "tôi không biết bạn muốn gì", false],
        ["vi", "what are you doing with that thing", true],
        ["en", "hey <@123456789> what are you doing with that", false],
    ];
    for (const [target, text, expected] of cases) {
        assert.equal(latin.needsTranslation(text, target), expected, `${target}: ${text}`);
    }
});

check("rich text: Markdown renders as elements, and a spoiler stays hidden until clicked", () => {
    const text = (value) => [{ type: "text", value }];
    const flat = (node) =>
        typeof node === "string"
            ? node
            : []
                  .concat(node?.props?.children ?? [])
                  .map(flat)
                  .join("");

    const [bold, , struck] = renderSegments(text("**굵게** 그리고 ~~취소~~"), {}, null);
    assert.equal(bold.type, "strong");
    assert.equal(flat(bold), "굵게");
    assert.equal(struck.type, "s");

    const [spoiler] = renderSegments(text("||범인은 **집사**||"), {}, null);
    assert.equal(spoiler.props.children[0], "범인은 ");
    assert.equal(spoiler.props.children[1].type, "strong");
    const hidden = spoiler.type({ children: spoiler.props.children });
    assert.equal(hidden.props.className, "mollu-md-spoiler");
    assert.equal(hidden.props.role, "button");

    const nodes = renderSegments(
        [
            { type: "text", value: "# 제목\n> 인용\n본문 [여기](" },
            { type: "token", value: "https://example.com/a" },
            { type: "text", value: ")" },
        ],
        {},
        null,
    );
    assert.equal(nodes[0].props.className, "mollu-md-h1");
    assert.equal(nodes[1].props.className, "mollu-md-quote");
    assert.equal(nodes[2], "본문 ");
    assert.equal(nodes[3].type, "a");
    assert.equal(nodes[3].props.href, "https://example.com/a");
    assert.equal(flat(nodes[3]), "여기");

    assert.deepEqual(renderSegments(text("snake_case_name 그대로"), {}, null), ["snake_case_name 그대로"]);
    assert.deepEqual(renderSegments(text("1 * 2 * 3"), {}, null), ["1 * 2 * 3"]);
});

check("context menu: a server and a channel are switched from their right-click menus", () => {
    const previousData = BdApi.Data;
    const previousMenu = BdApi.ContextMenu;
    const store = new Map();
    BdApi.Data = {
        load: (name, key) => store.get(`${name}::${key}`),
        save: (name, key, value) => store.set(`${name}::${key}`, value),
        delete: (name, key) => store.delete(`${name}::${key}`),
    };
    const patches = new Map();
    BdApi.ContextMenu = {
        patch: (navId, callback) => {
            patches.set(navId, callback);
            return () => patches.delete(navId);
        },
        buildItem: (item) => item,
    };
    try {
        const settings = new Settings();
        const menus = new ContextMenus({ settings });
        menus.install();
        assert.deepEqual([...patches.keys()].sort(), [
            "channel-context",
            "guild-context",
            "message",
            "thread-context",
        ]);

        const open = (navId, props) => {
            const tree = { props: { children: [] } };
            patches.get(navId)(tree, props);
            return tree.props.children.find((item) => item.type === "toggle");
        };
        const guild = { id: "111111111111111111" };
        let item = open("guild-context", { guild });
        assert.equal(item.checked, false);
        item.action();
        assert.ok(settings.guildIdSet.has(guild.id));
        assert.equal(open("guild-context", { guild }).checked, true);

        const channel = { id: "222222222222222222", guild_id: guild.id };
        assert.equal(
            open("channel-context", { channel: { id: "3", guild_id: "999" } }),
            undefined,
            "no switch outside a target server",
        );
        item = open("channel-context", { channel });
        assert.equal(item.checked, true);
        item.action();
        assert.ok(settings.excludedChannelSet.has(channel.id));

        const patch = new MessagePatch({
            target: {},
            translator: {},
            languageDetector: {},
            settings,
            stores: {
                guildIdForChannel: () => guild.id,
                isDirectMessage: () => false,
                currentUserId: () => "me",
                parentChannelId: (id) => (id === "thread" ? channel.id : null),
            },
        });
        settings.set("apiKey", "test-key");
        assert.equal(patch._resolve(message({ channel_id: channel.id })).reason, "channel is excluded");
        assert.equal(patch._resolve(message({ channel_id: "thread" })).reason, "channel is excluded");
        assert.equal(patch._resolve(message({ channel_id: "other" })).ok, true);

        settings.set("allGuilds", true);
        item = open("guild-context", { guild: { id: "333333333333333333" } });
        assert.equal(item.checked, true);
        assert.equal(item.disabled, true);

        menus.remove();
        assert.equal(patches.size, 0);
    } finally {
        BdApi.Data = previousData;
        BdApi.ContextMenu = previousMenu;
    }
});

check("translator: forgetting a sentence drops only its entry for the current target", () => {
    const settings = stubSettings();
    const translator = new Translator({ settings });
    translator.remember("hello there", "안녕하세요", "ko");
    translator.remember("good night", "잘 자", "ko");
    translator.remember("hello there", "こんにちは", "ja");

    translator.forget("hello there");
    assert.equal(translator.isCached("hello there"), false);
    assert.equal(translator.peek("hello there").status, "unknown");
    assert.equal(translator.peek("good night").text, "잘 자", "other sentences stay");

    settings.current.targetLanguage = "ja";
    assert.equal(translator.peek("hello there").text, "こんにちは", "other targets stay");
});

check("context menu: a message's translation is hidden or asked for again from its right-click menu", () => {
    const previousMenu = BdApi.ContextMenu;
    const patches = new Map();
    BdApi.ContextMenu = {
        patch: (navId, callback) => {
            patches.set(navId, callback);
            return () => patches.delete(navId);
        },
        buildItem: (item) => item,
    };
    try {
        const settings = stubSettings();
        const translator = new Translator({ settings });
        translator.remember("hello there", "안녕하세요", "ko");
        const blocks = new BlockControls({ translator });
        const menus = new ContextMenus({ settings, blocks });
        menus.install();

        const open = (id) => {
            const tree = { props: { children: [] } };
            patches.get("message")(tree, { message: { id } });
            return tree.props.children.filter((item) => item.type !== "separator");
        };
        const ids = (id) => open(id).map((item) => item.id);

        assert.deepEqual(open("m1"), [], "a message without a block gets nothing, not a stray separator");

        let status = "done";
        const events = [];
        const handle = (name, text) => ({
            text,
            status: () => status,
            refresh: () => events.push(`${name}:refresh`),
            retranslate: () => events.push(`${name}:retranslate`),
        });
        const unmount = blocks.mount("m1", handle("a", "hello there"));
        blocks.mount("m2", handle("b", "hello there"));
        blocks.mount("m3", handle("c", "good night"));

        const [show] = open("m1");
        assert.equal(show.checked, true);
        show.action();
        assert.ok(blocks.isHidden("m1"));
        assert.deepEqual(events, ["a:refresh"], "only that message's block redraws");
        assert.deepEqual(ids("m1"), ["mollu-show-translation"], "a hidden translation can only be shown");
        open("m1")[0].action();
        assert.equal(blocks.isHidden("m1"), false);

        events.length = 0;
        open("m1")
            .find((item) => item.id === "mollu-retranslate")
            .action();
        assert.equal(translator.isCached("hello there"), false);
        assert.deepEqual(events, ["a:retranslate", "b:retranslate"], "every block with that text is redone");
        assert.deepEqual(ids("m1"), ["mollu-show-translation"], "nothing to redo until the new one lands");

        translator._cache.set(translator._cacheKey("hello there", "ko"), null);
        status = "skip";
        assert.deepEqual(
            ids("m1"),
            ["mollu-retranslate"],
            "a sentence judged already translated can be retried",
        );
        status = "idle";
        translator.forget("hello there");
        assert.deepEqual(ids("m1"), [], "nothing to hide or redo before a translation");

        settings.current.provider = "deepl";
        settings.current.model = "";
        translator.remember("hello there", "안녕하세요", "ko");
        status = "done";
        assert.deepEqual(ids("m1"), ["mollu-show-translation"], "DeepL would answer the same again");

        unmount();
        assert.deepEqual(open("m1"), []);
        menus.remove();
    } finally {
        BdApi.ContextMenu = previousMenu;
    }
});

check("translation block: hidden leaves nothing in automatic mode and the button in manual mode", () => {
    const translator = new Translator({ settings: stubSettings() });
    translator.remember("hello there", "안녕하세요", "ko");
    const blocks = new BlockControls({ translator });
    const render = (autoTranslate) => {
        const settings = stubSettings();
        settings.current.autoTranslate = autoTranslate;
        settings.onChange = () => () => {};
        const block = TranslationBlock({
            text: "hello there",
            messageId: "m1",
            translator,
            blocks,
            settings,
            stores: {},
            guildId: null,
        });
        return block.props.children[1];
    };

    assert.equal(render(true).props.className, "mollu-translation");
    blocks.setHidden("m1", true);
    assert.equal(render(true), null);
    assert.equal(render(false).props.className, "mollu-translation__trigger");

    blocks.clear();
    assert.equal(render(false).props.className, "mollu-translation", "stopping the plugin shows them again");
});

await checkAsync("translation block: a failure on screen is asked again by itself, a few times", async () => {
    const random = Math.random;
    Math.random = () => 0;
    try {
        await failuresRetried();
    } finally {
        Math.random = random;
    }
});

async function failuresRetried() {
    const failing = (retryAt) => ({ status: "error", message: "HTTP 500", ...(retryAt && { retryAt }) });

    let calls = 0;
    const flaky = await mountBlock(async () => {
        calls += 1;
        return failing(Date.now() + 10);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(calls, 1 + MAX_FAILURE_RETRIES, "it stops after a few tries");
    assert.equal(flaky.result().status, "error", "and the failure stays on screen to click");
    flaky.unmount();

    let fatalCalls = 0;
    const fatal = await mountBlock(async () => {
        fatalCalls += 1;
        return failing();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fatalCalls, 1, "a failure asking again cannot fix is left alone");
    fatal.unmount();

    let healed = 0;
    const recovering = await mountBlock(async () => {
        healed += 1;
        return healed === 1 ? failing(Date.now() + 10) : { status: "done", text: "안녕", segments: [] };
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(healed, 2);
    assert.equal(recovering.result().status, "done", "the retry's translation replaces the failure");
    recovering.unmount();

    let goneCalls = 0;
    const gone = await mountBlock(async () => {
        goneCalls += 1;
        return failing(Date.now() + 30);
    });
    gone.unmount();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(goneCalls, 1, "a message that went away is not asked about again");
}

check("settings: the everyday sections are open, and the fine-tuning ones start folded", () => {
    const sections = new Settings()._panelSpec().settings;
    assert.ok(sections.every((entry) => entry.type === "category"));
    assert.deepEqual(
        sections.map((entry) => [entry.id, entry.shown]),
        [
            ["connection", true],
            ["translate", true],
            ["outgoing", true],
            ["details", false],
            ["advanced", false],
        ],
    );
    const ids = (index) => sections[index].settings.map((entry) => entry.id);
    assert.deepEqual(ids(0), ["provider", "apiKey", "model", "testConnection"]);
    assert.deepEqual(ids(1), ["targetLanguage", "autoTranslate", "allGuilds", "translateDms"]);
    assert.deepEqual(ids(2), ["translateOutgoing", "outgoingLanguage"]);
});

check("settings: a field that depends on a switch is disabled the right way round", () => {
    const settings = new Settings();
    const field = (id) => panelFields(settings).find((entry) => entry.id === id);

    settings.set("allGuilds", false);
    settings.set("translateOutgoing", false);
    assert.equal(field("guildIds").disabled, false, "the server list is what counts here");
    assert.equal(field("outgoingLanguage").disabled, true);

    settings.set("allGuilds", true);
    settings.set("translateOutgoing", true);
    assert.equal(field("guildIds").disabled, true, "every server is on, so the list is unused");
    assert.equal(field("outgoingLanguage").disabled, false);

    assert.ok(panelFields(settings).every((entry) => !entry.enableWith && !entry.disableWith));
});

await checkAsync(
    "updater: only a release signed with the shipped key is offered, and only installed on yes",
    async () => {
        const { generateKeyPairSync, sign } = await import("node:crypto");
        const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
        const signed = (text) =>
            sign("sha256", Buffer.from(text), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
                "base64",
            );

        const release = "/**\n * @name Mollu\n * @version 1.3.0\n */\nvar x = 1; // 번역\n";
        assert.equal(
            await verifySignature(release, signed(release), spki),
            true,
            "Node's signature verifies in WebCrypto",
        );
        assert.equal(await verifySignature(release + " ", signed(release), spki), false);
        assert.equal(await verifySignature(release, signed(release), ""), false, "no key, no install");

        let served = { text: release, sig: signed(release) };
        const previous = BdApi.Net.fetch;
        BdApi.Net.fetch = async (url) => {
            const body = url.endsWith(".sig") ? served.sig : served.text;
            return body == null
                ? new Response("Not Found", { status: 404 })
                : new Response(body, { status: 200 });
        };
        const make = (answer) => {
            const log = { results: [], asked: 0, written: [] };
            const updater = new Updater({
                meta: { source: "https://github.com/nyabi-gh/Undertone", version: "1.2.0" },
                settings: { current: { autoUpdate: true } },
                onResult: (result) => log.results.push(result),
                confirm: async (offer) => {
                    log.asked += 1;
                    assert.deepEqual(offer, { version: "1.3.0", current: "1.2.0" });
                    return answer;
                },
                publicKey: spki,
                write: (text) => log.written.push(text),
            });
            return { updater, log };
        };
        try {
            let { updater, log } = make(true);
            assert.equal(await updater.check(), "1.3.0");
            assert.deepEqual(log.written, [release]);
            assert.deepEqual(log.results, [{ status: "updated", version: "1.3.0" }]);

            ({ updater, log } = make(false));
            const [first, second] = [updater.check(), updater.check()];
            assert.equal(first, second, "overlapping checks share one run");
            assert.equal(await first, null);
            assert.equal(log.asked, 1);
            await updater.check();
            assert.equal(log.asked, 1, "a background check does not ask again about the same version");
            await updater.check({ announce: true });
            assert.equal(log.asked, 2, "checking by hand offers it again");
            assert.deepEqual(log.written, []);

            ({ updater, log } = make(true));
            served = { text: release, sig: signed(release.replace("번역", "악성")) };
            await updater.check();
            assert.deepEqual(log.results, [{ status: "badSignature", version: "1.3.0" }]);
            assert.equal(log.asked, 0);

            ({ updater, log } = make(true));
            served = { text: release, sig: null };
            await updater.check();
            assert.deepEqual(log.results, [{ status: "unsigned", version: "1.3.0" }]);
            assert.deepEqual(log.written, []);
        } finally {
            BdApi.Net.fetch = previous;
        }
    },
);

await checkAsync(
    "translator: an overloaded backend is waited out, not hammered or reported as failed",
    async () => {
        const previous = BdApi.Net.fetch;
        let calls = 0;
        BdApi.Net.fetch = async () => {
            calls += 1;
            return new Response(
                JSON.stringify({ error: { code: 503, message: "The model is overloaded." } }),
                {
                    status: 503,
                },
            );
        };
        try {
            const translator = new Translator({ settings: stubSettings() });
            const result = await translator.translate("hello there");
            assert.equal(result.status, "retry");
            assert.equal(calls, 1, "no quick retries against an overloaded backend");
            assert.ok(translator._pausedUntil > Date.now());
            assert.equal(translator._failures.size, 0);
        } finally {
            BdApi.Net.fetch = previous;
        }
    },
);

await checkAsync("translator: a per-minute quota named in a 429 paces the requests after it", async () => {
    const previous = BdApi.Net.fetch;
    BdApi.Net.fetch = async () =>
        new Response(
            JSON.stringify([
                {
                    error: {
                        code: 429,
                        details: [
                            {
                                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                                violations: [
                                    {
                                        quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
                                        quotaDimensions: {
                                            location: "global",
                                            model: "gemini-3.1-flash-lite",
                                        },
                                        quotaValue: "15",
                                    },
                                ],
                            },
                            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" },
                        ],
                    },
                },
            ]),
            { status: 429 },
        );
    try {
        const translator = new Translator({ settings: stubSettings() });
        const result = await translator.translate("hello there");
        assert.equal(result.after, 3000);
        assert.equal(translator._spacing, 4200, "15 a minute is one every four seconds, with a margin");

        translator._spacing = 40;
        translator._nextSlot = 0;
        const started = Date.now();
        await Promise.all([translator._awaitSlot(), translator._awaitSlot(), translator._awaitSlot()]);
        assert.ok(Date.now() - started >= 75, "three requests take two gaps");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

await checkAsync("translator: a message scrolled away during a pause gives up its paced slot", async () => {
    const previous = BdApi.Net.fetch;
    let calls = 0;
    BdApi.Net.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "안녕" } }] }), { status: 200 });
    };
    try {
        const translator = new Translator({ settings: stubSettings() });
        translator._spacing = 5000;
        translator._nextSlot = 0;
        translator._pausedUntil = Date.now() + 40;
        let visible = true;
        const pending = translator.translate("hello there", { shouldRun: () => visible });
        visible = false;
        const result = await pending;
        assert.equal(result.status, "unknown", "nobody wants it once the pause ends");
        assert.equal(calls, 0);
        assert.equal(translator._nextSlot, 0, "no slot is reserved for it");
    } finally {
        BdApi.Net.fetch = previous;
    }
});

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

function loadPlugin(path) {
    const source = readFileSync(path, "utf8");
    const moduleObj = { filename: path, exports: {} };
    const wrapped = new Function("require", "module", "exports", "__filename", "__dirname", source);
    wrapped(() => ({}), moduleObj, moduleObj.exports, path, dirname(path));
    let exported = moduleObj.exports;
    if (exported && exported.default) exported = exported.default;
    return exported;
}

function outgoingWith(overrides, targetGuildId = "", translator = null, onFailure = null) {
    const guildId = "1101573652786446417";
    const settings = {
        current: {
            apiKey: "test-key",
            allGuilds: false,
            maxChars: 3000,
            targetLanguage: "ko",
            translateOutgoing: false,
            outgoingLanguage: "en",
            skipThreshold: 30,
            ...overrides,
        },
        guildIdSet: new Set(targetGuildId ? [targetGuildId] : []),
    };
    return new OutgoingPatch({
        target: {},
        settings,
        translator: translator ?? { translate: async () => ({ status: "unknown" }) },
        languageDetector: new LanguageDetector(settings),
        stores: channelStub(guildId),
        onFailure: onFailure ?? (() => {}),
    });
}

function panelFields(settings) {
    return settings._panelSpec().settings.flatMap((entry) => entry.settings ?? entry);
}

function patchWith(overrides, targetGuildId = "") {
    const guildId = "1101573652786446417";
    return new MessagePatch({
        target: {},
        translator: {},
        languageDetector: {},
        settings: {
            current: {
                apiKey: "test-key",
                allGuilds: false,
                translateBots: true,
                translateOwnMessages: false,
                ...overrides,
            },
            guildIdSet: new Set(targetGuildId ? [targetGuildId] : []),
        },
        stores: { ...channelStub(guildId), currentUserId: () => "me" },
    });
}

function channelStub(guildId) {
    const dms = new Set(["dm", "group"]);
    const unresolved = new Set(["unknown"]);
    return {
        guildIdForChannel: (channelId) => (dms.has(channelId) || unresolved.has(channelId) ? null : guildId),
        isDirectMessage: (channelId) => dms.has(channelId),
    };
}

function message(overrides) {
    return { type: 0, content: "hello there", author: { id: "someone" }, channel_id: "c", ...overrides };
}

function stubSettings() {
    return {
        current: {
            provider: "deepseek",
            apiKey: "test-key",
            model: "deepseek-flash",
            baseUrl: "https://api.deepseek.com",
            targetLanguage: "ko",
            maxChars: 3000,
            maxConcurrent: 2,
        },
    };
}

// Runs a block's effects for real, with no IntersectionObserver, so it counts as on screen.
async function mountBlock(translate) {
    const react = BdApi.React;
    const hooks = { useState: react.useState, useEffect: react.useEffect };
    const slots = [];
    const effects = [];
    react.useState = (init) => {
        const slot = { value: typeof init === "function" ? init() : init };
        slots.push(slot);
        return [
            slot.value,
            (next) => {
                slot.value = typeof next === "function" ? next(slot.value) : next;
            },
        ];
    };
    react.useEffect = (effect) => effects.push(effect);

    const translator = { peek: () => ({ status: "unknown" }), translate };
    const settings = stubSettings();
    Object.assign(settings.current, { autoTranslate: true, showPending: true });
    settings.onChange = () => () => {};
    const cleanups = [];
    try {
        TranslationBlock({
            text: "hello there",
            messageId: "m1",
            translator,
            blocks: new BlockControls({ translator }),
            settings,
            stores: {},
            guildId: null,
        });
        for (const effect of effects) {
            const cleanup = effect();
            if (typeof cleanup === "function") cleanups.push(cleanup);
        }
    } finally {
        Object.assign(react, hooks);
    }
    const result = slots.find(
        (slot) => slot.value && typeof slot.value === "object" && "status" in slot.value,
    );
    await flush();
    return { result: () => result.value, unmount: () => cleanups.forEach((cleanup) => cleanup()) };
}

function claudeAnswer(translation) {
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ translation }) }] };
}

function unsupported(kind, param) {
    const message =
        kind === "value"
            ? `Unsupported value: '${param}' does not support 0.2 with this model.`
            : `Unsupported parameter: '${param}' is not supported with this model.`;
    return new Response(JSON.stringify({ error: { message, param, type: "invalid_request_error" } }), {
        status: 400,
    });
}

function scrollScene({ anchorTop }) {
    const scroller = {
        scrollTop: 500,
        scrollHeight: 4000,
        clientHeight: 600,
        style: { overflowY: "scroll" },
        parentElement: null,
        getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
    };
    const anchor = {
        parentElement: scroller,
        getBoundingClientRect: () => ({ top: anchorTop }),
    };
    return { scroller, anchor };
}

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function captureSave(fn) {
    const previous = BdApi.Data.save;
    let captured = null;
    BdApi.Data.save = (_name, key, value) => {
        if (key === CACHE_KEY) captured = value;
    };
    try {
        fn();
    } finally {
        BdApi.Data.save = previous;
    }
    assert.ok(Array.isArray(captured), "cache.save() wrote nothing");
    return captured;
}

function installBdApiStub() {
    const noop = () => {};
    globalThis.BdApi = {
        React: {
            createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
            cloneElement: (el, props, ...children) => ({ ...el, props: { ...el.props, ...props, children } }),
            useState: (init) => [typeof init === "function" ? init() : init, noop],
            useEffect: noop,
            useLayoutEffect: noop,
            useMemo: (fn) => fn(),
            useCallback: (fn) => fn,
            useRef: (v = null) => ({ current: v }),
            Fragment: "Fragment",
        },
        Data: { load: () => null, save: noop, delete: noop },
        DOM: { addStyle: noop, removeStyle: noop },
        Plugins: { folder: "", get: () => null, isEnabled: () => false, enable: noop, disable: noop },
        UI: {
            buildSettingsPanel: (spec) => ({ __spec: spec }),
            showToast: noop,
        },
        Patcher: { after: () => noop, unpatchAll: noop },
        Logger: { info: noop, warn: noop, error: noop },
        Net: { fetch: async () => new Response("{}", { status: 200 }) },
        Webpack: {
            getModule: () => null,
            getStore: () => ({ getChannel: () => null, getCurrentUser: () => null }),
            *getWithKey() {
                yield null;
                yield null;
            },
            Filters: {
                byStrings: () => () => false,
                byComponentType: (f) => f,
                byDisplayName: () => () => false,
            },
        },
    };
}
