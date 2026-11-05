import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { asLegacy } from "../src/rename.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf8"));

const outName = `${meta.name}.plugin.js`;
const outfile = join(root, "dist", outName);
// 1.5.x releases, named Undertone, only update from this file name.
const BRIDGES = ["Undertone"];

const banner = `/**\n${Object.entries(meta)
    .map(([key, value]) => ` * @${key} ${value}`)
    .join("\n")}\n */\n`;

const footer = "\nif (module.exports && module.exports.default) module.exports = module.exports.default;\n";

const options = {
    entryPoints: [join(root, "src/index.js")],
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "chrome128",
    charset: "utf8",
    legalComments: "none",
    external: ["fs", "path"],
    banner: { js: banner },
    footer: { js: footer },
    outfile,
};

const watch = process.argv.includes("--watch");
const install = process.argv.includes("--install");

mkdirSync(join(root, "dist"), { recursive: true });

if (watch) {
    const ctx = await context({
        ...options,
        plugins: [afterBuild(install)],
    });
    await ctx.watch();
    console.log(`watching src/ -> ${outfile}`);
} else {
    await build(options);
    console.log(`built ${outfile}`);
    writeBridges();
    if (install) installTo(pluginsDir());
}

function afterBuild(install) {
    return {
        name: "bridges-and-install",
        setup(pluginBuild) {
            pluginBuild.onEnd((result) => {
                if (result.errors.length) return;
                writeBridges();
                if (install) installTo(pluginsDir());
            });
        },
    };
}

function writeBridges() {
    const text = readFileSync(outfile, "utf8");
    for (const name of BRIDGES) {
        const bridge = join(root, "dist", `${name}.plugin.js`);
        writeFileSync(bridge, asLegacy(text, name));
        console.log(`built ${bridge}`);
    }
}

function installTo(dir) {
    if (!existsSync(dir)) {
        console.warn(`BetterDiscord plugins folder not found: ${dir} (skipping install)`);
        return;
    }
    copyFileSync(outfile, join(dir, outName));
    console.log(`installed -> ${join(dir, outName)}`);
}

function pluginsDir() {
    const home = homedir();
    if (platform() === "win32") {
        return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "BetterDiscord", "plugins");
    }
    if (platform() === "darwin") {
        return join(home, "Library", "Application Support", "BetterDiscord", "plugins");
    }
    return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "BetterDiscord", "plugins");
}
