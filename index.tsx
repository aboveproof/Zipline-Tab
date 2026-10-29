/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import { definePluginSettings, PlainSettings, Settings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByCodeLazy, findComponentByCodeLazy } from "@webpack";
import { Menu, NavigationRouter, SelectedChannelStore, showToast, Toasts, Tooltip, useEffect, useState, useStateFromStores } from "@webpack/common";
import gradientIconBase64 from "file://./asset/zipline-gradient.png?base64";
import grayscaleIconBase64 from "file://./asset/zipline-grayscale.png?base64";
import type { ComponentType, MouseEvent, ReactElement, ReactNode } from "react";

import { ZiplinePicker } from "./ZiplinePicker";

const GRAYSCALE_ICON = `data:image/png;base64,${grayscaleIconBase64}`;
const GRADIENT_ICON = `data:image/png;base64,${gradientIconBase64}`;

function getZiplineIcon(iconType: string | undefined, customUrl: string | undefined): string {
    if (iconType === "gradient") return GRADIENT_ICON;
    if (iconType === "custom") {
        const trimmed = (customUrl ?? "").trim();
        if (trimmed !== "") return trimmed;
    }
    return GRAYSCALE_ICON;
}

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers["Zipline Tab"] as PluginNative<typeof import("./native")>
    : null;

const ZIPLINE_ROUTE = "/zipline";
const ZIPLINE_ITEM_ID = "zipline";
const cl = classNameFactory("vc-zipline-tab-");

const SETTINGS_KEYS: ("serviceUrl" | "ziplineToken")[] = ["serviceUrl", "ziplineToken"];
const PLACEMENT_SETTINGS_KEYS: ("tabPlacement")[] = ["tabPlacement"];
const ICON_SETTINGS_KEYS: ("iconType" | "customIconUrl")[] = ["iconType", "customIconUrl"];

const settings = definePluginSettings({
    serviceUrl: {
        type: OptionType.STRING,
        description: "Zipline server URL (e.g. https://zipline.example.com).",
        displayName: "Server URL",
        placeholder: "https://",
        default: "",
        isValid(value: string) {
            let trimmed = value.trim();
            if (trimmed === "") return true;
            if (!/^https?:\/\//i.test(trimmed)) {
                trimmed = `https://${trimmed}`;
            }
            try {
                const url = new URL(trimmed);
                if (url.protocol === "https:" || url.protocol === "http:") return true;
            } catch {}
            return "Use an http or https URL.";
        }
    },
    ziplineToken: {
        type: OptionType.STRING,
        description: "Zipline API authorization token.",
        displayName: "API Token",
        placeholder: "Token...",
        default: ""
    },
    folderId: {
        type: OptionType.STRING,
        description: "Optional folder ID for file uploads.",
        displayName: "Folder ID",
        placeholder: "Leave empty for root",
        default: ""
    },
    tabPlacement: {
        type: OptionType.SELECT,
        description: "Choose where the Zipline tab appears in Discord.",
        displayName: "Tab Placement",
        options: [
            { label: "Home Sidebar (Under Direct Messages)", value: "sidebar", default: true },
            { label: "Server List (Guild Bar)", value: "guilds" },
            { label: "Both Sidebar and Server List", value: "both" }
        ]
    },
    iconType: {
        type: OptionType.SELECT,
        description: "Select the tab icon appearance.",
        displayName: "Tab Icon Style",
        options: [
            { label: "Zipline Grayscale (Default)", value: "grayscale", default: true },
            { label: "Zipline Gradient", value: "gradient" },
            { label: "Custom Image URL", value: "custom" }
        ]
    },
    customIconUrl: {
        type: OptionType.STRING,
        description: "Direct image link (PNG, JPG, SVG, WebP) for the tab icon.",
        displayName: "Custom Icon URL",
        placeholder: "https://...",
        default: "",
        hidden() {
            return this.store.iconType !== "custom";
        },
        isValid(value: string) {
            if (this.store.iconType !== "custom") return true;
            const trimmed = value.trim();
            if (trimmed === "") return "Enter a valid image URL.";
            try {
                const url = new URL(trimmed);
                if (url.protocol === "https:" || url.protocol === "http:") return true;
            } catch {}
            return "Use an http or https image URL.";
        }
    },
    autoCopy: {
        type: OptionType.BOOLEAN,
        description: "Copy file URL to clipboard after upload.",
        displayName: "Copy Link on Upload",
        default: true
    }
});

