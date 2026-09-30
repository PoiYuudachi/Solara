/**
 * Solara 本地与云端持久化存储层 (LocalStorage + Cloudflare D1 / SQLite Storage API)
 */

import {
    REMOTE_STORAGE_ENDPOINT,
    STORAGE_KEYS_TO_SYNC,
    PALETTE_STORAGE_KEY,
    API,
    SOURCE_OPTIONS,
    normalizeSource
} from "../constants.js";

let remoteSyncEnabled = false;

export function setRemoteSyncEnabled(enabled) {
    remoteSyncEnabled = Boolean(enabled);
}

export function isRemoteSyncEnabled() {
    return remoteSyncEnabled;
}

export function createPersistentStorageClient() {
    let availabilityPromise = null;
    let remoteAvailable = false;

    const checkAvailability = async () => {
        if (availabilityPromise) {
            return availabilityPromise;
        }
        availabilityPromise = (async () => {
            try {
                const url = new URL(REMOTE_STORAGE_ENDPOINT, window.location.origin);
                url.searchParams.set("status", "1");
                const response = await fetch(url.toString(), { method: "GET" });
                if (!response.ok) {
                    return false;
                }
                const result = await response.json().catch(() => ({}));
                remoteAvailable = Boolean(result && result.d1Available);
                return remoteAvailable;
            } catch (error) {
                console.warn("检查远程存储可用性失败", error);
                return false;
            }
        })();
        return availabilityPromise;
    };

    const getItems = async (keys = []) => {
        const available = await checkAvailability();
        if (!available || !Array.isArray(keys) || keys.length === 0) {
            return null;
        }
        try {
            const url = new URL(REMOTE_STORAGE_ENDPOINT, window.location.origin);
            url.searchParams.set("keys", keys.join(","));
            const response = await fetch(url.toString(), { method: "GET" });
            if (!response.ok) {
                return null;
            }
            return await response.json();
        } catch (error) {
            console.warn("获取远程存储数据失败", error);
            return null;
        }
    };

    const setItems = async (items) => {
        const available = await checkAvailability();
        if (!available || !items || typeof items !== "object") {
            return false;
        }
        try {
            await fetch(REMOTE_STORAGE_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data: items }),
            });
            return true;
        } catch (error) {
            console.warn("写入远程存储失败", error);
            return false;
        }
    };

    const removeItems = async (keys = []) => {
        const available = await checkAvailability();
        if (!available || !Array.isArray(keys) || keys.length === 0) {
            return false;
        }
        try {
            await fetch(REMOTE_STORAGE_ENDPOINT, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ keys }),
            });
            return true;
        } catch (error) {
            console.warn("删除远程存储数据失败", error);
            return false;
        }
    };

    return {
        checkAvailability,
        getItems,
        setItems,
        removeItems,
    };
}

export const persistentStorage = createPersistentStorageClient();

export function shouldSyncStorageKey(key) {
    return STORAGE_KEYS_TO_SYNC.has(key);
}

export function persistStorageItems(items) {
    if (!items || typeof items !== "object") {
        return;
    }
    persistentStorage.setItems(items).catch((error) => {
        console.warn("同步远程存储失败", error);
    });
}

export function removePersistentItems(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) {
        return;
    }
    persistentStorage.removeItems(keys).catch((error) => {
        console.warn("移除远程存储数据失败", error);
    });
}

export function syncLocalDataToCloud() {
    if (!remoteSyncEnabled) return;
    const itemsToUpload = {};
    for (const key of STORAGE_KEYS_TO_SYNC) {
        const val = safeGetLocalStorage(key);
        if (val != null && val !== "") {
            itemsToUpload[key] = val;
        }
    }
    if (Object.keys(itemsToUpload).length > 0) {
        persistStorageItems(itemsToUpload);
    }
}

export function safeGetLocalStorage(key) {
    try {
        return localStorage.getItem(key);
    } catch (error) {
        console.warn(`读取本地存储失败: ${key}`, error);
        return null;
    }
}

export function safeSetLocalStorage(key, value, options = {}) {
    const { skipRemote = false } = options;
    try {
        localStorage.setItem(key, value);
    } catch (error) {
        console.warn(`写入本地存储失败: ${key}`, error);
    }
    if (!skipRemote && remoteSyncEnabled && shouldSyncStorageKey(key)) {
        persistStorageItems({ [key]: value });
    }
}

export function safeRemoveLocalStorage(key, options = {}) {
    const { skipRemote = false } = options;
    try {
        localStorage.removeItem(key);
    } catch (error) {
        console.warn(`移除本地存储失败: ${key}`, error);
    }
    if (!skipRemote && remoteSyncEnabled && shouldSyncStorageKey(key)) {
        removePersistentItems([key]);
    }
}

