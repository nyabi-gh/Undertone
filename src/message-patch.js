import { NAME, TRACE_LIMIT } from "./constants.js";
import { React } from "./discord.js";
import { TranslationBlock } from "./ui/translation-block.js";
import { logger } from "./lib/logger.js";
import { isExcludedChannel } from "./scope.js";

const TRANSLATABLE_TYPES = new Set([0, 19, 20]);

export class MessagePatch {
    constructor({ target, settings, translator, blocks, languageDetector, stores }) {
        this._target = target;
        this._settings = settings;
        this._translator = translator;
        this._blocks = blocks;
        this._detector = languageDetector;
        this._stores = stores;
        this._unpatch = null;
        this._traced = new Set();
    }

    install() {
        const { module, key } = this._target;
        this._unpatch = BdApi.Patcher.after(NAME, module, key, (_self, args, ret) => {
            try {
                return this._onRender(args?.[0], ret);
            } catch (e) {
                logger.error("render patch failed", e);
                return ret;
            }
        });
    }

    remove() {
        try {
            this._unpatch?.();
        } finally {
            this._unpatch = null;
        }
    }

    _onRender(props, ret) {
        if (!ret) return ret;

        const message = props?.message;
        const { ok, guildId, reason } = this._resolve(message);
        if (!ok) {
            this._trace(message, reason);
            return ret;
        }
        if (!this._detector.needsTranslation(message.content)) {
            this._trace(message, "already in the target language");
            return ret;
        }

        const block = React.createElement(TranslationBlock, {
            key: "mollu-translation",
            text: message.content,
            messageId: message.id,
            guildId,
            stores: this._stores,
            translator: this._translator,
            blocks: this._blocks,
            settings: this._settings,
        });
        return appendChild(ret, block);
    }

    _resolve(message) {
        if (!message || typeof message.content !== "string" || !message.content.trim()) {
            return { reason: "no text content" };
        }
        if (!TRANSLATABLE_TYPES.has(message.type)) {
            return { reason: `message type ${message.type} is not translatable` };
        }

        const settings = this._settings.current;
        if (!settings.apiKey) return { reason: "no api key configured" };
        if (!settings.allGuilds && this._settings.guildIdSet.size === 0 && !settings.translateDms) {
            return { reason: "no target server configured" };
        }

        const author = message.author || {};
        if (!settings.translateBots && author.bot) return { reason: "author is a bot" };
        if (!settings.translateOwnMessages && author.id && author.id === this._stores.currentUserId()) {
            return { reason: "own message" };
        }

        const guildId = this._stores.guildIdForChannel(message.channel_id);
        if (!guildId) {
            if (!this._stores.isDirectMessage?.(message.channel_id)) {
                return { reason: "not a server channel" };
            }
            if (!settings.translateDms) return { reason: "direct message translation is off" };
            return { ok: true, guildId: null };
        }
        if (!settings.allGuilds && !this._settings.guildIdSet.has(guildId)) {
            return { reason: `server ${guildId} is not in the target list` };
        }
        if (isExcludedChannel(this._settings, this._stores, message.channel_id)) {
            return { reason: "channel is excluded" };
        }
        return { ok: true, guildId };
    }

    _trace(message, reason) {
        if (!this._settings.current.debugLog) return;
        const id = message?.id ?? "?";
        const key = `${id}\u0001${reason}`;
        if (this._traced.has(key)) return;
        if (this._traced.size >= TRACE_LIMIT) this._traced.clear();
        this._traced.add(key);
        logger.info(`not translated · ${id} · ${reason}`);
    }
}

function appendChild(ret, child) {
    if (Array.isArray(ret)) return [...ret, child];
    if (ret && ret.props) {
        const children = ret.props.children;

        return children == null
            ? React.cloneElement(ret, undefined, child)
            : React.cloneElement(ret, undefined, children, child);
    }
    return ret;
}
