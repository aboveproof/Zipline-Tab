/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addBeforeSendHeadersHook, addResponseHeaderHook, CspPolicies, CSPSrc } from "@main/csp";
import { RendererSettings } from "@main/settings";
import { app, BrowserWindow, IpcMainInvokeEvent, session, WebFrameMain } from "electron";

const MONTH_SECONDS = 60 * 60 * 24 * 30;
const embedHosts = new Set<string>();
const sessionCookies = new Map<string, string>();
const configuredTokens = new Map<string, string>();
let hooksRegistered = false;

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT = 30_000;

function hostOf(url: string): string {
    let clean = (url ?? "").trim();
    if (!clean) return "";
    if (!/^https?:\/\//i.test(clean)) {
        clean = `https://${clean}`;
    }
    try {
        const parsed = new URL(clean);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            return parsed.host.toLowerCase();
        }
    } catch {}
    return "";
}

function keepEmbedCookie(cookie: string, isHttps: boolean): string {
    let next = cookie.replace(/;\s*samesite=[^;]*/gi, "").replace(/;\s*partitioned\b/gi, "");
    if (isHttps) {
        if (!/;\s*secure\b/i.test(next)) next += "; Secure";
        next += "; SameSite=None; Partitioned";
    } else {
        next += "; SameSite=Lax";
    }
    if (!/(?:^|;)\s*(?:expires|max-age)=/i.test(next)) next += `; Max-Age=${MONTH_SECONDS}`;
    return next;
}

function allowEmbedDocument(headers: Record<string, string[]>) {
    for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (
            lower === "x-frame-options" ||
            lower === "cross-origin-opener-policy" ||
            lower === "cross-origin-resource-policy" ||
            lower === "content-security-policy-report-only"
        ) {
            delete headers[name];
            continue;
        }
        if (lower !== "content-security-policy") continue;
        headers[name] = headers[name]
            .map(policy => policy
                .split(";")
                .map(part => part.trim())
                .filter(part => part !== "" && !/^frame-ancestors\b/i.test(part))
                .join("; "))
            .filter(policy => policy !== "");
    }
}

function getInjectScript(token?: string): string {
    return `
(() => {
    if (window.__vcZiplinePatched) return;
    window.__vcZiplinePatched = true;

    const token = ${JSON.stringify(token ?? "")};
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
        window.fetch = async function(...args) {
            const init = args[1] || {};
            if (!init.credentials) {
                init.credentials = "include";
            }
            if (token) {
                let headers = init.headers;
                if (!headers) {
                    headers = { "Authorization": token };
                } else if (headers instanceof Headers) {
                    if (!headers.has("Authorization")) headers.set("Authorization", token);
                } else if (Array.isArray(headers)) {
                    if (!headers.some(([k]) => k.toLowerCase() === "authorization")) {
                        headers.push(["Authorization", token]);
                    }
                } else if (typeof headers === "object") {
                    const hasAuth = Object.keys(headers).some(k => k.toLowerCase() === "authorization");
                    if (!hasAuth) {
                        headers["Authorization"] = token;
                    }
                }
                init.headers = headers;
            }
            args[1] = init;
            const res = await origFetch.apply(this, args);
            try {
                const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
                if (url.includes("/api/auth/login") && res.ok) {
                    window.parent.postMessage({
                        type: "VC_ZIPLINE_LOGIN_SUCCESS",
                        host: window.location.host
                    }, "*");
                }
            } catch {}
            return res;
        };
    }

    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie") ||
                 Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "cookie");
    if (desc && desc.set) {
        const origSet = desc.set;
        Object.defineProperty(document, "cookie", {
            configurable: true,
            enumerable: true,
            get() {
                return desc.get.call(document);
            },
            set(val) {
                let str = String(val);
                let next = str.replace(/;\\s*samesite=[^;]*/gi, "").replace(/;\\s*partitioned\\b/gi, "");
                if (window.location.protocol === "https:") {
                    if (!/;\\s*secure\\b/i.test(next)) next += "; Secure";
                    next += "; SameSite=None; Partitioned";
                }
                return origSet.call(document, next);
            }
        });
    }

    const reportTitle = () => {
        try {
            const logo = document.querySelector('img[alt="Zipline logo"]');
            const header = document.querySelector("header");
            let titleEl = null;
            if (logo) {
                let sibling = logo.nextElementSibling;
                while (sibling) {
                    if (sibling.textContent && sibling.textContent.trim().length > 0 && sibling.style.marginLeft !== "auto") {
                        titleEl = sibling;
                        break;
                    }
                    sibling = sibling.nextElementSibling;
                }
            }
            if (!titleEl && header) {
                titleEl = header.querySelector('h1, h2, h3, [class*="Title"], [class*="Text"]');
            }
            if (titleEl) {
                const rect = titleEl.getBoundingClientRect();
                if (rect.width > 0 && rect.right > 0) {
                    window.parent.postMessage({
                        type: "VC_ZIPLINE_TITLE_RECT",
                        left: Math.round(rect.right + 12),
                        top: Math.round(rect.top + (rect.height - 28) / 2)
                    }, "*");
                }
            }
        } catch {}
    };

    const injectScrollbar = () => {
        try {
            if (document.getElementById("__vc-zipline-scrollbar")) return;
            const style = document.createElement("style");
            style.id = "__vc-zipline-scrollbar";
            style.textContent = "* { scrollbar-width: thin !important; scrollbar-color: rgba(255, 255, 255, 0.2) transparent !important; } ::-webkit-scrollbar { width: 4px !important; height: 4px !important; } ::-webkit-scrollbar-track { background: transparent !important; } ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2) !important; border-radius: 4px !important; } ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.4) !important; } ::-webkit-scrollbar-corner { background: transparent !important; }";
            (document.head || document.documentElement).appendChild(style);
        } catch {}
    };

    injectScrollbar();

    if (document.readyState === "complete" || document.readyState === "interactive") {
        setTimeout(reportTitle, 300);
        setTimeout(reportTitle, 1000);
    } else {
        window.addEventListener("DOMContentLoaded", () => {
            injectScrollbar();
            setTimeout(reportTitle, 300);
            setTimeout(reportTitle, 1000);
        });
    }
    window.addEventListener("resize", reportTitle);
    let titleTimer = null;
    const obs = new MutationObserver(() => {
        injectScrollbar();
        if (titleTimer) clearTimeout(titleTimer);
        titleTimer = setTimeout(reportTitle, 150);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
})();
`;
}

