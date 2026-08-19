"use strict";

const _ = require("lodash");
const { ConnType } = require("../src/conn-type");

const defaultPathIgnoreConnTypeFlags = ConnType.NO_ENTRY | ConnType.LOCKED | ConnType.DEAD_END | ConnType.ISOLATED | ConnType.LOCKED_CONDITION | ConnType.EXIT_POINT;
const minDepthPathIgnoreConnTypeFlags = ConnType.NO_ENTRY | ConnType.DEAD_END | ConnType.ISOLATED;

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

function calcDepth(worldData, worldDataById, depthMap, world, depth, ignoreTypeFlags, depthProp, targetWorldName, removed, startLocation) {
    const worldDataByName = _.keyBy(worldData, w => w.title);
    const worldNames = Object.keys(worldDataByName);
    let currentWorld;
    if (depth > 0)
        currentWorld = world;
    else if (depth === 0) {
        currentWorld = worldDataByName[startLocation];
        if (!currentWorld)
            throw new Error(`Start location not found: ${startLocation}`);
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
                    calcDepth(worldData, worldDataById, depthMap, connWorld, depth + 1, ignoreTypeFlags, depthProp, null, removed || connWorld.removed, startLocation);
            }
        }
    }

    if (world === null) {
        let missingDepthWorlds;
        const worldDataByName2 = _.keyBy(worldData, w => w.title);

        let anyDepthFound;

        while (true) {
            anyDepthFound = false;

            missingDepthWorlds = worldData.filter(w => depthMap[w.title] === -1 && w.title !== startLocation);
            missingDepthWorlds.forEach(w => anyDepthFound |= resolveMissingDepths(worldData, worldDataById, worldDataByName2, depthMap, w, ignoreTypeFlags, depthProp, startLocation));

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

function resolveMissingDepths(worldData, worldDataById, worldDataByName, depthMap, world, ignoreTypeFlags, depthProp, startLocation) {
    const worldNames = Object.keys(worldDataByName);
    const conns = world.connections.filter(c => c.targetId ? worldDataById[c.targetId] : worldNames.indexOf(c.location) > -1);

    for (let c of conns) {
        let sourceWorld = c.targetId ? worldDataById[c.targetId] : worldDataByName[c.location];
        if (!sourceWorld.removed && c.type & ConnType.INACCESSIBLE)
            continue;
        if (sourceWorld[depthProp] !== undefined)
            calcDepth(worldData, worldDataById, depthMap, sourceWorld, depthMap[sourceWorld.title], ignoreTypeFlags, depthProp, world.title, sourceWorld.removed, startLocation);
    }

    if (depthMap[world.title] > -1) {
        conns.filter(c => depthMap[c.location ? c.location : worldDataById[c.targetId].title] === -1)
            .forEach(c => resolveMissingDepths(worldData, worldDataById, worldDataByName, depthMap, c.targetId ? worldDataById[c.targetId] : worldDataByName[c.location], ignoreTypeFlags, depthProp, startLocation));
        return true;
    }

    return false;
}

module.exports = {
    defaultPathIgnoreConnTypeFlags,
    minDepthPathIgnoreConnTypeFlags,
    getWorldFilename,
    parseWorldConn,
    calcDepth,
    resolveMissingDepths
};