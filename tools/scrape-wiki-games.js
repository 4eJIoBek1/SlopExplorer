"use strict";

const path = require("path");
const fs = require("fs");

const _ = require("lodash");
const versionUtils = require("../src/version-utils");
const wikiUtils = require("./wiki-utils");

const GAMES = {
    yumenikki: {
        category: "Category:Yume Nikki Locations",
        startLocation: "Madotsuki's Room",
        namespace: "Yume Nikki:"
    },
    collectiveunconscious: {
        category: "Category:Collective Unconscious Locations",
        startLocation: "Minnatsuki's Room",
        namespace: "Collective Unconscious:"
    }
};

const API_BASE = "https://yume.wiki/api.php";
const PROXY = "socks5://127.0.0.1:10808";
const THUMB_WIDTH = 320;
const BATCH = 50;
const SECRETS_FILE = path.join(__dirname, ".cf-secrets.json");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let fetchImpl;
let secrets;
{
    secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8"));
    const { ProxyAgent } = require("undici");
    const agent = new ProxyAgent(PROXY);
    const baseHeaders = {
        "User-Agent": secrets.ua,
        "Cookie": `cf_clearance=${secrets.cf_clearance}`,
        "Referer": "https://yume.wiki/"
    };
    fetchImpl = (url, options = {}) => fetch(url, {
        ...options,
        dispatcher: agent,
        headers: { ...baseHeaders, ...(options.headers || {}) }
    });
}

async function fetchText(url, headers = {}, retries = 6) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(90000) });
            if (res.status === 403)
                throw new Error(`HTTP 403 (CF challenge) for ${url} - cookie expired or IP/UA mismatch, refresh cf_clearance in your browser`);
            if (!res.ok)
                throw new Error(`HTTP ${res.status} for ${url}`);
            return await res.text();
        } catch (err) {
            if (attempt === retries - 1)
                throw err;
            console.error(`retry ${attempt + 1}/${retries} for ${url}: ${err.message}`);
            await sleep(3000 * (attempt + 1));
        }
    }
}

async function api(params, retries = 6) {
    const qs = new URLSearchParams({ format: "json", smaxage: 0, ...params }).toString();
    const text = await fetchText(`${API_BASE}?${qs}`, { Accept: "application/json" });
    return JSON.parse(text);
}

async function fetchCategoryMembers(category) {
    const titles = [];
    let continueKey;
    const seen = new Set();
    do {
        if (continueKey != null && seen.has(continueKey))
            break;
        if (continueKey != null)
            seen.add(continueKey);
        const params = { action: "query", list: "categorymembers", cmtitle: category, cmlimit: "500" };
        if (continueKey)
            params.cmcontinue = continueKey;
        const data = await api(params);
        for (let m of data.query.categorymembers) {
            const t = m.title;
            if (t.startsWith("Category:") || t.includes("List of Locations"))
                continue;
            titles.push(t);
        }
        console.log(`  category members: ${titles.length}`);
        continueKey = data.continue && data.continue.cmcontinue;
        if (continueKey)
            await sleep(500);
    } while (continueKey);
    return titles;
}

function stripNamespace(title, namespace) {
    return title.startsWith(namespace) ? title.slice(namespace.length) : title;
}

async function fetchWikitext(titles) {
    const wikitext = {};
    for (let i = 0; i < titles.length; i += BATCH) {
        const batch = titles.slice(i, i + BATCH);
        const data = await api({
            action: "query",
            titles: batch.join("|"),
            prop: "revisions",
            rvprop: "content",
            rvslots: "main"
        });
        for (let page of Object.values(data.query.pages)) {
            if (page.missing)
                continue;
            const rev = page.revisions && page.revisions[0];
            if (rev && rev.slots && rev.slots.main)
                wikitext[page.title] = rev.slots.main["*"];
        }
        await sleep(500);
    }
    return wikitext;
}

function findTemplateInner(text, name, fromIndex) {
    const re = new RegExp(`\\{\\{\\s*${name}\\s*\\|`, "i");
    let searchFrom = fromIndex || 0;
    let m;
    while ((m = re.exec(text.slice(searchFrom)))) {
        const start = searchFrom + m.index;
        let depth = 1;
        let i = start + 2;
        for (; i < text.length; i++) {
            if (text.startsWith("{{", i)) {
                depth++;
                i++;
            } else if (text.startsWith("}}", i)) {
                depth--;
                if (depth === 0)
                    return { inner: text.slice(start + 2, i), end: i + 2 };
                i++;
            }
        }
        return null;
        searchFrom = start + 1;
    }
    return null;
}