function injectFrame(frame: WebFrameMain) {
    try {
        const host = hostOf(frame.url);
        if (!host || !embedHosts.has(host)) return;
        const token = configuredTokens.get(host);
        void frame.executeJavaScript(getInjectScript(token)).catch(() => {});
    } catch {}
}

function attachWindow(win: BrowserWindow) {
    win.webContents.on("frame-created", (_, { frame }) => {
        if (!frame) return;
        frame.once("dom-ready", () => injectFrame(frame));
    });

    win.webContents.on("did-frame-finish-load", (_, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame) return;
        const frame = win.webContents.mainFrame?.frames?.find(
            f => f.processId === frameProcessId && f.routingId === frameRoutingId
        );
        if (frame) injectFrame(frame);
    });

    const frames = win.webContents.mainFrame?.frames ?? [];
    for (const frame of frames) {
        injectFrame(frame);
    }
}

function registerHooks() {
    if (hooksRegistered) return;
    hooksRegistered = true;

    addResponseHeaderHook(({ url, responseHeaders }) => {
        if (!responseHeaders) return;
        const host = hostOf(url);
        if (!embedHosts.has(host)) return;

        allowEmbedDocument(responseHeaders);

        const key = Object.keys(responseHeaders).find(name => name.toLowerCase() === "set-cookie");
        const rawCookies = key !== undefined ? responseHeaders[key] : undefined;
        const cookies = Array.isArray(rawCookies)
            ? rawCookies
            : typeof rawCookies === "string"
                ? [rawCookies]
                : [];

        if (key !== undefined && cookies.length > 0) {
            const isHttps = url.startsWith("https:");
            for (const cookie of cookies) {
                const match = /(?:^|;\s*)zipline_session=([^;]+)/i.exec(cookie);
                if (match && match[1]) {
                    let val = match[1].trim();
                    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
                    sessionCookies.set(host, val);
                    const domain = host.split(":")[0];
                    void session.defaultSession.cookies.set({
                        url: `${isHttps ? "https" : "http"}://${host}`,
                        name: "zipline_session",
                        value: val,
                        domain,
                        path: "/",
                        secure: isHttps,
                        httpOnly: true,
                        sameSite: isHttps ? "no_restriction" : "lax"
                    }).catch(() => {});
                }
            }
            responseHeaders[key] = cookies.map(c => keepEmbedCookie(c, isHttps));
        }

        if (url.includes("/api/auth/logout")) {
            sessionCookies.delete(host);
            void session.defaultSession.cookies.remove(`${url.startsWith("https:") ? "https" : "http"}://${host}`, "zipline_session").catch(() => {});
        }
    });

    addBeforeSendHeadersHook(({ url, requestHeaders }) => {
        const host = hostOf(url);
        if (!embedHosts.has(host)) return;

        const sessionVal = sessionCookies.get(host);
        if (sessionVal) {
            const cookieKey = Object.keys(requestHeaders).find(k => k.toLowerCase() === "cookie") ?? "Cookie";
            const currentCookie = requestHeaders[cookieKey] ?? "";
            if (!currentCookie.includes("zipline_session=")) {
                requestHeaders[cookieKey] = currentCookie
                    ? `${currentCookie}; zipline_session=${sessionVal}`
                    : `zipline_session=${sessionVal}`;
                for (const k of Object.keys(requestHeaders)) {
                    if (k.toLowerCase() === "cookie" && k !== cookieKey) {
                        delete requestHeaders[k];
                    }
                }
            }
        }

        const isLoginEndpoint = url.includes("/api/auth/login") || url.includes("/api/auth/register");
        const token = configuredTokens.get(host);
        if (token && !isLoginEndpoint) {
            const authKey = Object.keys(requestHeaders).find(k => k.toLowerCase() === "authorization") ?? "Authorization";
            if (!requestHeaders[authKey]?.trim()) {
                requestHeaders[authKey] = token;
            }
        }
    });

    app.on("browser-window-created", (_, win) => attachWindow(win));
    for (const win of BrowserWindow.getAllWindows()) {
        attachWindow(win);
    }
}

