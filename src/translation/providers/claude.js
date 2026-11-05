import { postJson, normalizeBaseUrl, configError } from "../../lib/net.js";
import { MAX_OUTPUT_TOKENS } from "../../constants.js";
import { systemPrompt } from "../prompt.js";
import { getLanguage } from "../../languages.js";
import { logger } from "../../lib/logger.js";
import { t } from "../../i18n.js";

export const id = "claude";
export const label = "Anthropic Claude";
export const keyHint = "sk-ant-...";
export const models = Object.freeze(["claude-haiku-5-5", "claude-sonnet-5-5"]);
export const defaults = Object.freeze({ model: models[0], baseUrl: "https://api.anthropic.com" });

// Answers from before ANSWER_FORMAT often carried the source and the model's second thoughts,
// so the cache must not serve them again.
export const cacheVersion = 2;

const API_VERSION = "2023-06-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Answering in free text, Haiku 5.5 wrote the source back -- alone, or ahead of a "Translation:"
// label and its own second thoughts -- for about half of plain English messages. One JSON field
// leaves room for nothing but the translation.
const ANSWER_FORMAT = Object.freeze({
    type: "json_schema",
    schema: {
        type: "object",
        properties: { translation: { type: "string" } },
        required: ["translation"],
        additionalProperties: false,
    },
});

export async function translate({ text, settings, signal }) {
    const apiKey = String(settings.apiKey || "").trim();
    if (!apiKey) throw configError(t("error.noApiKey"));

    const root = normalizeBaseUrl(settings.baseUrl, defaults.baseUrl).replace(/\/v1$/, "");
    const model = String(settings.model || defaults.model).trim();

    // Only tokens actually produced are billed, so a generous cap costs nothing.
    const body = {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt(getLanguage(settings.targetLanguage).name),
        messages: [{ role: "user", content: text }],
        output_config: { format: ANSWER_FORMAT },
    };
    // The newer models think by default and take no temperature; low effort keeps a
    // translation from turning into a deliberation. Haiku 4.5 has no effort control at all.
    if (!/^claude-haiku-4/i.test(model)) body.output_config.effort = "low";

    const headers = {
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
    };
    // Sonnet 5.5 can decline on its safety classifiers; the API then retries on the model it
    // recommends for that kind of refusal instead of returning nothing.
    if (model === "claude-sonnet-5-5") {
        body.fallbacks = "default";
        headers["anthropic-beta"] = FALLBACK_BETA;
    }

    const json = await send(`${root}/v1/messages`, { headers, signal, body });

    if (json?.stop_reason === "refusal") throw new Error(t("error.refused"));
    const answer = (Array.isArray(json?.content) ? json.content : [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
    const output = translationIn(answer);
    if (!output) {
        logger.warn(
            `${model} gave no answer (stop_reason ${json?.stop_reason ?? "none"}, ` +
                `usage ${JSON.stringify(json?.usage ?? null)})`,
        );
        throw new Error(
            t(json?.stop_reason === "max_tokens" ? "error.reasoningOnly" : "error.emptyResponse"),
        );
    }
    return output;
}

// A JSON answer cut off by max_tokens no longer parses; it counts as no answer.
function translationIn(answer) {
    try {
        const translation = JSON.parse(answer)?.translation;
        return typeof translation === "string" ? translation.trim() : "";
    } catch {
        return "";
    }
}

// An older model typed in by hand can refuse the effort setting; ask again without it. The
// answer format stays, since the reply is read as JSON either way.
async function send(url, { headers, signal, body }) {
    try {
        return await postJson(url, { headers, signal, body });
    } catch (err) {
        if (!(err?.status === 400 && body.output_config?.effort && /effort/i.test(String(err.body || "")))) {
            throw err;
        }
        logger.warn(`${body.model} rejected the effort setting; asking again without it`);
        const outputConfig = { ...body.output_config };
        delete outputConfig.effort;
        return postJson(url, { headers, signal, body: { ...body, output_config: outputConfig } });
    }
}
