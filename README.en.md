[한국어](README.md) · **English**

# Mollu

A BetterDiscord plugin that translates Discord messages and shows the translation right under the original.

> Versions 1.5.x went by **Undertone**. The automatic update brings you back to Mollu, along with your settings and API keys.

## Features

- Translates messages in the servers you pick (or every server), and in DMs, into any of 15 languages.
- **Automatic mode** translates what is on screen. **Manual mode** translates only the messages whose `Translate` button you press.
- Can translate your own messages before they are sent — type in Korean, send in English.
- Translations are remembered, so the same sentence never costs twice.
- New versions are checked for a signature, and you are asked before they install.

## Installing

1. Download [**Mollu.plugin.js**](https://github.com/nyabi-gh/Mollu/releases/latest/download/Mollu.plugin.js).
2. In BetterDiscord, go to Settings → Plugins → **Open Plugins Folder** and drop the file in.
3. Enable **Mollu** in the plugin list.

BetterDiscord 1.14.0 or newer is required.

## Getting started

Translation goes through an outside service, so you need an API key from one of these:

| Service | Cost | Where to get a key |
| --- | --- | --- |
| **DeepL** | 500,000 characters a month, free | [deepl.com/pro-api](https://www.deepl.com/pro-api) |
| **Google Gemini** | Has a free tier | [aistudio.google.com](https://aistudio.google.com) |
| **DeepSeek** | Paid, very cheap | [platform.deepseek.com](https://platform.deepseek.com) |
| **OpenAI** | Paid; the default model is cheap | [platform.openai.com](https://platform.openai.com) |
| **Anthropic Claude** | Paid | [platform.claude.com](https://platform.claude.com) |

DeepL is the easiest free start. The others read more naturally and keep tone and slang.

Then, in the plugin settings:

1. Choose your service under `Translation backend` and paste the key into `API key`.
2. Right-click a server icon → **Translate with Mollu**, or turn on `Translate in every server`.
3. To translate DMs as well, turn on `Translate direct messages`.

Every other setting explains itself in the panel.

> **Gemini's free tier**: what you send is used to train Google's models. This plugin sends other people's messages, so their conversations become training data too.

## Shortcuts

| Default | What it does |
| --- | --- |
| `Ctrl+Shift+T` | Automatic translation on / off |
| `Ctrl+Shift+O` | Outgoing translation on / off |

Change them under `Fine-tuning` in settings.

## When nothing shows up

- If the target language is the language the server already speaks, there is nothing to translate.
- Your own messages are skipped by default. Turn on `Translate my own messages` under `Fine-tuning` to test with your own typing.
- When `Translation failed` shows up for anything other than the API key or the balance, it is tried again by itself a minute later while the message is on screen, up to three times. Click it to try again right away.
- For a translation that came out wrong, right-click the message → **Translate again with Mollu**.
- Right after a large Discord update, translations may stop appearing. Wait for a plugin update.

## Privacy

- Only the text of messages that need translating is sent to the service. Mentions, emoji, links and code are swapped for placeholders first.
- With `Translate direct messages` or `Translate the messages I send` on, DMs and what you type are sent too.
- Your API key and translations are stored unencrypted in `Mollu.config.json` in the plugins folder. Do not share it. To erase everything, disable the plugin and delete that file.

## Releasing (maintainers)

Automatic updates install only signed releases.

1. Once, run `npm run keygen`. The private key goes to `~/.config/mollu/update-signing-key.pem`; back it up. Without it, builds already out there can never update again.
2. Store it as a repository secret: `gh secret set MOLLU_SIGNING_KEY < ~/.config/mollu/update-signing-key.pem`
3. Bump the version in `meta.json` and `package.json`, commit the built `dist/`, and push a matching tag (such as `v1.5.0`). The workflow checks, signs and publishes the release.

`dist/Undertone.plugin.js` is what versions 1.5.x update from, so keep it in every release.
