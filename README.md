# Zipline Tab

An Equicord plugin that embeds your [Zipline](https://zipline.diced.sh) dashboard into Discord and adds an interactive media browser to the Expression Picker.

## Features

- **Embedded Dashboard**: Access your full Zipline dashboard directly inside Discord with cookie synchronization and automatic authentication.
- **Expression Picker Tab**: Browse your uploaded images, videos, and files directly from Discord's emoji and GIF popout. Click any file to send its direct link into the active chat channel.
- **Infinite Scroll**: Scroll through your entire file library with automatic background pagination.
- **Video Preview**: Hover over video tiles to play them muted in a loop.
- **Minimal Scrollbars**: Slim, unobtrusive scrollbars matching Discord's dark client styling.
- **Direct Context Menu Uploads**: Right-click messages, images, and attachments to upload media directly to your Zipline instance.
- **Flexible Tab Placement**: Display the dashboard shortcut in the DM sidebar, the server list, or both.
- **Custom Tab Icons**: Choose between grayscale, gradient, or a custom image URL for the tab icon.

## Installation

Clone this repository into your Equicord `src/userplugins` directory:

```bash
cd src/userplugins
git clone https://github.com/aboveproof/Zipline-Tab.git ZiplineTab
```

Rebuild Equicord:

```bash
pnpm build
```

Restart Discord.

## Configuration

Open Discord Settings, navigate to **Plugins**, and locate **Zipline Tab**:

| Setting | Description |
| --- | --- |
| **Server URL** | Your Zipline instance URL (e.g. `https://zipline.example.com`). |
| **API Token** | Your Zipline user authorization token from your dashboard account settings. |
| **Folder ID** | Optional folder ID for file uploads. Leave blank for root. |
| **Tab Placement** | Choose where the tab icon appears: `Home Sidebar`, `Server List`, or `Both`. |
| **Tab Icon Style** | Select `Zipline Grayscale`, `Zipline Gradient`, or `Custom Image URL`. |
| **Copy Link on Upload** | Copy the generated file link to your clipboard upon upload. |

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) for details.
