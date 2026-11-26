# Telegram Codex Assistant

Use a private Telegram chat to send work to Codex on your Mac, Linux computer, or Windows PC. Pick up a project conversation from your phone and see when a task needs your attention.

![Example conversation. A heading request goes to the Atlas project. The next question goes to General through Auto.](docs/reply-routing.svg)

[Choose your download](#choose-your-download) · [Learn the controls](#the-controls) · [MIT license](LICENSE)

## A minute with the bot

1. **Open Home.** The Inbox shows questions, approvals, and failures that need attention. Updates holds completed work.
2. **Continue a chat.** Tap **Chats**, choose a project, and open a chat. Type below to continue it. Codex answers appear as Telegram replies to your messages.
3. **Change the subject.** With **Auto** selected, the next plain message is routed again. A clear project request goes to that project, an ordinary question goes to General, and an ambiguous task opens a picker before work starts. Tap **Home** to cancel a reply you have yet to send.

## Choose your download

Open the latest **Releases** entry on this repository and download the asset for the computer that runs Codex. Extract it to a folder you plan to keep. All editions require **Node.js 24 or newer**, a signed-in Codex CLI, and a computer that stays awake and online. The listener has no npm dependencies.

| Your computer | Release asset | Launch setup | Guide |
| --- | --- | --- | --- |
| macOS | `*-macos.tar.gz` | `./Setup.command` in Terminal | [Mac setup and Keychain](docs/macos-linux.md#macos) |
| Linux | `*-linux.tar.gz` | `./setup.sh` in a terminal | [Linux setup and keyring](docs/macos-linux.md#linux) |
| Windows | `*-windows.zip` | Double-click **Setup.cmd** | [Windows setup and background startup](docs/setup.md) |

1. In Telegram, create a dedicated bot with the verified **@BotFather**. [Open BotFather](https://t.me/BotFather)
2. Launch setup and open the local URL it prints. Enter the bot username and token on that page.
3. Open the private pairing link, press **Start** in Telegram, then send **/menu**. The first account to redeem the link becomes the owner.

On a CLI-only installation, add your project folders to give **Auto** destinations beyond General. [Register projects](docs/macos-linux.md#add-project-folders)

## The controls

| Control | What it does |
| --- | --- |
| **Home** · `/menu` | Shows the current destination and cancels a pending one-message reply. |
| **Chats** · `/chats` | Choose a project and tap a Codex chat to open it. Type to continue it, or tap **Back** or **Home** to leave. |
| **General** · `/general` | Switches Home to General for new messages. |
| **Clear chat** · `/clear_chat` | Clears recent Telegram messages from both sides, including Home. Use `/menu` to reopen Home when you want it. |
| **Inbox** · `/inbox` | Opens requests that need attention. Choose an offered answer or open a task to reply. |
| **Routing** · `/project` | Pins a project for new messages. Select **Auto** to route each new message independently. Find Routing under **More**. |
| **Running** · `/status` | Lists current desktop activity and work requested through Telegram. |
| **Updates** · `/updates` | Opens recent results. **Review & clear** dismisses an update and clears its recent Telegram copies. |
| **Open & reply** | Sends your next plain message to that card’s conversation. An explicit Telegram reply targets the message you quoted. |
| **Connection** · `/connection` | Shows listener health, project discovery, and the freshness of the desktop connection. |

**Review & clear** also removes recent attachments. Telegram keeps older copies and the bot removes their buttons. **Close** removes one bot panel or notice. **Clear chat** is on Home and in Telegram’s command menu. Telegram lets the bot clear messages it has seen from the last 48 hours. Use Telegram’s **Clear History** for anything left. Your Codex chats and Inbox tasks stay available.

## Where your messages go

The listener runs on your PC. It receives messages through the Telegram Bot API using long polling and sends project work to the local Codex app-server using your existing Codex sign-in. It needs an outbound connection to Telegram and Codex. Setup binds only to loopback and needs no public webhook or port forwarding.

Telegram and your configured Codex service process the messages you send. Bot chats are Telegram cloud chats. Local runtime data lives in the ignored `.local/` directory, including chat references, job state and downloads. The listener protects the bot token using macOS Keychain, Linux Secret Service, or Windows DPAPI. Keep the pairing link, configuration, state, and logs private.

Fresh installations use a read-only coordinator and project workers with workspace-write access and on-request approvals. An explicit reply to a desktop task goes to that existing Codex chat, with its own permissions. Review a task’s project and requested action before approving it.

## Compatibility and development

| Platform | Verified OS versions and architectures |
| --- | --- |
| Windows | Windows 11 x64 (26H2, live Telegram test) and Windows Server 2025 x64 (automated package tests) |
| macOS | macOS 15 Sequoia on Apple Silicon (arm64) and Intel (x64) |
| Linux | Ubuntu 26.04 LTS x64 with an unlocked Secret Service keyring |

This table records the environments verified for v0.2.0. Compatibility with older OS releases, other Linux distributions and additional architectures is unverified.


This independent companion uses the Codex CLI app-server. Auto routing, project selection, and replies to jobs started through Telegram work with the CLI. Reading a separate desktop chat or forwarding a reply to it also requires a compatible Codex desktop app-tools adapter. Windows includes optional automatic startup. The Mac and Linux guides cover manual start and stop.

```sh
node --test
```

Platform checks exercise the extracted release packages on Windows, macOS, and Linux. The Windows launcher suite also runs with `python -B test/silent-launcher.test.py`. The Mac and Linux checks connect to Codex CLI **0.169.1** in a fresh Codex home. [MIT license](LICENSE)
