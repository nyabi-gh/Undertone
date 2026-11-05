const STRINGS = {
    en: {
        "block.pending": "Translating…",
        "block.error": "Translation failed · {message}",
        "block.errorTitle": "Click to try again",
        "block.waiting": "The backend is busy; trying again shortly…",
        "block.spoiler": "Spoiler, click to show",
        "error.retryLater": "Waiting before trying again",
        "block.trigger": "Translate",

        "toast.outdatedBd": "BetterDiscord is out of date; API requests may be blocked. Please update.",
        "toast.noMessageContent": "Could not find the message component. Check the console log.",
        "toast.needApiKey": "Enter an API key in the settings.",
        "toast.needGuilds": "Add at least one target server id in the settings.",
        "toast.failed": "Translation failed · {message}",
        "toast.startFailed": "Could not start · {message}. Check the console log.",
        "toast.renamed": "Undertone is Mollu again. Your settings and API keys came along.",
        "toast.autoOn": "Automatic translation on",
        "toast.autoOff": "Automatic translation off · manual mode",
        "toast.outgoingOn": "Your messages will be sent in {language}",
        "toast.outgoingOff": "Your messages will be sent as you type them",
        "toast.outgoingFailed": "Sent untranslated · {message}",
        "toast.cacheCleared": "Cleared {count} cached translations",
        "toast.updated": "Updated to v{version}",
        "toast.upToDate": "Already up to date (v{version})",
        "toast.updateUnavailable": "No release to update from. Check the plugin's source repository.",
        "toast.updateFailed": "Could not check for updates · {message}",
        "toast.updateUnsigned": "v{version} is out but carries no signature, so it was not installed",
        "toast.updateBadSignature":
            "v{version} failed its signature check and was not installed. Download it only from the official repository.",
        "update.title": "Mollu v{version} is available",
        "update.body": "Installed: v{current}. The signature checks out. What changed: {notes}",
        "update.confirm": "Install",
        "update.cancel": "Later",

        "error.noApiKey": "No API key configured",
        "error.emptyResponse": "Empty response",
        "error.reasoningOnly": "Response was cut off while the model was still reasoning",
        "error.badBaseUrl": "API Base URL is not valid: {url}",
        "error.badProtocol": "Unsupported protocol: {protocol}",
        "error.insecureUrl": "An http:// address sends the API key in the clear. Use https://.",
        "error.rateLimited": "The backend stayed busy",
        "error.unsupportedLanguage": "{provider} cannot translate into {language}",
        "error.quotaExceeded": "The API key's translation quota is used up",
        "error.refused": "The model declined to translate this message",
        "error.badKey": "The API key was refused. Check it in the settings.",
        "error.noBalance": "The API account has no balance left",
        "error.timedOut": "The backend did not answer in time",
        "error.busy": "The backend is busy right now",
        "error.tooLongToSend": "The translation is longer than Discord's {limit} characters",
        "toast.blocked": "Translation paused until the settings change · {message}",
        "toast.outgoingPending": "Translating your message…",
        "toast.testOk": "Connection works · {text}",
        "toast.testFailed": "Connection failed · {message}",

        "settings.provider": "Translation backend",
        "settings.provider.note": "Each backend remembers its own API key.",
        "settings.apiKey": "{provider} API key",
        "settings.apiKey.note":
            "The saved key stays hidden. Type a new one to replace it, or {clear} to erase it.",
        "settings.apiKey.saved": "saved · {fingerprint}",
        "settings.model": "Model",
        "settings.model.custom": "Type a name in…",
        "settings.customModel": "Model name",
        "settings.customModel.note": "The model id exactly as the backend writes it. Blank uses {fallback}.",
        "settings.baseUrl": "API base URL",
        "settings.baseUrl.note": "Filled in when you pick a backend.",
        "settings.allGuilds": "Translate in every server",
        "settings.allGuilds.note":
            "When off, only servers switched on from their right-click menu are translated.",
        "settings.guildIds": "Target server ids",
        "settings.guildIds.note":
            "Filled in from a server's right-click menu. Not used while every server is on.",
        "settings.excludedChannelIds": "Channels left untranslated",
        "settings.excludedChannelIds.note":
            "Filled in when you switch a channel off from its right-click menu. Threads follow their channel.",
        "settings.current": "Now: {names}",
        "menu.translateGuild": "Translate with Mollu",
        "menu.everyGuild": "Translate with Mollu (every server is on)",
        "menu.translateChannel": "Translate with Mollu",
        "menu.showTranslation": "Show Mollu translation",
        "menu.retranslate": "Translate again with Mollu",
        "settings.translateDms": "Translate direct messages",
        "settings.translateDms.note": "Private conversations are sent to the backend too.",
        "settings.targetLanguage": "Translate into",
        "settings.targetLanguage.note": "Messages already in this language are left alone.",
        "settings.uiLanguage": "Plugin language",
        "settings.threshold": "Treat as already translated above",
        "settings.threshold.note":
            "Skip a message when this share of it is already in the target language's script.",
        "settings.maxChars": "Maximum characters to translate",
        "settings.maxChars.note": "Longer messages are skipped.",
        "settings.maxConcurrent": "Concurrent requests",
        "settings.maxConcurrent.note": "Lower it to 1–2 if a free tier keeps limiting you.",
        "settings.testConnection": "Connection",
        "settings.testConnection.action": "Test",
        "settings.autoTranslate": "Automatic translation",
        "settings.autoTranslate.note":
            "When off, a Translate button appears under each message and only what you press is sent.",
        "settings.hotkey": "Automatic translation shortcut",
        "settings.hotkey.note": "Click the field and press the keys. Clear it to use no shortcut.",
        "settings.translateOutgoing": "Translate the messages I send",
        "settings.translateOutgoing.note":
            "What you type is replaced by its translation. Other people never see the original.",
        "settings.outgoingLanguage": "Send my messages in",
        "settings.outgoingHotkey": "Outgoing translation shortcut",
        "settings.translateBots": "Translate bot messages",
        "settings.translateOwnMessages": "Translate my own messages",
        "settings.showPending": "Show while translating",
        "settings.showErrors": "Pop up a notice when a translation fails",
        "settings.section.translate": "Translation",
        "settings.section.details": "Fine-tuning",
        "settings.section.connection": "Translation service",
        "settings.section.outgoing": "Messages I send",
        "settings.section.advanced": "Advanced",
        "settings.autoUpdate": "Check for updates automatically",
        "settings.autoUpdate.note": "Only a signed version is installed, and only after you agree.",
        "settings.checkUpdate": "Updates",
        "settings.checkUpdate.action": "Check",
        "settings.clearCache": "Translation cache",
        "settings.clearCache.note":
            "Use it after changing the base URL. To redo one translation, right-click its message instead.",
        "settings.clearCache.action": "Clear",
        "clearCache.title": "Clear the translation cache?",
        "clearCache.body":
            "{count} saved translations will be deleted. Messages already on screen will be sent to the API again, at the usual cost.",
        "clearCache.confirm": "Clear",
        "clearCache.cancel": "Cancel",
        "settings.debugLog": "Log why a message was skipped",
        "settings.debugLog.note": "Writes why a message was skipped to the console (Ctrl+Shift+I).",

        "keySource.deepseek": "Get one at platform.deepseek.com → API Keys.",
        "keySource.gemini": "Get one at aistudio.google.com → Get API key. It has a free tier.",
        "keySource.openai": "Get one at platform.openai.com → API keys.",
        "keySource.claude": "Get one at platform.claude.com → API Keys.",
        "keySource.deepl":
            "Get one at deepl.com/pro-api. The free plan allows 500,000 characters a month and needs no model.",
        "modelHint.deepseek":
            "flash is cheap and fast; pro costs more and reads better. A newer one can be typed in.",
        "modelHint.gemini":
            "flash-lite answers in about a second; flash reads better but is slower. Another Gemini model, 3.1 or later, can be typed in.",
        "modelHint.deepl": "DeepL has no model to pick.",
        "modelHint.openai":
            "luna is cheap and fast with reasoning off; sol reads better but always reasons a little.",
        "modelHint.claude": "haiku is the fastest and cheapest; sonnet reads better and costs more.",
        "language.auto": "Match Discord",
    },
    ko: {
        "block.pending": "번역 중…",
        "block.error": "번역 실패 · {message}",
        "block.errorTitle": "클릭하면 다시 시도합니다",
        "block.waiting": "번역 서비스가 바빠 잠시 후 다시 시도합니다…",
        "block.spoiler": "스포일러, 클릭하면 보입니다",
        "error.retryLater": "재시도를 기다리는 중",
        "block.trigger": "번역",

        "toast.outdatedBd":
            "BetterDiscord가 오래되어 API 요청이 차단될 수 있습니다. 최신 버전으로 업데이트하세요.",
        "toast.noMessageContent": "메시지 컴포넌트를 찾지 못했습니다. 콘솔 로그를 확인하세요.",
        "toast.needApiKey": "설정에서 API 키를 입력하세요.",
        "toast.needGuilds": "설정에서 대상 서버 ID를 추가하세요.",
        "toast.failed": "번역 실패 · {message}",
        "toast.startFailed": "시작하지 못했습니다 · {message}. 콘솔 로그를 확인하세요.",
        "toast.renamed": "Undertone이 다시 Mollu로 돌아왔습니다. 설정과 API 키는 그대로 옮겨졌습니다.",
        "toast.autoOn": "자동 번역 켜짐",
        "toast.autoOff": "자동 번역 꺼짐 · 수동 모드",
        "toast.outgoingOn": "보내는 메시지를 {language} 로 번역합니다",
        "toast.outgoingOff": "보내는 메시지를 입력한 그대로 보냅니다",
        "toast.outgoingFailed": "번역하지 못해 원문 그대로 보냈습니다 · {message}",
        "toast.cacheCleared": "번역 캐시 {count}개를 비웠습니다",
        "toast.updated": "v{version} 로 업데이트했습니다",
        "toast.upToDate": "이미 최신 버전입니다 (v{version})",
        "toast.updateUnavailable": "업데이트를 받을 릴리즈가 없습니다. 플러그인의 소스 저장소를 확인하세요.",
        "toast.updateFailed": "업데이트를 확인하지 못했습니다 · {message}",
        "toast.updateUnsigned": "v{version} 이 나왔지만 서명이 없어 설치하지 않았습니다",
        "toast.updateBadSignature":
            "v{version} 의 서명이 맞지 않아 설치하지 않았습니다. 공식 저장소에서만 받으세요.",
        "update.title": "Mollu v{version} 이 나왔습니다",
        "update.body": "지금 버전: v{current}. 서명을 확인했습니다. 변경 내역: {notes}",
        "update.confirm": "설치",
        "update.cancel": "나중에",

        "error.noApiKey": "API 키가 설정되지 않았습니다",
        "error.emptyResponse": "빈 응답",
        "error.reasoningOnly": "모델이 추론하는 도중에 응답이 잘렸습니다",
        "error.badBaseUrl": "API Base URL이 올바르지 않습니다: {url}",
        "error.badProtocol": "지원하지 않는 프로토콜입니다: {protocol}",
        "error.insecureUrl": "http:// 주소로는 API 키가 평문으로 전송됩니다. https:// 를 사용하세요.",
        "error.rateLimited": "번역 서비스가 계속 바빴습니다",
        "error.unsupportedLanguage": "{provider} 는 {language} 로 번역할 수 없습니다",
        "error.quotaExceeded": "API 키의 번역 할당량을 모두 사용했습니다",
        "error.refused": "모델이 이 메시지의 번역을 거절했습니다",
        "error.badKey": "API 키가 거부되었습니다. 설정에서 확인하세요.",
        "error.noBalance": "API 계정의 잔액이 없습니다",
        "error.timedOut": "번역 서비스가 제때 응답하지 않았습니다",
        "error.busy": "번역 서비스가 지금 바쁩니다",
        "error.tooLongToSend": "번역문이 Discord 제한인 {limit}자를 넘습니다",
        "toast.blocked": "설정을 바꿀 때까지 번역을 멈춥니다 · {message}",
        "toast.outgoingPending": "보낼 메시지를 번역하는 중…",
        "toast.testOk": "연결 정상 · {text}",
        "toast.testFailed": "연결 실패 · {message}",

        "settings.provider": "번역 백엔드",
        "settings.provider.note": "백엔드마다 API 키를 따로 기억합니다.",
        "settings.apiKey": "{provider} API 키",
        "settings.apiKey.note":
            "저장된 키는 보이지 않습니다. 새 키를 입력하면 바뀌고, {clear} 를 입력하면 지워집니다.",
        "settings.apiKey.saved": "저장됨 · {fingerprint}",
        "settings.model": "모델 이름",
        "settings.model.custom": "직접 입력…",
        "settings.customModel": "직접 입력한 모델 이름",
        "settings.customModel.note":
            "백엔드 문서에 적힌 모델 ID 를 그대로 적습니다. 비우면 {fallback} 을 씁니다.",
        "settings.baseUrl": "API Base URL",
        "settings.baseUrl.note": "백엔드를 고르면 채워집니다.",
        "settings.allGuilds": "모든 서버에서 번역",
        "settings.allGuilds.note": "끄면 서버 우클릭 메뉴에서 켠 서버만 번역합니다.",
        "settings.guildIds": "대상 서버 ID",
        "settings.guildIds.note":
            "서버 우클릭 메뉴에서 켜면 채워집니다. 모든 서버에서 번역이 켜져 있으면 쓰지 않습니다.",
        "settings.excludedChannelIds": "번역하지 않을 채널",
        "settings.excludedChannelIds.note": "채널 우클릭 메뉴에서 끄면 채워집니다. 스레드는 채널을 따릅니다.",
        "settings.current": "현재: {names}",
        "menu.translateGuild": "Mollu로 번역",
        "menu.everyGuild": "Mollu로 번역 (모든 서버가 켜져 있음)",
        "menu.translateChannel": "Mollu로 번역",
        "menu.showTranslation": "Mollu 번역 보이기",
        "menu.retranslate": "Mollu로 다시 번역",
        "settings.translateDms": "DM 도 번역",
        "settings.translateDms.note": "사적인 대화도 번역 백엔드로 전송됩니다.",
        "settings.targetLanguage": "번역할 언어",
        "settings.targetLanguage.note": "이미 이 언어로 쓰인 메시지는 번역하지 않습니다.",
        "settings.uiLanguage": "플러그인 언어",
        "settings.threshold": "번역 생략 기준 비율",
        "settings.threshold.note": "메시지에서 이 비율 이상이 이미 번역할 언어의 문자면 건너뜁니다.",
        "settings.maxChars": "번역할 최대 글자 수",
        "settings.maxChars.note": "이보다 긴 메시지는 건너뜁니다.",
        "settings.maxConcurrent": "동시 번역 요청 수",
        "settings.maxConcurrent.note": "무료 등급에서 요청 제한에 자주 걸리면 1–2로 낮추세요.",
        "settings.testConnection": "연결 확인",
        "settings.testConnection.action": "테스트",
        "settings.autoTranslate": "자동 번역",
        "settings.autoTranslate.note": "끄면 메시지마다 번역 버튼이 나오고, 누른 것만 번역합니다.",
        "settings.hotkey": "자동 번역 단축키",
        "settings.hotkey.note": "칸을 누르고 원하는 키를 누르세요. 비우면 단축키를 쓰지 않습니다.",
        "settings.translateOutgoing": "보내는 메시지도 번역",
        "settings.translateOutgoing.note":
            "입력한 글이 번역문으로 바뀌어 나갑니다. 상대는 원문을 볼 수 없습니다.",
        "settings.outgoingLanguage": "보낼 때 번역할 언어",
        "settings.outgoingHotkey": "보내는 메시지 번역 단축키",
        "settings.translateBots": "봇 메시지도 번역",
        "settings.translateOwnMessages": "내 메시지도 번역",
        "settings.showPending": "번역 중 표시",
        "settings.showErrors": "번역 실패 시 알림 띄우기",
        "settings.section.translate": "번역",
        "settings.section.details": "세부 설정",
        "settings.section.connection": "번역 서비스",
        "settings.section.outgoing": "보내는 메시지",
        "settings.section.advanced": "고급",
        "settings.autoUpdate": "업데이트 자동 확인",
        "settings.autoUpdate.note": "서명이 확인된 버전만, 물어본 뒤에 설치합니다.",
        "settings.checkUpdate": "업데이트",
        "settings.checkUpdate.action": "확인",
        "settings.clearCache": "번역 캐시",
        "settings.clearCache.note":
            "Base URL 을 바꿨을 때 쓰세요. 번역 하나만 다시 하려면 메시지 우클릭 메뉴를 쓰면 됩니다.",
        "settings.clearCache.action": "비우기",
        "clearCache.title": "번역 캐시를 비울까요?",
        "clearCache.body":
            "저장된 번역 {count}개가 삭제됩니다. 화면에 있는 메시지는 다시 API 로 전송되고 그만큼 비용이 듭니다.",
        "clearCache.confirm": "비우기",
        "clearCache.cancel": "취소",
        "settings.debugLog": "번역하지 않은 사유 기록",
        "settings.debugLog.note": "번역하지 않은 이유를 콘솔(Ctrl+Shift+I)에 남깁니다.",

        "keySource.deepseek": "platform.deepseek.com → API Keys 에서 발급합니다.",
        "keySource.gemini": "aistudio.google.com → Get API key 에서 발급합니다. 무료 티어가 있습니다.",
        "keySource.openai": "platform.openai.com → API keys 에서 발급합니다.",
        "keySource.claude": "platform.claude.com → API Keys 에서 발급합니다.",
        "keySource.deepl":
            "deepl.com/pro-api 에서 발급합니다. 무료 플랜은 월 50만 자이고 모델 선택이 없습니다.",
        "modelHint.deepseek":
            "flash 는 빠르고 저렴합니다. pro 는 비싼 대신 번역이 자연스럽습니다. 새 모델은 직접 입력하세요.",
        "modelHint.gemini":
            "flash-lite 가 약 1초로 가장 빠릅니다. flash 는 문장이 더 좋지만 느립니다. 3.1 이후의 다른 Gemini 모델은 직접 입력하면 됩니다.",
        "modelHint.deepl": "DeepL 은 고를 모델이 없습니다.",
        "modelHint.openai":
            "luna 는 추론을 끄고 싸고 빠르게 씁니다. sol 은 문장이 더 좋지만 추론을 완전히 끄지는 못합니다.",
        "modelHint.claude": "haiku 가 가장 빠르고 쌉니다. sonnet 은 문장이 더 좋지만 비쌉니다.",
        "language.auto": "Discord 설정에 맞춤",
    },
};

export const UI_LANGUAGES = ["en", "ko"];

export const UI_LANGUAGE_NAMES = { en: "English", ko: "한국어" };

// A missing key is not a runtime error -- t() quietly serves the English one -- so only a
// check with the tables in hand can catch the drift.
export function stringKeys(locale) {
    return Object.keys(STRINGS[locale] ?? {});
}

let active = "en";

export function setLocale(preference) {
    const wanted = preference === "auto" || !preference ? detect() : preference;
    active = STRINGS[wanted] ? wanted : "en";
}

export function getLocale() {
    return active;
}

export function t(key, vars) {
    const table = STRINGS[active] || STRINGS.en;
    const template = table[key] ?? STRINGS.en[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

function detect() {
    try {
        const tag = typeof navigator !== "undefined" && navigator.language;
        return tag ? String(tag).split("-")[0].toLowerCase() : "en";
    } catch {
        return "en";
    }
}

setLocale("auto");
