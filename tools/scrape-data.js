"use strict";

const path = require("path");
const fs = require("fs");

const _ = require("lodash");
const versionUtils = require("../src/version-utils");
const { ConnType } = require("../src/conn-type");
const wikiUtils = require("./wiki-utils");

const WRAPPER_BASE = "https://wrapper.yume.wiki";
const GAME = "2kki";
const START_LOCATION = "Urotsuki's Room";
const IMAGES_DIR = path.resolve(__dirname, "..", "public", "images", GAME, "worlds");
const DATA_DIR = path.resolve(__dirname, "..", "public", "data", GAME);
const DATA_FILE = path.join(DATA_DIR, "data.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const maxLocations = process.env.SCRAPE_MAX_LOCATIONS ? parseInt(process.env.SCRAPE_MAX_LOCATIONS, 10) : null;
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
        const { localFilename, locationImage } = wikiUtils.getWorldFilename(l);
        let filename;
        if (locationImage) {
            const destPath = path.join(IMAGES_DIR, localFilename);
            if (fs.existsSync(destPath))
                filename = `./images/${GAME}/worlds/${localFilename}`;
            else
                filename = locationImage;
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
        sourceWorld.connections.push(wikiUtils.parseWorldConn(conn));
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

    wikiUtils.calcDepth(worldData, worldDataById, depthMap, null, 0, wikiUtils.defaultPathIgnoreConnTypeFlags, "depth", null, false, START_LOCATION);
    wikiUtils.calcDepth(worldData, worldDataById, minDepthMap, null, 0, wikiUtils.minDepthPathIgnoreConnTypeFlags, "minDepth", null, false, START_LOCATION);

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