function findAllTemplateInners(text, name) {
    const results = [];
    let from = 0;
    while (true) {
        const found = findTemplateInner(text, name, from);
        if (!found)
            break;
        results.push(found.inner);
        from = found.end;
    }
    return results;
}

function splitTopLevel(str) {
    const parts = [];
    let depth = 0;
    let link = 0;
    let cur = "";
    for (let i = 0; i < str.length; i++) {
        if (str.startsWith("{{", i)) {
            depth++;
            cur += "{{";
            i++;
        } else if (str.startsWith("}}", i)) {
            depth--;
            cur += "}}";
            i++;
        } else if (str.startsWith("[[", i)) {
            link++;
            cur += "[[";
            i++;
        } else if (str.startsWith("]]", i)) {
            link--;
            cur += "]]";
            i++;
        } else if (str[i] === "|" && depth === 0 && link === 0) {
            parts.push(cur);
            cur = "";
        } else
            cur += str[i];
    }
    parts.push(cur);
    return parts;
}

function parseTemplateArgs(inner) {
    const parts = splitTopLevel(inner);
    const positional = [];
    const named = {};
    for (let part of parts.slice(1)) {
        const eqIndex = part.indexOf("=");
        if (eqIndex > -1 && !part.slice(0, eqIndex).includes("{{") && !part.slice(0, eqIndex).includes("[")) {
            const key = part.slice(0, eqIndex).trim();
            const value = part.slice(eqIndex + 1).trim();
            named[key] = value;
        } else
            positional.push(part.trim());
    }
    return { positional, named };
}

function norm(value) {
    return String(value || "").trim().toLowerCase();
}

function connectionAttrs(named) {
    const attrs = [];
    const unlockType = norm(named.unlock_type);
    if (unlockType === "locked")
        attrs.push("Locked");
    else if (unlockType === "unlock")
        attrs.push("Unlockable");
    if (named.unlock_conditions || named.unlock_instruction_link || named.time) {
        attrs.push("Conditional");
        attrs.condition = named.unlock_conditions || named.unlock_instruction_link || named.time;
    }
    if (named.chance_description || named.chance_percentage) {
        attrs.push("Chance");
        attrs.chancePercentage = named.chance_percentage || "";
    }
    switch (norm(named.isolation_type)) {
        case "deadend":
            attrs.push("Dead End");
            break;
        case "return":
            attrs.push("Return");
            break;
    }
    switch (norm(named.one_way_type)) {
        case "noreturn":
            attrs.push("No Return");
            break;
        case "noentry":
            attrs.push("No Entry");
            break;
    }
    switch (norm(named.phonebooth_type)) {
        case "shortcut":
            attrs.push("Shortcut");
            break;
        case "exitpoint":
            attrs.push("Exit Point");
            break;
    }
    switch (norm(named.chaser_type)) {
        case "trap":
            attrs.push("No Entry", "Dead End");
            break;
        case "catch":
            attrs.push("No Return", "Return");
            break;
    }
    if (named.effects_needed)
        attrs.push("Needs Effect");
    if (named.season)
        attrs.push("Seasonal");
    return attrs;
}

function parseConnections(value) {
    const conns = [];
    if (!value)
        return conns;
    for (let inner of findAllTemplateInners(value, "Connection")) {
        const { positional, named } = parseTemplateArgs(inner);
        const destination = positional[0];
        if (!destination)
            continue;
        if (norm(named.is_removed) === "true")
            continue;
        const attrs = connectionAttrs(named);
        conns.push({
            destination,
            attributes: attrs,
            unlockCondition: attrs.condition || "",
            effectsNeeded: named.effects_needed ? [named.effects_needed] : [],
            seasonAvailable: named.season || "",
            chancePercentage: attrs.chancePercentage || ""
        });
    }
    return conns;
}

async function resolveFileUrls(fileNames) {
    const urls = {};
    for (let i = 0; i < fileNames.length; i += BATCH) {
        const batch = fileNames.slice(i, i + BATCH);
        const data = await api({
            action: "query",
            titles: batch.map(f => `File:${f}`).join("|"),
            prop: "imageinfo",
            iiprop: "url",
            iiurlwidth: String(THUMB_WIDTH)
        });
        for (let page of Object.values(data.query.pages)) {
            if (page.missing || !page.imageinfo || !page.imageinfo.length)
                continue;
            const ii = page.imageinfo[0];
            const name = page.title.replace(/^File:/, "").replace(/_/g, " ");
            urls[name] = { url: ii.url, thumburl: ii.thumburl || ii.url };
        }
        await sleep(500);
    }
    return urls;
}