interface FileUploadSettingsRecord {
    serviceUrl?: string;
    ziplineToken?: string;
    folderId?: string;
}

function getEffectiveConfig() {
    const fileUpload = (PlainSettings.plugins as Record<string, FileUploadSettingsRecord | undefined>)?.FileUpload;
    const current = settings.plain;

    const serviceUrl = current.serviceUrl?.trim() || fileUpload?.serviceUrl?.trim() || "";
    const ziplineToken = current.ziplineToken?.trim() || fileUpload?.ziplineToken?.trim() || "";
    const folderId = current.folderId?.trim() || fileUpload?.folderId?.trim() || "";

    return { serviceUrl, ziplineToken, folderId };
}

function pageUrl(value: string | undefined): string | null {
    let trimmed = (value ?? "").trim();
    if (trimmed === "") return null;
    if (!/^https?:\/\//i.test(trimmed)) {
        trimmed = `https://${trimmed}`;
    }
    try {
        const url = new URL(trimmed);
        if (url.protocol === "http:" && !url.hostname.includes("localhost") && url.hostname !== "127.0.0.1") {
            url.protocol = "https:";
        }
        if (url.pathname === "" || url.pathname === "/") {
            url.pathname = "/dashboard";
        }
        return url.href;
    } catch {
        return null;
    }
}

interface LinkIconProps {
    className?: string;
    size?: string;
    color?: string;
}

interface PrivateChannelLinkProps {
    selected: boolean;
    route: string;
    icon: (props: LinkIconProps) => ReactElement;
    text: string;
    className?: string;
    role?: "listitem";
    tabIndex?: number;
    onFocus?: () => void;
    "data-zipline-tab"?: string;
}

interface PrivateChannelListItem {
    role: "listitem";
    tabIndex: number;
    onFocus: () => void;
    [dataAttribute: `data-${string}`]: string;
}

const PrivateChannelLink = findComponentByCodeLazy<PrivateChannelLinkProps>(
    "nitroHoverGradient",
    "refresh_sm",
    "listItemRef"
);

const usePrivateChannelListItem: (id: string) => PrivateChannelListItem = findByCodeLazy(
    'role:"listitem"',
    "setFocus",
    "useState(-1)"
);

function ZiplineSidebarIcon({ className }: LinkIconProps) {
    const { iconType, customIconUrl } = settings.use(ICON_SETTINGS_KEYS);
    const src = getZiplineIcon(iconType, customIconUrl);

    return (
        <img
            alt=""
            aria-hidden="true"
            className={classes(className, cl("icon"))}
            draggable={false}
            height={20}
            src={src}
            width={20}
        />
    );
}

function ZiplineServerListIcon() {
    const { iconType, customIconUrl } = settings.use(ICON_SETTINGS_KEYS);
    const src = getZiplineIcon(iconType, customIconUrl);

    return (
        <img
            alt=""
            aria-hidden="true"
            className={cl("guild-icon")}
            draggable={false}
            height={24}
            src={src}
            width={24}
        />
    );
}

