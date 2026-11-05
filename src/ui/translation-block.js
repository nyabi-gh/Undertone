import { React } from "../discord.js";
import { renderSegments } from "./rich-text.js";
import { observeVisibility } from "./visibility.js";
import { blockHeight, keepPlace, whenSteady } from "./scroll.js";
import { MAX_RATE_LIMIT_RETRIES, MAX_FAILURE_RETRIES } from "../constants.js";
import { badgeFor } from "../languages.js";
import { t } from "../i18n.js";

const DWELL_MS = 350;

// A fresh object with the same content would still re-render the block and re-parse its Markdown.
function sameResult(a, b) {
    return (
        a?.status === b?.status &&
        a?.text === b?.text &&
        a?.message === b?.message &&
        a?.waiting === b?.waiting
    );
}

function initialResult(translator, text) {
    const known = translator.peek(text);
    return known.status === "done" || known.status === "skip" ? known : { status: "idle" };
}

export function TranslationBlock({ text, messageId, translator, blocks, settings, stores, guildId }) {
    const anchorRef = React.useRef(null);
    const bodyRef = React.useRef(null);
    const heightRef = React.useRef(null);
    const { showPending, autoTranslate, targetLanguage, maxChars, provider, model } =
        useDisplaySettings(settings);
    const triggerRef = React.useRef(null);
    const statusRef = React.useRef(null);
    const forcedRef = React.useRef(false);
    const [result, setStoredResult] = React.useState(() => initialResult(translator, text));
    const setResult = React.useCallback(
        (next) => setStoredResult((prev) => (sameResult(prev, next) ? prev : next)),
        [],
    );
    const [hidden, setHidden] = React.useState(() => blocks.isHidden(messageId));
    const [round, setRound] = React.useState(0);

    React.useEffect(
        () =>
            blocks.mount(messageId, {
                text,
                status: () => statusRef.current,
                refresh: () => setHidden(blocks.isHidden(messageId)),
                retranslate: () => {
                    forcedRef.current = true;
                    setRound((n) => n + 1);
                },
            }),
        [blocks, messageId, text],
    );

    React.useEffect(() => {
        let alive = true;
        let visible = false;
        let dwell = null;
        let running = false;
        let rateLimitRetries = 0;
        let failureRetries = 0;
        let release = null;

        const present = (next) => {
            release?.();
            release = whenSteady(anchorRef.current, () => {
                if (alive) setResult(next);
            });
        };

        const forced = forcedRef.current;
        forcedRef.current = false;

        const known = translator.peek(text);
        if (known.status === "done" || known.status === "skip") {
            setResult(known);
            return undefined;
        }
        setResult({ status: forced ? "pending" : "idle" });

        const schedule = (delay, onFire) => {
            dwell = setTimeout(() => {
                dwell = null;
                onFire?.();
                run();
            }, delay);
        };

        const cancelScheduled = () => {
            if (dwell != null) clearTimeout(dwell);
            dwell = null;
        };

        // Off screen a retry is not worth a request, and a backend that keeps failing is left
        // alone after a few tries until the reader clicks.
        const retryAfterFailure = (retryAt) => {
            if (!visible || dwell != null || failureRetries >= MAX_FAILURE_RETRIES) return;
            schedule(Math.max(0, retryAt - Date.now()) + jitter(), () => {
                failureRetries += 1;
            });
        };

        const run = (force) => {
            if (!alive || running) return;
            running = true;
            if (force) {
                rateLimitRetries = 0;
                failureRetries = 0;
                cancelScheduled();
            }
            translator
                .translate(text, {
                    ignoreBackoff: force === true,

                    onStart: () => {
                        if (alive) present({ status: "pending" });
                    },
                    shouldRun: () => alive && visible,
                })
                .then((res) => {
                    if (!alive) return;
                    running = false;

                    if (res.status === "retry") {
                        present({ status: "pending", waiting: true });
                        if (visible && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                            rateLimitRetries += 1;
                            schedule(res.after + jitter());
                        } else {
                            present({ status: "error", message: t("error.rateLimited") });
                        }
                        return;
                    }

                    if (res.status === "error" && res.retryAt != null) retryAfterFailure(res.retryAt);
                    present(res.status === "unknown" ? { status: "idle" } : res);
                });
        };

        triggerRef.current = run;

        const dispose = () => {
            alive = false;
            release?.();
            cancelScheduled();
        };

        if (!autoTranslate) {
            visible = true;
            if (forced) run(true);
            return dispose;
        }

        if (forced) {
            visible = true;
            run(true);
        }

        const stopObserving = observeVisibility(anchorRef.current, (isVisible) => {
            visible = isVisible;
            if (isVisible) {
                if (dwell == null && !running) schedule(DWELL_MS);
            } else {
                cancelScheduled();
            }
        });

        if (!stopObserving) {
            visible = true;
            run();
            return dispose;
        }

        return () => {
            dispose();
            stopObserving();
        };
    }, [text, autoTranslate, targetLanguage, maxChars, provider, model, round]);

    const status = result && result.status;
    statusRef.current = status;
    const content = React.useMemo(
        () =>
            status === "done"
                ? renderSegments(result.segments || [{ type: "text", value: result.text }], stores, guildId)
                : null,
        [result, stores, guildId],
    );

    React.useLayoutEffect(() => {
        const height = blockHeight(bodyRef.current);
        const previous = heightRef.current;
        heightRef.current = height;

        // The first pass only records what the message was born with. A block that was already
        // in its first layout pushed nothing, and Discord accounts for it like any other height.
        if (previous !== null) keepPlace(anchorRef.current, height - previous);
    }, [status, hidden]);

    const reveal = () => {
        blocks.setHidden(messageId, false);
        if (status !== "done") triggerRef.current?.(true);
    };

    return React.createElement(
        React.Fragment,
        null,
        React.createElement("div", {
            ref: anchorRef,
            className: "mollu-translation__anchor",
            "aria-hidden": "true",
        }),
        hidden
            ? autoTranslate
                ? null
                : renderTrigger(bodyRef, reveal)
            : renderBody(status, result, {
                  ref: bodyRef,
                  showPending,
                  content,
                  autoTranslate,
                  badge: badgeFor(targetLanguage),
                  language: targetLanguage,
                  onTrigger: () => triggerRef.current?.(true),
              }),
    );
}

