import { logger } from "./lib/logger.js";
import { t } from "./i18n.js";
import { getProvider } from "./translation/providers/index.js";

const CHANNEL_MENUS = ["channel-context", "thread-context"];

// Right-clicking a server or channel is where people look for a switch like this; typing
// ids into the settings needs Developer Mode.
export class ContextMenus {
    constructor({ settings, blocks }) {
        this._settings = settings;
        this._blocks = blocks;
        this._unpatches = [];
    }

    install() {
        const api = typeof BdApi !== "undefined" ? BdApi.ContextMenu : null;
        if (typeof api?.patch !== "function" || typeof api.buildItem !== "function") {
            logger.warn("BdApi.ContextMenu is unavailable; the right-click switches are off");
            return;
        }
        this._patch(api, "guild-context", (tree, props) => this._guild(api, tree, props));
        for (const navId of CHANNEL_MENUS) {
            this._patch(api, navId, (tree, props) => this._channel(api, tree, props));
        }
        this._patch(api, "message", (tree, props) => this._message(api, tree, props));
    }

    remove() {
        for (const unpatch of this._unpatches) {
            try {
                unpatch();
            } catch {}
        }
        this._unpatches = [];
    }

    _patch(api, navId, callback) {
        try {
            const unpatch = api.patch(navId, (tree, props) => {
                try {
                    callback(tree, props);
                } catch (e) {
                    logger.error(`${navId} patch failed`, e);
                }
            });
            if (typeof unpatch === "function") this._unpatches.push(unpatch);
        } catch (e) {
            logger.warn(`could not patch ${navId}`, e);
        }
    }

    _guild(api, tree, props) {
        const guildId = props?.guild?.id;
        if (!guildId) return;
        const { allGuilds } = this._settings.current;
        append(api, tree, [
            {
                type: "toggle",
                id: "mollu-translate-guild",
                label: t(allGuilds ? "menu.everyGuild" : "menu.translateGuild"),
                checked: allGuilds || this._settings.guildIdSet.has(guildId),
                disabled: allGuilds,
                action: () => this._settings.toggleGuild(guildId),
            },
        ]);
    }

    _channel(api, tree, props) {
        const channel = props?.channel;
        const guildId = channel?.guild_id;
        if (!channel?.id || !guildId) return;
        const { allGuilds } = this._settings.current;
        if (!allGuilds && !this._settings.guildIdSet.has(guildId)) return;
        append(api, tree, [
            {
                type: "toggle",
                id: "mollu-translate-channel",
                label: t("menu.translateChannel"),
                checked: !this._settings.excludedChannelSet.has(channel.id),
                action: () => this._settings.toggleExcludedChannel(channel.id),
            },
        ]);
    }

    _message(api, tree, props) {
        const messageId = props?.message?.id;
        const menu = messageId ? this._blocks.menuFor(messageId) : null;
        if (!menu) return;
        const items = [];
        if (menu.canHide) {
            items.push({
                type: "toggle",
                id: "mollu-show-translation",
                label: t("menu.showTranslation"),
                checked: !menu.hidden,
                action: () => this._blocks.setHidden(messageId, !menu.hidden),
            });
        }
        if (menu.canRetranslate && !getProvider(this._settings.current.provider).deterministic) {
            items.push({
                type: "text",
                id: "mollu-retranslate",
                label: t("menu.retranslate"),
                action: () => this._blocks.retranslate(messageId),
            });
        }
        append(api, tree, items);
    }
}

function append(api, tree, items) {
    if (!items.length) return;
    const built = [api.buildItem({ type: "separator" }), ...items.map((item) => api.buildItem(item))];
    const children = tree?.props?.children;
    if (Array.isArray(children)) children.push(...built);
    else if (tree?.props) tree.props.children = [children, ...built].filter((child) => child != null);
}