interface PluginSettingsConfig {
    serviceUrl?: string;
    ziplineToken?: string;
}

function initFromSettings() {
    try {
        const plugins = RendererSettings.store.plugins as Record<string, PluginSettingsConfig> | undefined;
        const ziplineSettings = plugins?.["Zipline Tab"] ?? plugins?.ZiplineTab;
        const fileUploadSettings = plugins?.FileUpload;

        const serviceUrl = ziplineSettings?.serviceUrl?.trim() || fileUploadSettings?.serviceUrl?.trim();
        const token = ziplineSettings?.ziplineToken?.trim() || fileUploadSettings?.ziplineToken?.trim();

        if (serviceUrl) {
            const host = hostOf(serviceUrl);
            if (host) {
                embedHosts.add(host);
                CspPolicies[host] = CSPSrc;
                if (token) {
                    configuredTokens.set(host, token);
                }
                registerHooks();
            }
        }
    } catch {}
}

initFromSettings();
try {
    RendererSettings.addChangeListener("plugins.Zipline Tab.*" as any, () => initFromSettings());
    RendererSettings.addChangeListener("plugins.FileUpload.*" as any, () => initFromSettings());
} catch {}

export async function allowEmbed(_event: IpcMainInvokeEvent, targetUrl: unknown) {
    if (typeof targetUrl !== "string") return;
    const host = hostOf(targetUrl);
    if (!host) return;

    embedHosts.add(host);
    CspPolicies[host] = CSPSrc;
    registerHooks();

    try {
        const isHttps = targetUrl.startsWith("https:");
        const cookies = await session.defaultSession.cookies.get({
            url: `${isHttps ? "https" : "http"}://${host}`,
            name: "zipline_session"
        });
        if (cookies.length > 0 && cookies[0]?.value) {
            sessionCookies.set(host, cookies[0].value);
        }
    } catch {}

    try {
        session.defaultSession.preconnect({ url: targetUrl, numSockets: 2 });
    } catch {}

    for (const win of BrowserWindow.getAllWindows()) {
        const frames = win.webContents.mainFrame?.frames ?? [];
        for (const frame of frames) {
            injectFrame(frame);
        }
    }
}

export function setZiplineAuth(_event: IpcMainInvokeEvent, serviceUrl: unknown, token: unknown) {
    if (typeof serviceUrl !== "string" || typeof token !== "string") return;
    const host = hostOf(serviceUrl);
    if (!host) return;

    embedHosts.add(host);
    CspPolicies[host] = CSPSrc;
    configuredTokens.set(host, token.trim());
    registerHooks();
}

export async function clearSession(_event: IpcMainInvokeEvent, serviceUrl: unknown) {
    if (typeof serviceUrl !== "string") return;
    const host = hostOf(serviceUrl);
    if (!host) return;
    sessionCookies.delete(host);
    try {
        await session.defaultSession.cookies.remove(`https://${host}`, "zipline_session");
    } catch {}
}

