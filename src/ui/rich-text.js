import { React } from "../discord.js";
import { t } from "../i18n.js";

const CUSTOM_EMOJI = /^<(a)?:(\w+):(\d+)>$/;
const USER_MENTION = /^<@!?(\d+)>$/;
const ROLE_MENTION = /^<@&(\d+)>$/;
const CHANNEL_MENTION = /^<#(\d+)>$/;
const TIMESTAMP = /^<t:(\d+)(?::([tTdDfFR]))?>$/;
const FENCED_CODE = /^```(?:[\w+-]*\n)?([\s\S]*?)```$/;
const INLINE_CODE = /^`([^`\n]+)`$/;

const EMOJI_CDN = "https://cdn.discordapp.com/emojis";

// A token is stood in for by a code point between two Unicode noncharacters, which never occur
// in real text, so Markdown can be parsed around mentions, emoji and links without touching them.
const REF_OPEN = "\uFDD0";
const REF_CLOSE = "\uFDD1";
const REF_BASE = 0xe000;
const REF = "\uFDD0([\uE000-\uF8FF])\uFDD1";

const INLINE_RULES = [
    { re: new RegExp(REF), render: (m, ctx) => renderRef(m[1], ctx) },
    { re: new RegExp(`\\[([^\\]\\n]+)\\]\\(${REF}\\)`), render: renderLink },
    {
        re: /\|\|([\s\S]+?)\|\|/,
        render: (m, ctx) => React.createElement(Spoiler, { key: ctx.key++ }, ...inline(m[1], ctx)),
    },
    { re: /\*\*([\s\S]+?)\*\*/, render: wrap("strong") },
    { re: /__([\s\S]+?)__/, render: wrap("u") },
    { re: /~~([\s\S]+?)~~/, render: wrap("s") },
    { re: /\*(?!\s)([^*\n]+?)\*/, render: wrap("em") },
    { re: /(?<![\p{L}\p{N}])_(?!\s)([^_\n]+?)_(?![\p{L}\p{N}])/u, render: wrap("em") },
];

const HEADING = /^(#{1,3}) (.+)$/;
const SUBTEXT = /^-# (.+)$/;
const QUOTE = /^> ?(.*)$/;
const QUOTE_REST = /^>>> ?/;

export function renderSegments(segments, stores, guildId) {
    const tokens = [];
    const source = segments
        .map((segment) => {
            if (segment.type !== "token") return segment.value;
            tokens.push(segment.value);
            return `${REF_OPEN}${String.fromCharCode(REF_BASE + tokens.length - 1)}${REF_CLOSE}`;
        })
        .join("");
    return renderBlocks(source, { tokens, stores, guildId, key: 0 });
}

// Plain lines stay one run of text, so a message with no block syntax renders exactly as before.
function renderBlocks(source, ctx) {
    const out = [];
    const lines = source.split("\n");
    let plain = [];
    const flush = (trailingBreak) => {
        if (plain.length) out.push(...inline(plain.join("\n") + (trailingBreak ? "\n" : ""), ctx));
        plain = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (QUOTE_REST.test(line)) {
            flush(false);
            const rest = [line.replace(QUOTE_REST, ""), ...lines.slice(i + 1)].join("\n");
            out.push(block("mollu-md-quote", rest, ctx));
            return out;
        }
        if (QUOTE.test(line)) {
            flush(false);
            const quoted = [];
            while (i < lines.length && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])[1]);
            i -= 1;
            out.push(block("mollu-md-quote", quoted.join("\n"), ctx));
            continue;
        }
        const heading = HEADING.exec(line);
        const subtext = SUBTEXT.exec(line);
        if (heading || subtext) {
            flush(false);
            out.push(
                heading
                    ? block(`mollu-md-h${heading[1].length}`, heading[2], ctx)
                    : block("mollu-md-subtext", subtext[1], ctx),
            );
            continue;
        }
        plain.push(line);
    }
    flush(false);
    return out;
}

function block(className, text, ctx) {
    return React.createElement("span", { key: ctx.key++, className }, ...inline(text, ctx));
}

function inline(text, ctx) {
    const out = [];
    let rest = text;
    while (rest) {
        let best = null;
        for (const rule of INLINE_RULES) {
            const match = rule.re.exec(rest);
            if (match && (!best || match.index < best.match.index)) best = { rule, match };
        }
        if (!best) {
            out.push(rest);
            break;
        }
        if (best.match.index > 0) out.push(rest.slice(0, best.match.index));
        out.push(...[].concat(best.rule.render(best.match, ctx)));
        rest = rest.slice(best.match.index + best.match[0].length);
    }
    return out;
}

function wrap(tag) {
    return (match, ctx) => React.createElement(tag, { key: ctx.key++ }, ...inline(match[1], ctx));
}

function tokenAt(ref, ctx) {
    return ctx.tokens[ref.charCodeAt(0) - REF_BASE];
}

function renderRef(ref, ctx) {
    const token = tokenAt(ref, ctx);
    if (token === undefined) return "";
    if (URL_TOKEN.test(token)) return anchor(token, [token], ctx);
    return renderToken(token, ctx.stores, ctx.guildId, ctx.key++);
}

function renderLink(match, ctx) {
    const url = tokenAt(match[2], ctx);
    if (!url || !URL_TOKEN.test(url))
        return ["[", ...inline(match[1], ctx), "](", renderRef(match[2], ctx), ")"];
    return anchor(url, inline(match[1], ctx), ctx);
}

function anchor(url, children, ctx) {
    return React.createElement(
        "a",
        {
            key: ctx.key++,
            className: "mollu-md-link",
            href: url,
            title: url,
            target: "_blank",
            rel: "noreferrer noopener",
        },
        ...children,
    );
}

const URL_TOKEN = /^https?:\/\//;

function Spoiler({ children }) {
    const [shown, setShown] = React.useState(false);
    const reveal = (event) => {
        if (shown) return;
        event.stopPropagation?.();
        setShown(true);
    };
    return React.createElement(
        "span",
        shown
            ? { className: "mollu-md-spoiler mollu-md-spoiler--shown" }
            : {
                  className: "mollu-md-spoiler",
                  role: "button",
                  tabIndex: 0,
                  "aria-label": t("block.spoiler"),
                  onClick: reveal,
                  onKeyDown: (event) => {
                      if (event.key === "Enter" || event.key === " ") reveal(event);
                  },
              },
        ...[].concat(children ?? []),
    );
}

function renderToken(token, stores, guildId, key) {
    const emoji = CUSTOM_EMOJI.exec(token);
    if (emoji) {
        const [, animated, name, id] = emoji;
        return React.createElement("img", {
            key,
            className: "mollu-translation__emoji",
            src: `${EMOJI_CDN}/${id}.${animated ? "gif" : "webp"}?size=44&quality=lossless`,
            alt: `:${name}:`,
            title: `:${name}:`,
            draggable: false,
        });
    }

    const user = USER_MENTION.exec(token);
    if (user) return mention(key, stores?.userName?.(user[1]), "@", token);

    const role = ROLE_MENTION.exec(token);
    if (role) return mention(key, guildId ? stores?.roleName?.(guildId, role[1]) : null, "@", token);

    const channel = CHANNEL_MENTION.exec(token);
    if (channel) return mention(key, stores?.channelName?.(channel[1]), "#", token);

    const timestamp = TIMESTAMP.exec(token);
    if (timestamp) {
        const formatted = formatTimestamp(Number(timestamp[1]), timestamp[2]);
        return formatted == null
            ? token
            : React.createElement("span", { key, className: "mollu-translation__mention" }, formatted);
    }

    const code = FENCED_CODE.exec(token) || INLINE_CODE.exec(token);
    if (code) {
        return React.createElement("code", { key, className: "mollu-translation__code" }, code[1]);
    }

    return token;
}

function mention(key, name, sigil, fallback) {
    if (!name) return fallback;
    return React.createElement("span", { key, className: "mollu-translation__mention" }, `${sigil}${name}`);
}

const TIME_STYLES = {
    t: { timeStyle: "short" },
    T: { timeStyle: "medium" },
    d: { dateStyle: "short" },
    D: { dateStyle: "long" },
    f: { dateStyle: "long", timeStyle: "short" },
    F: { dateStyle: "full", timeStyle: "short" },
};

function formatTimestamp(seconds, style) {
    if (!Number.isFinite(seconds)) return null;
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return null;

    try {
        if (style === "R") return relativeTime(date);
        return new Intl.DateTimeFormat(undefined, TIME_STYLES[style] || TIME_STYLES.f).format(date);
    } catch {
        return null;
    }
}

const RELATIVE_UNITS = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
];

function relativeTime(date) {
    const delta = (date.getTime() - Date.now()) / 1000;
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    for (const [unit, size] of RELATIVE_UNITS) {
        if (Math.abs(delta) >= size || unit === "second") {
            return formatter.format(Math.round(delta / size), unit);
        }
    }
    return null;
}
