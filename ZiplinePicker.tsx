/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { PluginNative } from "@utils/types";
import type { ScrollerBaseRef } from "@vencord/discord-types";
import { ExpressionPickerStore, ScrollerThin, showToast, Toasts, Tooltip, useCallback, useEffect, useMemo, useRef, useState } from "@webpack/common";
import type { MouseEvent } from "react";

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers["Zipline Tab"] as PluginNative<typeof import("./native")>
    : null;

const cl = classNameFactory("vc-zipline-tab-picker-");

export interface ZiplineFile {
    id: string;
    createdAt: string;
    name: string;
    originalName: string | null;
    size: number;
    type: string;
    url: string;
}

export interface ZiplinePickerProps {
    onSelectItem?: (item: { url: string; }) => void;
    serviceUrl: string;
    token: string;
}

function formatSize(bytes: number): string {
    if (bytes <= 0) return "0 B";
    const k = 1024;
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const val = (bytes / Math.pow(k, i)).toFixed(1);
    return `${val} ${units[i]}`;
}

function getRawUrl(serviceUrl: string, name: string): string {
    return `${serviceUrl.replace(/\/+$/, "")}/raw/${name}`;
}

function VideoItem({ src, name }: { src: string; name: string; }) {
    const videoRef = useRef<HTMLVideoElement>(null);

    const handleMouseEnter = () => {
        videoRef.current?.play().catch(() => {});
    };

    const handleMouseLeave = () => {
        if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.currentTime = 0;
        }
    };

    return (
        <video
            ref={videoRef}
            className={cl("media")}
            loop
            muted
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            playsInline
            preload="metadata"
            src={src}
            title={name}
        />
    );
}

function FileTile({
    file,
    serviceUrl,
    onSelect
}: {
    file: ZiplineFile;
    serviceUrl: string;
    onSelect: (file: ZiplineFile) => void;
}) {
    const rawUrl = getRawUrl(serviceUrl, file.name);
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");

    const handleCopy = (e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        e.preventDefault();
        void copyToClipboard(rawUrl);
        showToast("Zipline link copied to clipboard.", Toasts.Type.SUCCESS);
    };

    const renderContent = () => {
        if (isImage) {
            return (
                <img
                    alt={file.name}
                    className={cl("media")}
                    loading="lazy"
                    src={rawUrl}
                />
            );
        }
        if (isVideo) {
            return <VideoItem name={file.name} src={rawUrl} />;
        }
        if (isAudio) {
            return (
                <div className={cl("file-card")}>
                    <svg fill="currentColor" height={28} viewBox="0 0 24 24" width={28}>
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                    </svg>
                    <span className={cl("card-ext")}>AUDIO</span>
                </div>
            );
        }
        const ext = file.name.includes(".") ? file.name.split(".").pop()?.toUpperCase() : "FILE";
        return (
            <div className={cl("file-card")}>
                <svg fill="currentColor" height={28} viewBox="0 0 24 24" width={28}>
                    <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
                </svg>
                <span className={cl("card-ext")}>{ext}</span>
            </div>
        );
    };

    return (
        <div
            className={cl("item")}
            onClick={() => onSelect(file)}
            onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(file);
                }
            }}
            role="button"
            tabIndex={0}
        >
            {renderContent()}
            {isVideo && <span className={cl("badge")}>VIDEO</span>}
            <Tooltip text="Copy link">
                {tooltipProps => (
                    <button
                        {...tooltipProps}
                        aria-label="Copy link"
                        className={cl("copy-btn")}
                        onClick={handleCopy}
                        type="button"
                    >
                        <svg fill="none" height={14} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={14}>
                            <rect height={13} rx={2} ry={2} width={13} x={9} y={9} />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                    </button>
                )}
            </Tooltip>
            <div className={cl("overlay")}>
                <span className={cl("filename")}>{file.originalName || file.name}</span>
                <span className={cl("filesize")}>{formatSize(file.size)}</span>
            </div>
        </div>
    );
}

