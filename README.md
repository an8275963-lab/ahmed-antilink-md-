# AHMED ANTI-LINK MD BOT

WhatsApp Web multi-device bot using Baileys, with a QR panel and group anti-link commands.

## Features
- QR code panel at `/` and health endpoint at `/health`
- Detects common WhatsApp, Telegram, TikTok, YouTube, Instagram, Facebook and Discord links
- `.menu`, `.ping`, `.antilink on/off`, `.welcome on/off`, `.antitag on/off`, `.groupinfo`, `.tagall`
- Saves settings to `settings.json`
- Render Blueprint included with persistent disk for WhatsApp auth

## Important limitations
- The bot must be a **group admin** to delete other members' messages.
- WhatsApp/Baileys is an unofficial WhatsApp Web integration; changes to WhatsApp may break it or require re-pairing.
- Hosting providers can change free-tier policies. A free instance may sleep or not include persistent storage; the included Render config requests a persistent disk, which may require a paid plan depending on current Render policy.
- QR page has no login protection. Do not publish/share its address widely; pair the bot and then keep the URL private.
- `welcome` is a setting placeholder in this starter version; welcome-message handling is not yet implemented.
- Link filtering uses common URL patterns and cannot guarantee catching every obfuscated or shortened link.
- Do not use the bot to spam or violate group members' privacy.

## Deploy from an Android phone
1. Create a new repository on GitHub and upload the contents of this ZIP (extract it first).
2. In Render, choose **New → Blueprint** and connect the repository.
3. Review `render.yaml` and deploy. If Render says persistent disk is unavailable on your plan, select a plan that supports disks or use another host with persistent storage. Without persistent storage, the bot may ask for QR again after restarts.
4. Open the deployed service URL. Scan the QR from WhatsApp → Settings → Linked devices → Link a device.
5. Add the linked bot account to your group and promote it to admin.
6. Test `.ping`, `.menu`, and then ask an ordinary member to post a test link. Admins' own links are intentionally ignored.

## Diagnose errors
- Open Render service → **Logs**. Share the error text/screenshot (hide QR and session secrets).
- `Startup error`: usually dependency/network/runtime issue; inspect logs.
- QR never appears: check logs and whether the service is running.
- Link not deleted: verify the bot is a group admin and the message contains a recognizable URL.
- Repeated QR after restart: auth folder is not on persistent storage.
- If WhatsApp says logged out, clear the old auth files from persistent storage only when you are ready to pair again.