const ZiplinePage = ErrorBoundary.wrap(function ZiplinePage() {
    const { serviceUrl: currentUrl, ziplineToken: currentToken } = settings.use(SETTINGS_KEYS);
    const fileUpload = (Settings.plugins as Record<string, FileUploadSettingsRecord | undefined>)?.FileUpload;
    const effectiveUrl = currentUrl?.trim() || fileUpload?.serviceUrl?.trim() || "";
    const effectiveToken = currentToken?.trim() || fileUpload?.ziplineToken?.trim() || "";

    const src = pageUrl(effectiveUrl);
    const [loaded, setLoaded] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [titlePos, setTitlePos] = useState<{ left: number; top: number; } | null>(null);

    useEffect(() => {
        setLoaded(false);
        setTitlePos(null);
    }, [src, reloadKey]);

    useEffect(() => {
        if (Native && src !== null) {
            void Native.allowEmbed(src);
            if (effectiveToken) {
                void Native.setZiplineAuth(src, effectiveToken);
            }
        }
    }, [src, effectiveToken]);

    useEffect(() => {
        const handleMessage = (e: MessageEvent) => {
            if (e.data?.type === "VC_ZIPLINE_LOGIN_SUCCESS") {
                showToast("Logged in to Zipline.", Toasts.Type.SUCCESS);
            } else if (e.data?.type === "VC_ZIPLINE_TITLE_RECT" && typeof e.data.left === "number" && typeof e.data.top === "number") {
                setTitlePos({ left: e.data.left, top: e.data.top });
            }
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, []);

    const handleReload = () => {
        setLoaded(false);
        setTitlePos(null);
        setReloadKey(k => k + 1);
        if (Native && src !== null) {
            void Native.allowEmbed(src);
        }
    };

    if (src === null) {
        return (
            <div className={cl("page")}>
                <div className={cl("empty")}>
                    <h2>Zipline Not Configured</h2>
                    <p>Enter your Zipline server URL in plugin settings to view your dashboard here.</p>
                </div>
            </div>
        );
    }

    return (
        <div className={cl("page")}>
            <Tooltip text="Reload Zipline">
                {props => (
                    <button
                        {...props}
                        aria-label="Reload Zipline"
                        className={cl("reload")}
                        onClick={handleReload}
                        style={titlePos ? { left: `${titlePos.left}px`, top: `${titlePos.top}px` } : undefined}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            fill="none"
                            height="16"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            viewBox="0 0 24 24"
                            width="16"
                        >
                            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                        </svg>
                    </button>
                )}
            </Tooltip>
            {!loaded && (
                <div className={cl("loader")}>
                    <div className={cl("spinner")} />
                    <span className={cl("loader-text")}>Loading Zipline…</span>
                </div>
            )}
            <iframe
                key={reloadKey}
                allow="clipboard-read; clipboard-write; fullscreen; storage-access *"
                className={classes(cl("frame"), !loaded && cl("frame-hidden"))}
                onLoad={() => setLoaded(true)}
                src={src}
                title="Zipline Dashboard"
            />
        </div>
    );
}, { noop: true });

const GuildlessServerListItemComponent = findComponentByCodeLazy(
    "showPill:",
    '"string"==typeof ',
    "lowerBadgeSize:"
);
const ServerListItemPillComponent = findComponentByCodeLazy("=!1,hovered:", "=!1,unread:", "=!1,disabled:");

const ZiplineGuildButton = ErrorBoundary.wrap(function ZiplineGuildButton() {
    const { tabPlacement } = settings.use(PLACEMENT_SETTINGS_KEYS);
    const isSelected = useStateFromStores(
        [SelectedChannelStore],
        () => window.location.pathname.startsWith(ZIPLINE_ROUTE)
    );
    const [hovered, setHovered] = useState(false);

    if (tabPlacement === "sidebar") return null;

    const icon = (
        <div className={cl("guild-icon-container")}>
            <ZiplineServerListIcon />
        </div>
    );

    return (
        <div className={cl("guild-item-container")}>
            <div className={cl("guild-item-pill")}>
                <ServerListItemPillComponent
                    unread={false}
                    selected={isSelected}
                    hovered={hovered}
                    className={classes(
                        cl("guild-pill"),
                        isSelected && "selected",
                        hovered && "hovered"
                    )}
                />
            </div>
            <div className={cl("guild-button-container")}>
                <GuildlessServerListItemComponent
                    icon={() => icon}
                    tooltip="Zipline"
                    showPill={false}
                    selected={isSelected}
                    className={cl("guild-button")}
                    onClick={(e: MouseEvent<Element>) => {
                        e.preventDefault();
                        e.stopPropagation();
                        NavigationRouter.transitionTo(ZIPLINE_ROUTE);
                    }}
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                />
            </div>
        </div>
    );
}, { noop: true });

const ZiplineTab = ErrorBoundary.wrap(function ZiplineTab() {
    const { tabPlacement } = settings.use(PLACEMENT_SETTINGS_KEYS);
    if (tabPlacement === "guilds") return null;

    const listItem = usePrivateChannelListItem(ZIPLINE_ITEM_ID);
    const isSelected = useStateFromStores(
        [SelectedChannelStore],
        () => window.location.pathname.startsWith(ZIPLINE_ROUTE)
    );

    return (
        <PrivateChannelLink
            {...listItem}
            data-zipline-tab="true"
            icon={ZiplineSidebarIcon}
            route={ZIPLINE_ROUTE}
            selected={isSelected}
            text="Zipline"
        />
    );
}, { noop: true });

function getMediaSource(props: Record<string, unknown> | undefined): string | null {
    if (!props) return null;

    for (const key of ["src", "itemSrc", "itemHref", "url", "href"]) {
        const val = props[key];
        if (typeof val === "string" && /^https?:\/\//i.test(val)) return val;
    }

    const attachment = props.attachment as { proxy_url?: string; url?: string; } | undefined;
    if (attachment) {
        const url = attachment.proxy_url || attachment.url;
        if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
    }

    const target = props.target as {
        classList?: { contains: (cls: string) => boolean; };
        src?: unknown;
        closest?: (selector: string) => { src?: unknown; currentSrc?: unknown; } | null;
        querySelector?: (selector: string) => { src?: unknown; currentSrc?: unknown; } | null;
    } | undefined;

    if (target?.classList?.contains("emoji")) return null;

    if (typeof target?.src === "string" && /^https?:\/\//i.test(target.src)) {
        return target.src;
    }

    const mediaEl = target?.closest?.("img, video") || target?.querySelector?.("img, video");
    const mediaSrc = mediaEl?.currentSrc || mediaEl?.src;
    if (typeof mediaSrc === "string" && /^https?:\/\//i.test(mediaSrc)) {
        return mediaSrc;
    }

    const message = props.message as {
        attachments?: Array<{ proxy_url?: string; url?: string; }>;
        embeds?: Array<{
            video?: { proxyURL?: string; url?: string; };
            image?: { proxyURL?: string; url?: string; };
            thumbnail?: { proxyURL?: string; url?: string; };
        }>;
    } | undefined;

    if (message) {
        if (Array.isArray(message.attachments) && message.attachments.length > 0) {
            const first = message.attachments[0];
            const url = first?.proxy_url || first?.url;
            if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
        }

        if (Array.isArray(message.embeds)) {
            for (const embed of message.embeds) {
                const img = embed.image || embed.thumbnail;
                const { video } = embed;
                const url = img?.proxyURL || img?.url || video?.proxyURL || video?.url;
                if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
            }
        }
    }

    return null;
}

async function uploadToZipline(sourceUrl: string) {
    const { serviceUrl, ziplineToken, folderId } = getEffectiveConfig();
    const { autoCopy } = settings.store;

    if (!serviceUrl || !ziplineToken) {
        showToast("Configure Zipline Server URL and API Token in settings first.", Toasts.Type.FAILURE);
        return;
    }

    if (!Native?.uploadToZipline) {
        showToast("Zipline native helper not available on this platform.", Toasts.Type.FAILURE);
        return;
    }

    showToast("Uploading to Zipline...", Toasts.Type.MESSAGE);

    try {
        const res = await Native.uploadToZipline(sourceUrl, serviceUrl, ziplineToken, folderId);
        if (res.success && res.url) {
            if (autoCopy) {
                await copyToClipboard(res.url);
                showToast("Uploaded to Zipline. Link copied to clipboard.", Toasts.Type.SUCCESS);
            } else {
                showToast("Uploaded to Zipline.", Toasts.Type.SUCCESS);
            }
        } else {
            showToast(res.error || "Upload to Zipline failed.", Toasts.Type.FAILURE);
        }
    } catch (error) {
        showToast(error instanceof Error ? error.message : "Upload to Zipline failed.", Toasts.Type.FAILURE);
    }
}

const uploadContextMenuPatch: NavContextMenuPatchCallback = (children, props?: Record<string, unknown>) => {
    const source = getMediaSource(props);
    if (!source) return;

    if (children.some(child => child?.props?.id === "zipline-upload")) return;

    children.push(
        <Menu.MenuItem
            id="zipline-upload"
            key="zipline-upload"
            label="Upload to Zipline"
            action={() => void uploadToZipline(source)}
        />
    );
};

export default definePlugin({
    name: "Zipline Tab",
    description: "Adds an embedded Zipline web dashboard tab and context menu file uploads.",
    authors: [Devs.rico],
    dependencies: ["ServerListAPI", "ContextMenuAPI"],
    settings,
    contextMenus: {
        "gif-picker": uploadContextMenuPatch,
        "image-context": uploadContextMenuPatch,
        "message": uploadContextMenuPatch,
        "attachment-link-context": uploadContextMenuPatch,
    },

    renderGuildButton: ErrorBoundary.wrap(ZiplineGuildButton, { noop: true }),

    start() {
        const { serviceUrl, ziplineToken } = getEffectiveConfig();
        const src = pageUrl(serviceUrl);
        if (Native && src !== null) {
            void Native.allowEmbed(src);
            if (ziplineToken) {
                void Native.setZiplineAuth(src, ziplineToken);
            }
        }
        if (Native && settings.plain.iconType === "custom" && settings.plain.customIconUrl) {
            void Native.allowEmbed(settings.plain.customIconUrl);
        }
        addServerListElement(ServerListRenderPosition.Above, this.renderGuildButton);
    },

    stop() {
        removeServerListElement(ServerListRenderPosition.Above, this.renderGuildButton);
    },

    patches: [
        {
            find: '"section-divider-top"',
            replacement: {
                match: /\(0,\i\.jsx\)\(\i,\{\},"section-divider-top"\)/,
                replace: "$self.renderExtraTab(),$&"
            }
        },
        {
            find: ".QUEST_HOME,render:",
            replacement: {
                match: /\(0,(\i)\.jsx\)\((\i\.\i),\{path:\i\.\i\.QUEST_HOME,render:\i,impressionName:\i\.ImpressionNames\.QUEST_HOME,disableTrack:!0\}\)/,
                replace: '$&,(0,$1.jsx)($2,{path:"/zipline",render:$self.renderPage})'
            }
        },
        {
            find: "isChatRoute:!0",
            replacement: {
                match: /\i\.\i\.FAMILY_CENTER\],render:(\i),isChatRoute:!0\}/,
                replace: '$&,{path:["/zipline"],render:$1}'
            }
        },
        {
            find: "#{intl::EXPRESSION_PICKER_CATEGORIES_A11Y_LABEL}",
            replacement: [
                {
                    match: /(children:\[[^[\]]{0,300},)(?=\i&&\i&&\(0,\i\.jsx\)\((\i),\{id:\i\.\i,"aria-controls":\i\.\i,"aria-selected":(\i)===\i\.\i\.SOUNDBOARD)/,
                    replace: "$1$self.renderZiplineTab($2,$3),"
                },
                {
                    match: /(\i)===\i\.\i\.GIF&&\i\?\(0,\i\.jsx\)\(\i(?:\.\i)?,\{onSelectGIF:(\i),hideFavorites:\i,persistSearch:!0\}\):null,/,
                    replace: '$&$1==="zipline"?$self.renderZiplinePicker($2):null,'
                }
            ]
        }
    ],

    renderExtraTab() {
        return <ZiplineTab />;
    },

    renderPage() {
        return <ZiplinePage />;
    },

    renderZiplineTab(Tab: ComponentType<ExpressionPickerTabProps>, activeView: string) {
        return (
            <Tab
                aria-controls="zipline-picker-tab-panel"
                aria-selected={activeView === "zipline"}
                id="zipline-picker-tab"
                isActive={activeView === "zipline"}
                key="zipline-picker-tab"
                viewType="zipline"
            >
                Zipline
            </Tab>
        );
    },

    renderZiplinePicker(onSelectGIF: (item: { url: string; }) => void) {
        const { serviceUrl, ziplineToken } = getEffectiveConfig();
        return <ZiplinePicker onSelectItem={onSelectGIF} serviceUrl={serviceUrl} token={ziplineToken} />;
    }
});

interface ExpressionPickerTabProps {
    id?: string;
    key?: string;
    "aria-controls"?: string;
    "aria-selected"?: boolean;
    isActive?: boolean;
    viewType: string;
    children?: ReactNode;
}