async function downloadFile(url, destPath, retries = 4) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetchImpl(url, {
                headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
                signal: AbortSignal.timeout(90000)
            });
            if (res.status === 403)
                throw new Error(`HTTP 403 for ${url} - cookie expired`);
            if (!res.ok)
                throw new Error(`HTTP ${res.status} for ${url}`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (!buf.length)
                throw new Error(`empty body for ${url}`);
            fs.writeFileSync(destPath, buf);
            return true;
        } catch (err) {
            if (attempt === retries - 1) {
                console.error(`  FAIL ${destPath}: ${err.message}`);
                return false;
            }
            await sleep(3000 * (attempt + 1));
        }
    }
    return false;
}

function sanitizeTitle(title) {
    return title.replace(/[\\/]/g, "");
}

async function scrapeGame(gameKey) {
    const cfg = GAMES[gameKey];
    const imagesDir = path.resolve(__dirname, "..", "public", "images", gameKey, "worlds");
    const dataDir = path.resolve(__dirname, "..", "public", "data", gameKey);
    const dataFile = path.join(dataDir, "data.json");

    console.log(`=== Scraping ${gameKey} (${cfg.category}) ===`);
    console.log("Fetching category members...");
    const pageTitles = await fetchCategoryMembers(cfg.category);
    console.log(`  ${pageTitles.length} locations`);

    console.log("Fetching wikitext...");
    const wikitext = await fetchWikitext(pageTitles);

    console.log("Parsing Locationbox...");
    const worldsRaw = [];
    for (let fullTitle of pageTitles) {
        const wt = wikitext[fullTitle];
        if (!wt) {
            console.error(`  missing wikitext for ${fullTitle}`);
            continue;
        }
        const found = findTemplateInner(wt, "Locationbox", 0);
        if (!found) {
            console.log(`  skip (overview page, no Locationbox): ${fullTitle}`);
            continue;
        }
        const { named } = parseTemplateArgs(found.inner);
        const title = stripNamespace(fullTitle, cfg.namespace);

        const mapInners = findAllTemplateInners(wt, "LocationMap");
        const mapFiles = [];
        const mapCaptions = [];
        for (let inner of mapInners) {
            const mArgs = parseTemplateArgs(inner);
            const file = mArgs.named.filename;
            if (!file)
                continue;
            mapFiles.push(file);
            mapCaptions.push(mArgs.named.caption || "");
        }

        const bgmInners = findAllTemplateInners(named.BGM || "", "BGM");
        const bgmFiles = [];
        const bgmLabels = [];
        for (let inner of bgmInners) {
            const bArgs = parseTemplateArgs(inner);
            const file = bArgs.named.filename;
            if (!file)
                continue;
            bgmFiles.push(file);
            bgmLabels.push(`${bArgs.named.title || ""}^${bArgs.named.label || ""}`);
        }

        const mapId = (named["Map ID"] || "").trim();
        const size = mapId ? splitTopLevel(mapId).length : 1;

        const versionsUpdatedRaw = (named.VersionsUpdated || "").split(",").map(s => s.trim()).filter(Boolean);

        const primaryRaw = (named.Primary || "").trim();
        const author = primaryRaw.split(",").map(s => s.trim()).filter(Boolean).join(", ");

        worldsRaw.push({
            title,
            titleJP: named.JapaneseName || "",
            author,
            image: (named.image || "").trim().replace(/^File:/, ""),
            mapFiles,
            mapCaptions,
            bgmFiles,
            bgmLabels,
            connections: parseConnections(named.Connections).concat(parseConnections(named.RemovedConnections)),
            size,
            hasMapId: Boolean(mapId),
            verAdded: (named.VersionAdded || "").trim() || null,
            verUpdated: versionsUpdatedRaw.length ? versionUtils.parseVersionsUpdated(versionsUpdatedRaw.join(",")) : null
        });
    }
    console.log(`  parsed ${worldsRaw.length} worlds`);

    const allFileNames = _.uniq(_.flatten([
        worldsRaw.map(w => w.image).filter(Boolean),
        worldsRaw.map(w => w.mapFiles).flat(),
        worldsRaw.map(w => w.bgmFiles).flat()
    ]));
    console.log(`Resolving ${allFileNames.length} file URLs...`);
    const fileUrls = await resolveFileUrls(allFileNames);
    const normName = name => {
        const s = String(name || "").replace(/_/g, " ");
        return s ? s[0].toUpperCase() + s.slice(1) : s;
    };

    console.log(`Downloading world images to ${imagesDir}...`);
    fs.mkdirSync(imagesDir, { recursive: true });
    const worldData = [];
    let downloaded = 0;
    for (let raw of worldsRaw) {
        const imageName = normName(raw.image);
        const localFilename = `${sanitizeTitle(raw.title)}${raw.image ? path.extname((fileUrls[imageName] || {}).url || raw.image) : ""}`;
        let filename;
        if (raw.image && fileUrls[imageName]) {
            const destPath = path.join(imagesDir, localFilename);
            if (!fs.existsSync(destPath)) {
                if (await downloadFile(fileUrls[imageName].thumburl, destPath))
                    downloaded++;
            }
            if (fs.existsSync(destPath))
                filename = `./images/${gameKey}/worlds/${localFilename}`;
            else
                filename = fileUrls[imageName].thumburl;
        }

        const mapUrl = raw.mapFiles.map(f => fileUrls[normName(f)] ? fileUrls[normName(f)].url : f).filter(Boolean).join("|") || null;
        const mapLabel = raw.mapCaptions.join("|") || null;
        const bgmUrl = raw.bgmFiles.map(f => fileUrls[normName(f)] ? fileUrls[normName(f)].url : f).filter(Boolean).join("|") || null;
        const bgmLabel = raw.bgmLabels.join("|") || null;

        worldData.push({
            title: raw.title,
            titleJP: raw.titleJP,
            author: raw.author,
            depth: 1,
            minDepth: 1,
            filename,
            mapUrl,
            mapLabel,
            bgmUrl,
            bgmLabel,
            verAdded: raw.verAdded,
            verRemoved: null,
            verUpdated: raw.verUpdated,
            verGaps: null,
            removed: false,
            connections: raw.connections.map(conn => wikiUtils.parseWorldConn(conn)),
            images: [],
            size: raw.size,
            noMaps: !raw.hasMapId,
            hidden: false,
            secret: false
        });
    }
    console.log(`  downloaded ${downloaded} new images, total ${worldData.length} worlds`);

    for (let d in worldData) {
        const world = worldData[d];
        world.id = parseInt(d, 10);
    }

    const worldDataByName = _.keyBy(worldData, w => w.title);
    for (let world of worldData) {
        world.connections = world.connections
            .map(conn => {
                const targetWorld = worldDataByName[conn.location];
                if (!targetWorld) {
                    console.error(`  unresolved connection target: ${world.title} -> ${conn.location}`);
                    return null;
                }
                return {
                    targetId: targetWorld.id,
                    type: conn.type,
                    typeParams: conn.typeParams
                };
            })
            .filter(conn => conn != null);
    }

    console.log("Computing depths...");
    const worldDataById = _.keyBy(worldData, w => w.id);
    const depthMap = {};
    const minDepthMap = {};
    for (let world of worldData) {
        depthMap[world.title] = -1;
        minDepthMap[world.title] = -1;
    }
    wikiUtils.calcDepth(worldData, worldDataById, depthMap, null, 0, wikiUtils.defaultPathIgnoreConnTypeFlags, "depth", null, false, cfg.startLocation);
    wikiUtils.calcDepth(worldData, worldDataById, minDepthMap, null, 0, wikiUtils.minDepthPathIgnoreConnTypeFlags, "minDepth", null, false, cfg.startLocation);

    console.log("Building version info...");
    const uniqueWorldVersionNames = versionUtils.getUniqueWorldVersionNames(worldData);
    const versionInfoData = uniqueWorldVersionNames.map(name => ({ name })).sort((vi1, vi2) => versionUtils.compareVersionNames(vi2.name, vi1.name));

    console.log("Building author info...");
    const authorNames = _.uniq(worldData.map(w => w.author).filter(Boolean));
    const authorInfoData = authorNames.map(name => ({ name, nameJP: name }));

    const lastUpdate = new Date().toISOString();
    const data = {
        worldData,
        authorInfoData,
        versionInfoData,
        effectData: [],
        menuThemeData: [],
        wallpaperData: [],
        bgmTrackData: [],
        lastUpdate,
        lastFullUpdate: lastUpdate,
        isAdmin: false
    };

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(data));
    console.log(`Wrote ${dataFile} (${(fs.statSync(dataFile).size / 1024).toFixed(1)} KB, ${worldData.length} worlds, ${authorInfoData.length} authors, ${versionInfoData.length} versions)`);
}

async function main() {
    const gamesArg = process.argv.slice(2).map(a => a.replace(/^--?game[=:]?/, "")).filter(Boolean);
    const targets = gamesArg.length ? gamesArg.filter(g => GAMES[g]) : Object.keys(GAMES);
    for (let gameKey of targets) {
        await scrapeGame(gameKey);
    }
    console.log("Done.");
}

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = {
    findTemplateInner,
    findAllTemplateInners,
    splitTopLevel,
    parseTemplateArgs,
    connectionAttrs,
    parseConnections,
    api,
    fetchCategoryMembers,
    stripNamespace,
    GAMES
};