export function parseJSON(value, fallback) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed;
    } catch (error) {
        console.warn("解析本地存储 JSON 失败", error);
        return fallback;
    }
}

export function cloneSearchResults(results) {
    if (!Array.isArray(results)) {
        return [];
    }
    try {
        return JSON.parse(JSON.stringify(results));
    } catch (error) {
        console.warn("复制搜索结果失败，回退到浅拷贝", error);
        return results.map((item) => {
            if (item && typeof item === "object") {
                return { ...item };
            }
            return item;
        });
    }
}

export function sanitizeStoredSearchState(data, defaultSource = "netease") {
    if (!data || typeof data !== "object") {
        return null;
    }

    const keyword = typeof data.keyword === "string" ? data.keyword : "";
    // 归一化音源：已被移除的音源（如 kuwo/joox/bilibili）自动回退到当前默认音源
    const source = normalizeSource(typeof data.source === "string" ? data.source : defaultSource);
    const page = Number.isInteger(data.page) && data.page > 0 ? data.page : 1;
    const hasMore = typeof data.hasMore === "boolean" ? data.hasMore : true;
    const results = cloneSearchResults(data.results);

    return { keyword, source, page, hasMore, results };
}

/**
 * 判断歌曲所属音源是否仍然可用（用于清理失效音源的历史数据）。
 * 关键：source 缺失或为空字符串时 getSongUrl() 会回退到默认音源，这些歌曲仍可播放，
 * 必须保留；只有「非空但已不在 SOURCE_OPTIONS 中」的音源才算失效。
 */
export function isSupportedSongSource(song) {
    const source = song && typeof song.source === "string" ? song.source.trim().toLowerCase() : "";
    if (source === "") {
        return true;
    }
    return SOURCE_OPTIONS.some((option) => option.value.toLowerCase() === source);
}

/** 依据旧索引在过滤后重新定位：指向同一首歌；若该曲被移除则退到其后第一首 */
function remapIndexAfterPrune(oldIndex, keepFlags) {
    if (!Number.isInteger(oldIndex) || oldIndex < 0) {
        return oldIndex;
    }
    const keptCount = keepFlags.reduce((count, keep) => count + (keep ? 1 : 0), 0);
    if (keptCount === 0) {
        return -1;
    }
    let newIndex = 0;
    for (let i = 0; i < oldIndex && i < keepFlags.length; i += 1) {
        if (keepFlags[i]) {
            newIndex += 1;
        }
    }
    return Math.min(newIndex, keptCount - 1);
}

/**
 * 清理历史数据中来自已失效音源的歌曲（一次性数据迁移）。
 * 返回清理后的列表、被移除的数量，以及与当前曲目对齐后的新索引。
 */
export function pruneUnsupportedSourceSongs(songs, currentIndex = -1) {
    const list = Array.isArray(songs) ? songs : [];
    const keepFlags = list.map((song) => isSupportedSongSource(song));
    const removed = keepFlags.reduce((count, keep) => count + (keep ? 0 : 1), 0);
    if (removed === 0) {
        return { songs: list, removed: 0, currentIndex };
    }
    return {
        songs: list.filter((_, index) => keepFlags[index]),
        removed,
        currentIndex: remapIndexAfterPrune(currentIndex, keepFlags)
    };
}

export function preferHttpsUrl(url) {
    if (!url || typeof url !== "string") return url;

    try {
        const parsedUrl = new URL(url, window.location.href);
        if (parsedUrl.protocol === "http:" && window.location.protocol === "https:") {
            parsedUrl.protocol = "https:";
            return parsedUrl.toString();
        }
        return parsedUrl.toString();
    } catch (error) {
        if (window.location.protocol === "https:" && url.startsWith("http://")) {
            return "https://" + url.substring("http://".length);
        }
        return url;
    }
}

export function toAbsoluteUrl(url) {
    if (!url) {
        return "";
    }

    try {
        const absolute = new URL(url, window.location.href);
        return absolute.href;
    } catch (_) {
        return url;
    }
}

export function buildAudioProxyUrl(url) {
    if (!url || typeof url !== "string") return url;

    try {
        const parsedUrl = new URL(url, window.location.href);
        if (parsedUrl.protocol === "https:") {
            return parsedUrl.toString();
        }

        if (parsedUrl.protocol === "http:" && /(^|\.)kuwo\.cn$/i.test(parsedUrl.hostname)) {
            return `${API.baseUrl}?target=${encodeURIComponent(parsedUrl.toString())}`;
        }

        return parsedUrl.toString();
    } catch (error) {
        console.warn("无法解析音频地址，跳过代理", error);
        return url;
    }
}
