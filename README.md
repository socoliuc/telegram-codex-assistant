# Telegram Codex Assistant

Use a private Telegram chat to see which Codex tasks need you, reply to the right project, and check on work running on your Windows PC.

![Example conversation. A heading request goes to the Atlas project. The next question goes to General through Auto.](docs/reply-routing.svg)

[Get started](#get-started-on-windows) · [Learn the controls](#the-controls) · [Setup and troubleshooting](docs/setup.md) · [MIT license](LICENSE)

## A minute with the bot

1. **Open Home.** The Inbox shows questions, approvals, and failures that need attention. Updates holds completed work.
2. **Open a project update.** Tap **Open & reply** and type a follow-up. The bot sends that message to the conversation that produced the update.
3. **Change the subject.** With **Auto** selected, the next plain message is routed again. A clear project request goes to that project, an ordinary question goes to General, and an ambiguous task opens a picker before work starts. Tap **Home** to cancel a reply you have yet to send.

## Get started on Windows

You need the Codex desktop app signed in, a native `codex.exe` on PATH, Node.js 24 or newer, and Python 3 with `pythonw.exe` for background startup. Keep the PC awake and online while using the bot. The listener has no npm dependencies.

1. Download and extract the Windows source ZIP from the **Releases** sidebar, or clone this repository.
2. In Telegram, create a dedicated bot with the verified **@BotFather** and keep its token private. [Open BotFather](https://t.me/BotFather)
3. Run **Setup.cmd**, then open the local URL printed in its window. Enter the bot username and token there.
4. Follow the pairing link on that page, press **Start** in your private bot chat, then send **/menu**. The first account to redeem the private pairing link becomes the owner.

Setup starts the listener. Use **Start.cmd** and **Stop.cmd** on subsequent runs. Desktop notifications and automatic startup have separate setup steps. [Installation guide](docs/setup.md)

## The controls

| Control | What it does |
| --- | --- |
| **Home** · `/menu` | Shows the current destination and cancels a pending one-message reply. |
| **Inbox** · `/inbox` | Opens requests that need attention. Choose an offered answer or open a task to reply. |
| **Switch project** · `/projects` | Pins a project for new messages. Select **Auto** to route each new message independently. |
| **Running** · `/status` | Lists current desktop activity and work requested through Telegram. |
| **Updates** · `/updates` | Opens recent results. **Mark reviewed** clears that item from the list. |
| **Open & reply** | Sends your next plain message to that card’s conversation. An explicit Telegram reply targets the message you quoted. |
| **Connection** · `/connection` | Shows listener health, project discovery, and the freshness of the desktop connection. |

## Where your messages go

The listener runs on your PC. It receives messages through the Telegram Bot API using long polling and sends project work to the local Codex app-server using your existing Codex sign-in. It needs an outbound connection to Telegram and Codex. Setup binds only to loopback and needs no public webhook or port forwarding.

Telegram and your configured Codex service process the messages you send. Bot chats are Telegram cloud chats. Local runtime data lives in the ignored `.local/` directory, including chat references, job state and downloads. The bot token is protected by Windows DPAPI under the Windows account that ran setup. Keep the pairing link, configuration, state, and logs private.

Fresh installations use a read-only coordinator and project workers with workspace-write access and on-request approvals. An explicit reply to a desktop task goes to that existing Codex chat, with its own permissions. Review a task’s project and requested action before approving it.

## Compatibility and development

This independent Windows companion uses the Codex CLI app-server. Desktop Inbox integration also uses the app-tools adapter bundled with the Codex desktop app. Those interfaces can change with Codex releases. The original installation was tested with Codex CLI **0.169.1**.

```powershell
node --test
python -B test/silent-launcher.test.py
```

The Windows suite exercises message routing, reply cancellation, project selection, credentials, recovery and background launch. Tests use isolated fixtures. [MIT license](LICENSE)
