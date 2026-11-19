# Set up on macOS or Linux

These editions run the listener as your regular user. You can pair a Telegram bot and work in General or in registered project folders using the Codex CLI. Run setup on the computer where Codex and your projects live.

## macOS

1. Download the `-macos.tar.gz` asset from the latest release. Extract it in Finder and move the folder to a permanent, writable location.
2. In Terminal, open the extracted folder. Run `node --version` (24 or newer), `codex --version`, and `codex login status`. If the CLI needs an account, run `codex login`.
3. Run `./Setup.command` and open the local URL printed in Terminal. Setup stores the bot credential in your macOS Keychain. Use your normal logged-in account with its login keychain unlocked.
4. Enter the bot details on the setup page. Open the pairing link in Telegram, press **Start**, then send **/menu**.

Use `./Start.command` and `./Stop.command` for later sessions. Run them from the extracted folder. The listener continues after you close the terminal that launched it. Start it again after a reboot.

## Linux

1. Install Node.js 24 or newer and the Codex CLI, then check `node --version`, `codex --version`, and `codex login status`. Use `codex login` if needed.
2. Install the `secret-tool` utility and use a session with D-Bus and an unlocked Secret Service keyring. On Debian or Ubuntu, the utility comes from `libsecret-tools`. GNOME Keyring is one compatible provider. A headless SSH session needs access to that user’s unlocked service.
3. Download the `-linux.tar.gz` asset. Extract it under your home directory, change into the resulting folder, and run `./setup.sh`. Keep this installation in place.
4. Open the printed local URL on the same computer. Enter the bot details, open the pairing link in Telegram, press **Start**, and send **/menu**.

Use `./start.sh` and `./stop.sh` for later sessions. Start the listener again after logging in or rebooting. If Telegram stops responding, check that the machine is awake, that the keyring is unlocked, and that no other listener is polling the same bot.

## Add project folders

When setting up the bot, you can enter one project per line in **Project folders**. Use a name you will recognize in Telegram, a vertical bar, and the absolute path to an existing folder. For example, on Linux:

```text
Atlas | /home/you/projects/atlas
```

Use the actual path on your computer. On macOS it might start with `/Users/you/`. Compatible Codex desktop registrations are also discovered automatically. With Auto selected, an ambiguous project request opens the project picker before work starts.

To change folders later, stop the listener and edit only the `projects` property of `.local/config.json`. Each entry has a `name` and an absolute `root`. Start the listener and open **Switch project** to check the list.

## Check the connection

Send **/menu** and verify the destination shows **Auto**. A general question should go to General. A request naming a registered project should go to that project. In a CLI-only session, Telegram can follow jobs it starts. For an existing desktop chat, **/connection** reports whether a compatible desktop adapter is available.

Keep the installation folder, keyring, and Codex login together under the same user account. The installation path identifies its saved bot credential. If you move to another computer, use setup there and stop the previous listener before pairing the same bot. [Back to the project page](../README.md)