function renderTrigger(ref, onClick) {
    return React.createElement(
        "button",
        { ref, type: "button", className: "mollu-translation__trigger", onClick },
        t("block.trigger"),
    );
}

function jitter() {
    return Math.floor(Math.random() * 2000);
}

function renderBody(status, result, ctx) {
    const { ref, showPending, content, autoTranslate, onTrigger, badge, language } = ctx;
    if (status === "idle" && !autoTranslate) return renderTrigger(ref, onTrigger);
    if (!status || status === "idle" || status === "unknown" || status === "skip") return null;
    if (status === "retry") return null;
    if (status === "pending") {
        return showPending
            ? React.createElement(
                  "div",
                  { ref, className: "mollu-translation mollu-translation--pending" },
                  t(result?.waiting ? "block.waiting" : "block.pending"),
              )
            : null;
    }
    // Always shown: a block that vanishes after "Translating…" reads as the plugin hanging.
    if (status === "error") {
        return React.createElement(
            "button",
            {
                ref,
                type: "button",
                className: "mollu-translation mollu-translation--error",
                title: t("block.errorTitle"),
                onClick: onTrigger,
            },
            t("block.error", { message: result?.message || "unknown" }),
        );
    }
    return React.createElement(
        "div",
        { ref, className: "mollu-translation", lang: language },
        React.createElement("span", { className: "mollu-translation__badge" }, badge),
        React.createElement("span", { className: "mollu-translation__text" }, ...content),
    );
}

function useDisplaySettings(settings) {
    const [display, setDisplay] = React.useState(() => pickDisplay(settings));

    React.useEffect(() => {
        const unsubscribe = settings.onChange((id) => {
            if (MIRRORED.has(id)) setDisplay(pickDisplay(settings));
        });
        return () => {
            unsubscribe();
        };
    }, [settings]);

    return display;
}

const MIRRORED = new Set(["showPending", "autoTranslate", "targetLanguage", "maxChars", "provider", "model"]);

function pickDisplay(settings) {
    const { showPending, autoTranslate, targetLanguage, maxChars, provider, model } = settings.current;
    return { showPending, autoTranslate, targetLanguage, maxChars, provider, model };
}