export const ZiplinePicker = ErrorBoundary.wrap(function ZiplinePicker({
    onSelectItem,
    serviceUrl,
    token
}: ZiplinePickerProps) {
    const [files, setFiles] = useState<ZiplineFile[]>([]);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [query, setQuery] = useState("");
    const fetchingRef = useRef(false);
    const scrollerRef = useRef<ScrollerBaseRef | null>(null);

    const loadFiles = useCallback(async (targetPage: number, reset = false) => {
        if (!serviceUrl || !token) return;
        if (fetchingRef.current) return;
        fetchingRef.current = true;

        if (reset) {
            setLoading(true);
        } else {
            setLoadingMore(true);
        }

        try {
            let data: { page?: ZiplineFile[]; pages?: number; total?: number; } | null = null;

            if (Native?.getZiplineFiles) {
                const res = await Native.getZiplineFiles(serviceUrl, token, targetPage);
                if (res.success && res.data) {
                    data = res.data as { page?: ZiplineFile[]; pages?: number; total?: number; };
                }
            }

            if (!data) {
                const cleanUrl = serviceUrl.replace(/\/+$/, "");
                const res = await fetch(`${cleanUrl}/api/user/files?page=${targetPage}`, {
                    headers: { Authorization: token.trim() }
                });
                if (res.ok) {
                    data = (await res.json()) as { page?: ZiplineFile[]; pages?: number; total?: number; };
                }
            }

            if (data && Array.isArray(data.page)) {
                const newFiles = data.page;
                setFiles(prev => {
                    if (reset) return newFiles;
                    const seen = new Set(prev.map(f => f.id));
                    const added = newFiles.filter(f => !seen.has(f.id));
                    return [...prev, ...added];
                });
                setPage(targetPage);
                setTotalPages(typeof data.pages === "number" ? data.pages : targetPage);
            }
        } catch {
            showToast("Failed to load Zipline files.", Toasts.Type.FAILURE);
        } finally {
            fetchingRef.current = false;
            setLoading(false);
            setLoadingMore(false);
        }
    }, [serviceUrl, token]);

    useEffect(() => {
        setFiles([]);
        setPage(1);
        setTotalPages(1);
        void loadFiles(1, true);
    }, [loadFiles]);

    const handleScroll = () => {
        const ref = scrollerRef.current;
        if (!ref) return;
        if (ref.getDistanceFromBottom() < 250) {
            if (!fetchingRef.current && page < totalPages) {
                void loadFiles(page + 1, false);
            }
        }
    };

    const handleSelect = (file: ZiplineFile) => {
        const rawUrl = getRawUrl(serviceUrl, file.name);
        if (typeof onSelectItem === "function") {
            try {
                onSelectItem({ url: rawUrl });
                ExpressionPickerStore.closeExpressionPicker();
                return;
            } catch {}
        }
        insertTextIntoChatInputBox(rawUrl);
        ExpressionPickerStore.closeExpressionPicker();
    };

    const filteredFiles = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return files;
        return files.filter(f =>
            f.name.toLowerCase().includes(q) ||
            (f.originalName !== null && f.originalName.toLowerCase().includes(q))
        );
    }, [files, query]);

    if (!serviceUrl || !token) {
        return (
            <div aria-labelledby="zipline-picker-tab" className={cl("container")} id="zipline-picker-tab-panel" role="tabpanel">
                <div className={cl("empty")}>
                    <h3>Zipline Not Configured</h3>
                    <p>Enter your Zipline server URL and API token in plugin settings to view your files.</p>
                </div>
            </div>
        );
    }

    return (
        <div aria-labelledby="zipline-picker-tab" className={cl("container")} id="zipline-picker-tab-panel" role="tabpanel">
            <div className={cl("header")}>
                <div className={cl("search")}>
                    <svg className={cl("search-icon")} fill="none" height={16} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={16}>
                        <circle cx={11} cy={11} r={8} />
                        <line x1={21} x2={16.65} y1={21} y2={16.65} />
                    </svg>
                    <input
                        autoFocus
                        className={cl("search-input")}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search Zipline files"
                        type="text"
                        value={query}
                    />
                    {query && (
                        <button
                            aria-label="Clear search"
                            className={cl("search-clear")}
                            onClick={() => setQuery("")}
                            type="button"
                        >
                            <svg fill="none" height={14} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={14}>
                                <line x1={18} x2={6} y1={6} y2={18} />
                                <line x1={6} x2={18} y1={6} y2={18} />
                            </svg>
                        </button>
                    )}
                </div>
                <Tooltip text="Refresh files">
                    {props => (
                        <button
                            {...props}
                            aria-label="Refresh files"
                            className={cl("refresh-btn")}
                            onClick={() => void loadFiles(1, true)}
                            type="button"
                        >
                            <svg fill="none" height={16} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={16}>
                                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                            </svg>
                        </button>
                    )}
                </Tooltip>
            </div>
            {loading ? (
                <div className={cl("loader-container")}>
                    <div className={cl("spinner")} />
                    <span>Loading files…</span>
                </div>
            ) : (
                <ScrollerThin className={cl("scroller")} onScroll={handleScroll} ref={scrollerRef}>
                    {filteredFiles.length === 0 ? (
                        <div className={cl("empty")}>
                            <h3>{query ? "No files match your search." : "No files found."}</h3>
                        </div>
                    ) : (
                        <div className={cl("grid")}>
                            {filteredFiles.map(file => (
                                <FileTile
                                    key={file.id}
                                    file={file}
                                    onSelect={handleSelect}
                                    serviceUrl={serviceUrl}
                                />
                            ))}
                            {loadingMore && (
                                <div className={cl("loading-more")}>
                                    <div className={cl("mini-spinner")} />
                                    <span>Loading more files…</span>
                                </div>
                            )}
                        </div>
                    )}
                </ScrollerThin>
            )}
        </div>
    );
}, { noop: true });
