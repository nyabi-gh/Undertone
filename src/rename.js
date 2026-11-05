import { NAME, INTERIM_NAME, LEGACY_NAMES, CACHE_KEY } from "./constants.js";
import { logger } from "./lib/logger.js";

const POLL_MS = 500;
const DATA_KEYS = ["settings", CACHE_KEY];

// 1.5.x builds, named Undertone, update themselves from Undertone.plugin.js and only accept a file
// named Undertone, so each release also ships this build under that name. Started that way, it
// puts Mollu in its place and removes itself.
export function isLegacyCopy(meta) {
    return LEGACY_NAMES.includes(meta?.name);
}

// Becoming Undertone left Mollu 1.4.x's data in place, so reading Mollu's first would bring back
// settings from before then. Moved rather than copied, so it cannot win over what Mollu saves later.
export function reclaimInterimData() {
    for (const key of DATA_KEYS) {
        try {
            const value = BdApi.Data.load(INTERIM_NAME, key);
            if (value == null) continue;
            BdApi.Data.save(NAME, key, value);
            BdApi.Data.delete(INTERIM_NAME, key);
            logger.info(`moved ${key} over from ${INTERIM_NAME}`);
        } catch (e) {
            logger.error(`could not move ${key} over from ${INTERIM_NAME}`, e);
        }
    }
}

export function asLegacy(text, legacyName) {
    return renameBanner(text, NAME, legacyName);
}

export function asCurrent(text, legacyName) {
    return renameBanner(text, legacyName, NAME);
}

export async function handOff(meta, { fs = require("fs"), path = require("path"), timeoutMs = 30000 } = {}) {
    const folder = BdApi.Plugins.folder;
    const own = path.join(folder, meta.filename || `${meta.name}.plugin.js`);
    const target = path.join(folder, `${NAME}.plugin.js`);
    if (!fs.existsSync(target)) fs.writeFileSync(target, asCurrent(fs.readFileSync(own, "utf8"), meta.name));

    if (!(await loaded(timeoutMs))) {
        logger.warn(`${NAME} was written but BetterDiscord has not loaded it yet; trying again next start`);
        return false;
    }
    BdApi.Plugins.enable(NAME);
    fs.unlinkSync(own);
    logger.info(`handed over from ${meta.name} to ${NAME}`);
    return true;
}

export function retireLegacy() {
    for (const legacy of LEGACY_NAMES) {
        try {
            if (!BdApi.Plugins.isEnabled(legacy)) continue;
            BdApi.Plugins.disable(legacy);
            logger.info(`turned off ${legacy}; ${NAME} replaces it`);
        } catch {}
    }
}

function renameBanner(text, from, to) {
    return text.replace(new RegExp(`^( \\* @name )${from}$`, "m"), `$1${to}`);
}

async function loaded(timeoutMs) {
    for (let waited = 0; ; waited += POLL_MS) {
        if (BdApi.Plugins.get(NAME)) return true;
        if (waited >= timeoutMs) return false;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}
