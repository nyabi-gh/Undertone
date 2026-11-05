import {
    NAME,
    ERROR_TOAST_COOLDOWN_MS,
    UPDATE_CHECK_INTERVAL_MS,
    UPDATE_CHECK_DELAY_MS,
} from "./constants.js";
import { Settings } from "./settings.js";
import { Translator } from "./translation/translator.js";
import { LanguageDetector } from "./translation/language-detector.js";
import { MessagePatch } from "./message-patch.js";
import { Hotkey } from "./hotkey.js";
import { OutgoingPatch, findMessageActions, waitForMessageActions } from "./outgoing-patch.js";
import { Updater } from "./updater.js";
import { isLegacyCopy, handOff, retireLegacy, reclaimInterimData } from "./rename.js";
import { ContextMenus } from "./context-menu.js";
import { BlockControls } from "./ui/block-controls.js";
import { findMessageContent, waitForMessageContent, createStores } from "./discord.js";
import { hasNativeFetch } from "./lib/net.js";
import { STYLES } from "./ui/styles.js";
import { disconnectVisibility } from "./ui/visibility.js";
import { disconnectScroll } from "./ui/scroll.js";
import { t } from "./i18n.js";
import { getLanguage } from "./languages.js";
import { logger } from "./lib/logger.js";

export default class Mollu {
    constructor(meta) {
        this._meta = meta;
        this._stores = createStores();
        // Settings reads its data the moment it is built.
        reclaimInterimData();
        this._settings = new Settings({
            guildName: (id) => this._stores.guildName(id),
            channelName: (id) => this._stores.channelName(id),
            clearCache: () => this._confirmClearCache(),
            checkUpdate: () => this._updater.check({ announce: true }),
            testConnection: () => this._testConnection(),
        });
        this._detector = new LanguageDetector(this._settings);
        this._translator = new Translator({
            settings: this._settings,
            onError: (message, { fatal }) => this._notifyError(message, fatal),
        });
        this._blocks = new BlockControls({ translator: this._translator });
        this._patch = null;
        this._outgoing = null;
        this._pending = null;
        this._hotkeys = [
            new Hotkey({
                settings: this._settings,
                field: "hotkey",
                onTrigger: () => this._toggle("autoTranslate", "toast.autoOn", "toast.autoOff"),
            }),
            new Hotkey({
                settings: this._settings,
                field: "outgoingHotkey",
                onTrigger: () => this._toggle("translateOutgoing", "toast.outgoingOn", "toast.outgoingOff"),
            }),
        ];
        this._updater = new Updater({
            meta,
            settings: this._settings,
            interval: UPDATE_CHECK_INTERVAL_MS,
            delay: UPDATE_CHECK_DELAY_MS,
            onResult: (result) => this._reportUpdate(result),
            confirm: (offer) => this._confirmUpdate(offer),
        });
        this._menus = new ContextMenus({ settings: this._settings, blocks: this._blocks });
        this._lastErrorToast = 0;
    }

    getName() {
        return this._meta?.name ?? NAME;
    }

    getSettingsPanel() {
        return this._settings.buildPanel();
    }

    start() {
        if (isLegacyCopy(this._meta)) return this._handOff();
        try {
            retireLegacy();
            BdApi.DOM.addStyle(NAME, STYLES);
            this._translator.start();

            for (const hotkey of this._hotkeys) hotkey.install();
            this._updater.start();

            this._pending = new AbortController();
            const stores = this._stores;
            this._menus.install();
            this._installOutgoing(stores);

            if (!hasNativeFetch()) {
                this._toast(t("toast.outdatedBd"), "warning");
            }

            this._installMessagePatch(stores);

            if (!this._settings.current.apiKey) {
                this._toast(t("toast.needApiKey"), "info");
            }
            const { provider, targetLanguage, autoTranslate, allGuilds, translateDms } =
                this._settings.current;
            if (!allGuilds && this._settings.guildIdSet.size === 0 && !translateDms) {
                this._toast(t("toast.needGuilds"), "info");
            }

            logger.info(
                `started · provider=${provider} target=${targetLanguage} ` +
                    `mode=${autoTranslate ? "auto" : "manual"} ` +
                    `servers=${allGuilds ? "all" : this._settings.guildIdSet.size} ` +
                    `dms=${translateDms ? "on" : "off"} ` +
                    `outgoing=${this._outgoing ? this._settings.current.outgoingLanguage : "pending"}`,
            );
        } catch (e) {
            logger.error("start failed", e);
            this._toast(t("toast.startFailed", { message: (e && e.message) || "unknown" }), "error");
        }
    }

    stop() {
        if (isLegacyCopy(this._meta)) return;
        try {
            this._patch?.remove();
        } catch (e) {
            logger.error("unpatch failed", e);
        }
        try {
            this._outgoing?.remove();
        } catch (e) {
            logger.error("outgoing unpatch failed", e);
        }

        this._pending?.abort();
        this._pending = null;

        this._menus.remove();
        this._blocks.clear();
        for (const hotkey of this._hotkeys) hotkey.remove();
        this._updater.stop();

        BdApi.Patcher.unpatchAll(NAME);
        BdApi.DOM.removeStyle(NAME);
        disconnectVisibility();
        disconnectScroll();
        this._translator.stop();
        this._patch = null;
        this._outgoing = null;
        logger.info("stopped");
    }

