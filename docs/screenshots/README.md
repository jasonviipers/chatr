# Screenshots

The pictures in the main [README](../../README.md) are taken from the running app, with made-up names (Alice Martin,
Bob Chen, Carla Rossi), a drawn "camera" picture and a drawn shared screen. There is no real person or data in them.

| File | What it shows |
| --- | --- |
| `01-home.png` … `03-join.png` | Home, host sign-in, joining with a meeting id |
| `04-install.png` … `08-privacy-editor.png` | First-run installation, administrator sign-in, creating and listing hosts, the privacy-policy editor |
| `09-meeting-voice.png` … `11-meeting-participants.jpg` | A voice meeting, the camera on, the row of participants |
| `14-chat.png` | The chat panel |
| `15-whiteboard.png` | The shared whiteboard |
| `20-mobile-home.png`, `22-mobile-chat.png` | The same app on a phone (390 × 844) |
| `30-desktop-app.png` | The desktop (Electron) app |

## Retaking them

The script also writes `12-menu-muted.png`, `13-menu-on.png`, `16-screen-share.jpg` and `21-mobile-meeting.png`, which the README does not use.

Use it after the screens change. It needs a **fresh** API (an empty database: the script installs the administrator
through the screen) and a browser that Playwright can drive.

1. Start the API on an empty database and the web app against it, for example on spare ports
   (`WEB_APP_HOST` for the API, `REACT_APP_API_HOST` / `REACT_APP_HOST` for the web app; plain http in development):

   ```bash
   cd api && PORT=8100 WEB_APP_HOST=localhost:3020 DATABASE_PATH=./data/screenshots.sqlite bun run dev
   cd app && REACT_APP_API_HOST=localhost:8100 REACT_APP_HOST=localhost:3020 bun x vite --port 3020 --strictPort
   ```

2. Install Playwright's driver where you run the script, then take the pictures:

   ```bash
   npm i --no-save playwright-core
   node docs/screenshots/take-screenshots.mjs http://localhost:3020 http://localhost:8100 docs/screenshots
   ```

   The script opens Microsoft Edge; set `BROWSER_CHANNEL=chrome` to use Chrome instead.

3. `30-desktop-app.png` comes from the Electron wrapper (`bun run desktop:serve` in `app/`, then a window grab of the
   meeting screen); the script does not take it.
