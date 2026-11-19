# Windows setup and troubleshooting

## Check the prerequisites

Run these commands from PowerShell in the extracted project folder. The final command checks Node without starting a listener.

```powershell
Get-Command codex.exe, pythonw.exe
codex.exe --version
node --version
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -CheckOnly
```

Use a native Codex executable and a signed-in Codex desktop session. If your installation exposes only a shell shim, put the directory containing the native executable on PATH and reopen PowerShell. Python’s Windows installation must include its GUI executable for silent start and restart.

## Pair and verify

Run **Setup.cmd** and open its private local URL. Setup checks the token against the bot username and checks for an existing webhook. Use a dedicated bot with one polling listener. Keep the setup window open until you have used the pairing link. If the link has yet to appear, choose **Refresh connection status**.

In the paired private chat, send **/menu**. With **Auto** selected, try “What is 17 plus 24?” Then open a project update, tap **Open & reply**, and ask a read-only question about the project. **Home** cancels a pending reply before you send it.

## Enable desktop activity and Inbox alerts

Project discussions can run through the local app-server. Reading live desktop activity and forwarding a reply to an existing desktop chat also require the Codex app-tools connection. To install the optional lifecycle hooks after setup, run:

```powershell
node scripts/install-hooks.mjs
```

Review and trust the added hooks in Codex. Start a normal desktop turn so a hook can record the local connection, then check **/connection** in Telegram. Hook events carry activity metadata. The listener separately reads relevant chat content for routing and notifications. To remove this installation’s hooks, run `node scripts/install-hooks.mjs --remove` while the installation folder is still present.

## Start automatically

After pairing, run this command if you want the listener to start when Codex is open:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
```

The Windows scheduled task runs under the current signed-in user. **Stop.cmd** pauses automatic startup until **Start.cmd** is run. To remove the task, use `scripts\uninstall-startup.ps1`.

## Common issues

| Symptom | What to check |
| --- | --- |
| Setup cannot find Codex or Node | Run the prerequisite checks in a new PowerShell window. Node must be version 24 or newer. |
| Telegram commands receive no reply | Check the PC is awake, start the listener, and use the paired account’s private chat. Another listener or a webhook on the same bot can prevent delivery. |
| Home works but desktop activity is unavailable | Open Codex, verify its bundled app-tools adapter is available, and check the hook setup above. Use **/connection** to check the last scan. |
| A task is marked uncertain after a disconnect | Inspect the original Codex conversation and **/status** before taking action. A lost receipt can mean the work already started. |
| An audio note cannot be processed | Send text, a photo, or a supported image document. Voice notes are unsupported in this release. |

**Uninstall.** Run **Stop.cmd**, remove the optional task and hooks if installed, and wait for the listener to stop. The installation folder contains the local state. Keep it if you want to preserve the pairing and job history. You can revoke the token through BotFather.

[Back to the project page](../README.md)