    _handOff() {
        handOff(this._meta).then(
            (done) => done && this._toast(t("toast.renamed"), "info"),
            (e) => logger.error(`could not hand over to ${NAME}`, e),
        );
    }

    _installMessagePatch(stores) {
        const target = findMessageContent();
        if (target) {
            this._attachMessagePatch(target, stores);
            return;
        }

        logger.info("MessageContent is not loaded yet; waiting for Discord to load the chat modules");
        const signal = this._pending.signal;
        waitForMessageContent(signal).then((late) => {
            if (signal.aborted) return;
            if (!late) {
                logger.error("MessageContent not found; Discord's internals may have changed");
                this._toast(t("toast.noMessageContent"), "error");
                return;
            }
            this._attachMessagePatch(late, stores);
            logger.info("message patch installed once the chat modules loaded");
        });
    }

    _attachMessagePatch(target, stores) {
        this._patch = new MessagePatch({
            target,
            settings: this._settings,
            translator: this._translator,
            blocks: this._blocks,
            languageDetector: this._detector,
            stores,
        });
        this._patch.install();
    }

    _installOutgoing(stores) {
        const target = findMessageActions();
        if (target) {
            this._attachOutgoing(target, stores);
            return;
        }

        logger.info("MessageActions is not loaded yet; waiting for Discord to load it");
        const signal = this._pending.signal;
        waitForMessageActions(signal).then((late) => {
            if (signal.aborted) return;
            if (!late) {
                logger.warn("MessageActions not found; outgoing translation is unavailable");
                return;
            }
            this._attachOutgoing(late, stores);
            logger.info("outgoing patch installed once MessageActions loaded");
        });
    }

    _attachOutgoing(target, stores) {
        this._outgoing = new OutgoingPatch({
            target,
            settings: this._settings,
            translator: this._translator,
            languageDetector: this._detector,
            stores,
            onFailure: (message) => this._toast(t("toast.outgoingFailed", { message }), "error"),
            onSlow: () => this._toast(t("toast.outgoingPending"), "info"),
        });
        this._outgoing.install();
    }

    _confirmClearCache() {
        const count = this._translator.cacheSize;
        const clear = () => {
            this._translator.clearCache();
            this._toast(t("toast.cacheCleared", { count }), "info");
        };
        try {
            BdApi.UI.showConfirmationModal(t("clearCache.title"), t("clearCache.body", { count }), {
                danger: true,
                confirmText: t("clearCache.confirm"),
                cancelText: t("clearCache.cancel"),
                onConfirm: clear,
            });
        } catch (e) {
            logger.warn("confirmation modal unavailable", e);
            clear();
        }
    }

    // Resolves false for any way out of the dialog other than Install, so a dismissed dialog never
    // leaves the updater waiting.
    _confirmUpdate({ version, current }) {
        return new Promise((resolve) => {
            let settled = false;
            const answer = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const notes = `${String(this._meta?.source ?? "").replace(/\/+$/, "")}/releases/latest`;
            try {
                BdApi.UI.showConfirmationModal(
                    t("update.title", { version }),
                    t("update.body", { current, notes }),
                    {
                        confirmText: t("update.confirm"),
                        cancelText: t("update.cancel"),
                        onConfirm: () => answer(true),
                        onCancel: () => answer(false),
                        onClose: () => answer(false),
                    },
                );
            } catch (e) {
                logger.warn("confirmation modal unavailable; not installing", e);
                answer(false);
            }
        });
    }

    _reportUpdate({ status, version, message }) {
        if (status === "unsigned") this._toast(t("toast.updateUnsigned", { version }), "warning");
        else if (status === "badSignature") this._toast(t("toast.updateBadSignature", { version }), "error");
        else if (status === "updated") this._toast(t("toast.updated", { version }), "success");
        else if (status === "current") this._toast(t("toast.upToDate", { version }), "info");
        else if (status === "unavailable") this._toast(t("toast.updateUnavailable"), "warning");
        else this._toast(t("toast.updateFailed", { message: message || "unknown" }), "error");
    }

    _toggle(id, onKey, offKey) {
        const next = !this._settings.current[id];
        this._settings.set(id, next);
        const language = getLanguage(this._settings.current.outgoingLanguage).label;
        this._toast(t(next ? onKey : offKey, { language }), "info");
    }

    // A refused key or an empty balance stops every translation, so it is reported even
    // with failures hidden; the translator raises it once, not per message.
    _notifyError(message, fatal) {
        if (fatal) {
            this._toast(t("toast.blocked", { message }), "error");
            return;
        }
        if (!this._settings.current.showErrors) return;
        const now = Date.now();
        if (now - this._lastErrorToast < ERROR_TOAST_COOLDOWN_MS) return;
        this._lastErrorToast = now;
        this._toast(t("toast.failed", { message: message || "unknown" }), "error");
    }

    async _testConnection() {
        const result = await this._translator.probe();
        if (result.ok) this._toast(t("toast.testOk", { text: result.text }), "success");
        else this._toast(t("toast.testFailed", { message: result.message }), "error");
    }

    _toast(message, type) {
        try {
            BdApi.UI.showToast(`${NAME}: ${message}`, { type, timeout: 6000, forceShow: true });
        } catch {}
    }
}