function parseMediaUrl(value: string): URL {
    if (typeof value !== "string" || value.length > 8192) {
        throw new Error("Invalid media URL");
    }

    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
        throw new Error("Only HTTP or HTTPS media links can be uploaded");
    }
    return url;
}

async function fetchMedia(url: URL): Promise<{ response: Response; url: URL; }> {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await fetch(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
        if (response.status < 300 || response.status >= 400) return { response, url };

        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) {
            throw new Error("Media host redirected too many times");
        }

        await response.body?.cancel();
        url = parseMediaUrl(new URL(location, url).href);
    }

    throw new Error("Media host redirected too many times");
}

async function readMedia(response: Response): Promise<Uint8Array> {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES) {
        await response.body?.cancel();
        throw new Error("File exceeds 50 MiB limit");
    }
    if (!response.body) throw new Error("Media host returned empty response");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        size += value.byteLength;
        if (size > MAX_MEDIA_BYTES) {
            await reader.cancel();
            throw new Error("File exceeds 50 MiB limit");
        }
        chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function getFileName(url: URL): string {
    const encodedName = url.pathname.split("/").pop() || "upload.png";
    try {
        return decodeURIComponent(encodedName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    } catch {
        return encodedName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    }
}

export async function uploadToZipline(
    _event: IpcMainInvokeEvent,
    sourceUrl: string,
    serviceUrl: string,
    token: string,
    folderId?: string
): Promise<{ success: boolean; url?: string; error?: string; }> {
    try {
        if (!serviceUrl || !token) {
            return { success: false, error: "Zipline Server URL and API Token are required" };
        }

        const cleanServiceUrl = serviceUrl.replace(/\/+$/, "");
        const parsedSource = parseMediaUrl(sourceUrl);
        const { response, url: finalSourceUrl } = await fetchMedia(parsedSource);

        if (!response.ok) {
            return { success: false, error: `Failed to download source media (HTTP ${response.status})` };
        }

        const bytes = await readMedia(response);
        let fileName = getFileName(finalSourceUrl);
        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";

        if (!/\.[a-zA-Z0-9]{2,5}$/i.test(fileName)) {
            if (contentType === "image/gif") fileName += ".gif";
            else if (contentType === "image/png") fileName += ".png";
            else if (contentType === "image/jpeg") fileName += ".jpg";
            else if (contentType === "image/webp") fileName += ".webp";
        }

        const formData = new FormData();
        formData.append("file", new File([bytes.buffer as ArrayBuffer], fileName, { type: contentType }));

        const headers: Record<string, string> = {
            "Authorization": token.trim()
        };
        if (folderId?.trim()) {
            headers["x-zipline-folder"] = folderId.trim();
        }

        const uploadRes = await fetch(`${cleanServiceUrl}/api/upload`, {
            method: "POST",
            headers,
            body: formData,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });

        if (!uploadRes.ok) {
            const errBody = await uploadRes.text().catch(() => "");
            return { success: false, error: `Zipline rejected upload: HTTP ${uploadRes.status} ${errBody}`.slice(0, 200) };
        }

        const data: unknown = await uploadRes.json().catch(() => null);
        if (typeof data === "object" && data !== null) {
            const resObj = data as { files?: unknown[]; url?: string; };
            if (Array.isArray(resObj.files) && resObj.files.length > 0) {
                const item = resObj.files[0];
                const resUrl = typeof item === "string" ? item : (item as { url?: string; })?.url;
                if (typeof resUrl === "string") return { success: true, url: resUrl };
            }
            if (typeof resObj.url === "string") return { success: true, url: resObj.url };
        }

        return { success: false, error: "Zipline response missing file URL" };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Upload to Zipline failed" };
    }
}

export async function getZiplineFiles(
    _event: IpcMainInvokeEvent,
    serviceUrl: unknown,
    token: unknown,
    page: unknown
): Promise<{ success: boolean; data?: unknown; error?: string; }> {
    try {
        if (typeof serviceUrl !== "string" || typeof token !== "string" || typeof page !== "number") {
            return { success: false, error: "Invalid parameters" };
        }
        const cleanUrl = serviceUrl.replace(/\/+$/, "");
        const res = await fetch(`${cleanUrl}/api/user/files?page=${page}`, {
            headers: { "Authorization": token.trim() },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });
        if (!res.ok) {
            return { success: false, error: `HTTP ${res.status}` };
        }
        const data = await res.json();
        return { success: true, data };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Failed to fetch files" };
    }
}

