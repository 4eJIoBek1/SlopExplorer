"use strict";

const path = require("path");
const fs = require("fs");

const _ = require("lodash");
const versionUtils = require("../src/version-utils");
const { ConnType } = require("../src/conn-type");

const WRAPPER_BASE = "https://wrapper.yume.wiki";
const GAME = "2kki";
const START_LOCATION = "Urotsuki's Room";
const IMAGES_DIR = path.resolve(__dirname, "..", "public", "images", "worlds");
const DATA_DIR = path.resolve(__dirname, "..", "public", "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const WESERV_BASE = "https://images.weserv.nl/?url=";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const maxLocations = process.env.SCRAPE_MAX_LOCATIONS ? parseInt(process.env.SCRAPE_MAX_LOCATIONS, 10) : null;
const skipImages = process.env.SCRAPE_SKIP_IMAGES === "1";
const proxyUrl = process.env.SCRAPE_PROXY;

let fetchImpl = globalThis.fetch;
if (proxyUrl) {
    const { ProxyAgent } = require("undici");
    const agent = new ProxyAgent(proxyUrl.replace(/^socks5h:\/\//, "socks5://"));
    fetchImpl = (url, options) => fetch(url, { ...options, dispatcher: agent });
    console.log(`Using proxy: ${proxyUrl}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetchImpl(url, {
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(60000)
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status} for ${url}`);
            return await res.json();
        } catch (err) {
            if (attempt === retries - 1)
                throw err;
            console.error(`retry ${attempt + 1}/${retries} for ${url}: ${err.message}`);
            await sleep(3000 * (attempt + 1));
        }
    }
}

async function fetchPaged(endpoint, field) {
    const results = [];
    const seenKeys = new Set();
    let continueKey;
    do {
        if (continueKey != null && seenKeys.has(continueKey))
            break;
        if (continueKey != null)
            seenKeys.add(continueKey);
        const url = `${WRAPPER_BASE}/${endpoint}?game=${GAME}${continueKey != null ? `&continueKey=${encodeURIComponent(continueKey)}` : ""}`;
        const data = await fetchJson(url);
        const entries = Array.isArray(data) ? data : data[field];
        results.push(...entries);
        console.log(`  ${endpoint}: ${results.length} entries`);
        continueKey = data.continueKey;
        if (continueKey)
            await sleep(500);
        if (maxLocations && endpoint === "locations" && results.length >= maxLocations)
            break;
    } while (continueKey != null);
    return results;
}

async function downloadImage(imageUrl, destPath) {
    const res = await fetchImpl(imageUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(60000),
        redirect: "follow"
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status} for ${imageUrl}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
}

function getWeservUrl(imageUrl) {
    return `${WESERV_BASE}${encodeURIComponent(imageUrl)}`;
}

function getWorldFilename(location) {
    const locationImage = location.locationImage || "";
    const extMatch = locationImage.match(/\.\w+(?:\?\S*)?$/);
    const ext = extMatch ? locationImage.slice(locationImage.lastIndexOf(".")) : "";
    const localFilename = `${location.title.replace(/[\\/]/g, "")}${ext}`;
    return { localFilename, locationImage };
}

function parseWorldConn(conn) {
    const ret = {
        location: conn.destination,
        type: 0,
        typeParams: {}
    };

    for (let attr of conn.attributes) {
        switch (attr) {
            case "No Return":
                ret.type |= ConnType.ONE_WAY;
                break;
            case "No Entry":
                ret.type |= ConnType.NO_ENTRY;
                break;
            case "Unlockable":
                ret.type |= ConnType.UNLOCK;
                break;
            case "Locked":
                ret.type |= ConnType.LOCKED;
                break;
            case "Conditional":
                ret.type |= ConnType.LOCKED_CONDITION;
                let conditionText = (conn.unlockCondition || "").replace(/^Require(s|d) (to )?/, "").replace(/\.$/, "");
                conditionText = conditionText.substring(0, 1).toUpperCase() + conditionText.slice(1);
                ret.typeParams[ConnType.LOCKED_CONDITION] = { params: conditionText };
                break;
            case "Shortcut":
                ret.type |= ConnType.SHORTCUT;
                break;
            case "Exit Point":
                ret.type |= ConnType.EXIT_POINT;
                break;
            case "Dead End":
                ret.type |= ConnType.DEAD_END;
                break;
            case "Return":
                ret.type |= ConnType.ISOLATED;
                break;
            case "Needs Effect":
                ret.type |= ConnType.EFFECT;
                ret.typeParams[ConnType.EFFECT] = { params: (conn.effectsNeeded || []).join(",") };
                break;
            case "Chance":
                ret.type |= ConnType.CHANCE;
                ret.typeParams[ConnType.CHANCE] = { params: conn.chancePercentage || "" };
                break;
            case "Seasonal":
                ret.type |= ConnType.SEASONAL;
                const connSeason = conn.seasonAvailable || "";
                let connSeasonJP;
                switch (conn.seasonAvailable) {
                    case "Spring":
                        connSeasonJP = "春";
                        break;
                    case "Summer":
                        connSeasonJP = "夏";
                        break;
                    case "Fall":
                        connSeasonJP = "秋";
                        break;
                    case "Winter":
                        connSeasonJP = "冬";
                        break;
                }
                ret.typeParams[ConnType.SEASONAL] = { params: connSeason, paramsJP: connSeasonJP };
                break;
        }
    }

    return ret;
}

const defaultPathIgnoreConnTypeFlags = ConnType.NO_ENTRY | ConnType.LOCKED | ConnType.DEAD_END | ConnType.ISOLATED | ConnType.LOCKED_CONDITION | ConnType.EXIT_POINT;
const minDepthPathIgnoreConnTypeFlags = ConnType.NO_ENTRY | ConnType.DEAD_END | ConnType.ISOLATED;

function calcDepth(worldData, worldDataById, depthMap, world, depth, ignoreTypeFlags, depthProp, targetWorldName, removed) {
    const worldDataByName = _.keyBy(worldData, w => w.title);
    const worldNames = Object.keys(worldDataByName);
    let currentWorld;
    if (depth > 0)
        currentWorld = world;
    else if (depth === 0) {
        currentWorld = worldDataByName[START_LOCATION];
        if (!currentWorld)
            throw new Error(`Start location not found: ${START_LOCATION}`);
        currentWorld[depthProp] = depthMap[currentWorld.title] = depth;
    } else
        return depth;
    for (let conn of currentWorld.connections) {
        const targetWorld = worldDataById[conn.targetId];
        const w = targetWorld ? targetWorld.title : conn.location;
        if (worldNames.indexOf(w) > -1 && (!targetWorldName || w === targetWorldName)) {
            if (conn.type & ignoreTypeFlags)
                continue;
            const connWorld = worldDataByName[w];
            if ((removed && !connWorld.removed) || (!removed && (!connWorld.removed && conn.type & ConnType.INACCESSIBLE)))
                continue;
            const d = depthMap[w];
            if (d === -1 || d > depth + 1) {
                connWorld[depthProp] = depthMap[w] = depth + 1;
                if (!targetWorldName)
                    calcDepth(worldData, worldDataById, depthMap, connWorld, depth + 1, ignoreTypeFlags, depthProp, null, removed || connWorld.removed);
            }
        }
    }

    if (world === null) {
        let missingDepthWorlds;
        const worldDataByName2 = _.keyBy(worldData, w => w.title);

        let anyDepthFound;

        while (true) {
            anyDepthFound = false;

            missingDepthWorlds = worldData.filter(w => depthMap[w.title] === -1 && w.title !== START_LOCATION);
            missingDepthWorlds.forEach(w => anyDepthFound |= resolveMissingDepths(worldData, worldDataById, worldDataByName2, depthMap, w, ignoreTypeFlags, depthProp));

            if (missingDepthWorlds.length) {
                if (!anyDepthFound) {
                    if (ignoreTypeFlags & ConnType.LOCKED_CONDITION)
                        ignoreTypeFlags ^= ConnType.LOCKED_CONDITION;
                    else if (ignoreTypeFlags & ConnType.LOCKED)
                        ignoreTypeFlags ^= ConnType.LOCKED;
                    else if (ignoreTypeFlags & ConnType.EXIT_POINT)
                        ignoreTypeFlags ^= ConnType.EXIT_POINT;
                    else if (ignoreTypeFlags & ConnType.DEAD_END || ignoreTypeFlags & ConnType.ISOLATED)
                        ignoreTypeFlags ^= ConnType.DEAD_END | ConnType.ISOLATED;
                    else if (ignoreTypeFlags & ConnType.NO_ENTRY)
                        ignoreTypeFlags ^= ConnType.NO_ENTRY;
                    else
                        break;
                }
            } else
                break;
        }

        for (let world2 of worldData) {
            if (world2[depthProp] === undefined)
                world2[depthProp] = 1;
        }
    }

    return depth;
}

function resolveMissingDepths(worldData, worldDataById, worldDataByName, depthMap, world, ignoreTypeFlags, depthProp) {
    const worldNames = Object.keys(worldDataByName);
    const conns = world.connections.filter(c => c.targetId ? worldDataById[c.targetId] : worldNames.indexOf(c.location) > -1);

    for (let c of conns) {
        let sourceWorld = c.targetId ? worldDataById[c.targetId] : worldDataByName[c.location];
        if (!sourceWorld.removed && c.type & ConnType.INACCESSIBLE)
            continue;
        if (sourceWorld[depthProp] !== undefined)
            calcDepth(worldData, worldDataById, depthMap, sourceWorld, depthMap[sourceWorld.title], ignoreTypeFlags, depthProp, world.title, sourceWorld.removed);
    }

    if (depthMap[world.title] > -1) {
        conns.filter(c => depthMap[c.location ? c.location : worldDataById[c.targetId].title] === -1)
            .forEach(c => resolveMissingDepths(worldData, worldDataById, worldDataByName, depthMap, c.targetId ? worldDataById[c.targetId] : worldDataByName[c.location], ignoreTypeFlags, depthProp));
        return true;
    }

    return false;
}

async function main() {
    console.log("Fetching wrapper data...");
    const [locations, connections, authors] = await Promise.all([
        fetchPaged("locations", "locations"),
        fetchPaged("connections", "connections"),
        fetchPaged("authors", "authors")
    ]);

    console.log(`Building worldData (${locations.length} locations)...`);
    const worldData = [];
    const worldDataByName = {};

    for (let l of locations) {
        const { localFilename, locationImage } = getWorldFilename(l);
        let filename;
        if (locationImage) {
            if (!skipImages) {
                const destPath = path.join(IMAGES_DIR, localFilename);
                if (fs.existsSync(destPath))
                    filename = `./images/worlds/${localFilename}`;
                else {
                    try {
                        fs.mkdirSync(IMAGES_DIR, { recursive: true });
                        await downloadImage(encodeURI(locationImage), destPath);
                        console.log(`  saved image: ${localFilename}`);
                        filename = `./images/worlds/${localFilename}`;
                    } catch (err) {
                        console.error(`  image download failed for ${localFilename}: ${err.message} - using weserv`);
                        filename = getWeservUrl(encodeURI(locationImage));
                    }
                }
            } else
                filename = getWeservUrl(encodeURI(locationImage));
        }

        const versionsUpdated = l.versionsUpdated || [];
        const versionGaps = l.versionGaps || [];

        const world = {
            title: l.title,
            titleJP: l.originalName,
            author: l.primaryAuthor,
            depth: 1,
            minDepth: 1,
            filename,
            mapUrl: l.locationMaps && l.locationMaps.length ? l.locationMaps.map(m => m.path).join("|") : null,
            mapLabel: l.locationMaps && l.locationMaps.length ? l.locationMaps.map(m => m.caption).join("|") : null,
            bgmUrl: l.bgms && l.bgms.length ? l.bgms.map(b => b.path).join("|") : null,
            bgmLabel: l.bgms && l.bgms.length ? l.bgms.map(b => `${b.title || ""}^${b.label || ""}`).join("|") : null,
            verAdded: l.versionAdded,
            verRemoved: l.versionRemoved || null,
            verUpdated: versionsUpdated.length ? versionUtils.parseVersionsUpdated(versionsUpdated.join(",")) : null,
            verGaps: versionGaps.length ? versionUtils.parseVersionGaps(versionGaps.join(",")) : null,
            removed: !!l.versionRemoved,
            connections: [],
            images: [],
            size: (l.mapIds && l.mapIds.length) ? l.mapIds.length : 1,
            noMaps: true,
            hidden: false,
            secret: false
        };
        worldData.push(world);
        worldDataByName[world.title] = world;
    }

    console.log("Building connections...");
    const seenConns = new Set();
    let rawConnCount = 0;
    for (let conn of connections) {
        rawConnCount++;
        if (conn.isRemoved)
            continue;
        const connKey = [conn.origin, conn.destination, (conn.attributes || []).join(","), conn.unlockCondition || "", (conn.effectsNeeded || []).join(","), conn.seasonAvailable || "", conn.chancePercentage || ""].join("\u0000");
        if (seenConns.has(connKey))
            continue;
        seenConns.add(connKey);
        const sourceWorld = worldDataByName[conn.origin];
        if (!sourceWorld)
            continue;
        sourceWorld.connections.push(parseWorldConn(conn));
    }
    console.log(`  connections: ${rawConnCount} raw, ${seenConns.size} unique, ${worldData.reduce((n, w) => n + w.connections.length, 0)} after filtering`);

    for (let d in worldData) {
        const world = worldData[d];
        world.id = parseInt(d, 10);
        if (!world.author)
            world.author = "";
    }

    for (let d in worldData) {
        const world = worldData[d];
        world.connections = world.connections
            .map(conn => {
                const targetWorld = worldDataByName[conn.location];
                if (!targetWorld)
                    return null;
                if (conn.type & ConnType.INACCESSIBLE)
                    return null;
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

    calcDepth(worldData, worldDataById, depthMap, null, 0, defaultPathIgnoreConnTypeFlags, "depth");
    calcDepth(worldData, worldDataById, minDepthMap, null, 0, minDepthPathIgnoreConnTypeFlags, "minDepth");

    console.log("Building author info...");
    const authorInfoData = (authors || []).map(author => ({
        name: author.name,
        nameJP: author.originalName
    }));

    console.log("Building version info...");
    const uniqueWorldVersionNames = versionUtils.getUniqueWorldVersionNames(worldData);
    const versionInfoData = uniqueWorldVersionNames.map(name => ({ name })).sort((vi1, vi2) => versionUtils.compareVersionNames(vi2.name, vi1.name));

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

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
    console.log(`Wrote ${DATA_FILE} (${(fs.statSync(DATA_FILE).size / 1024 / 1024).toFixed(2)} MB, ${worldData.length} worlds)`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
