# Getting Started

Step-by-step instructions to get the Wedding Album Selector running on your
own computer. It runs locally — nothing is uploaded anywhere, and once it's
running, only you can see it (it's not visible to anyone else on the internet).

Pick your operating system below.

---

## Windows

### 1. Install Node.js (one-time)

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** version.
2. Run the installer, clicking "Next" through the defaults.
3. Confirm it installed: open **PowerShell** (search for it in the Start
   menu) and type:
   ```
   node --version
   ```
   You should see something like `v22.11.0`. If you see an error instead,
   close and reopen PowerShell and try again (sometimes it needs a fresh
   window to pick up the new install).

### 2. Get the project files

If you were sent a **link to the GitHub repo**:
```
git clone https://github.com/AnuragKannepalli/WeddingAlbumViewer.git
cd WeddingAlbumViewer
```
(If `git` isn't installed, install it from [git-scm.com](https://git-scm.com)
first, or just download the repo as a ZIP from GitHub — click the green
"Code" button → "Download ZIP" — and unzip it instead.)

If you were sent a **ZIP file** directly: unzip it anywhere (e.g. your
Desktop), then open PowerShell and navigate into that folder:
```
cd Desktop\WeddingAlbumViewer
```
(adjust the path to wherever you unzipped it)

### 3. Install dependencies (one-time per copy)

Still in that folder in PowerShell:
```
npm install
```
This downloads everything the app needs. It needs an internet connection and
takes a minute or two. You'll see some text scroll by — that's normal.

### 4. Start the app

```
npm start
```
You should see:
```
Wedding Album Viewer running at http://localhost:4173
```
Leave this PowerShell window open — closing it stops the app.

### 5. Open it in your browser

Go to **http://localhost:4173** in Chrome, Edge, or Firefox.

### 6. Point it at your own photos

On the **Setup** tab, paste the full path to your own photo folder (e.g.
`C:\Users\YourName\Pictures\Wedding`) and click "Scan Folder". This is a
brand-new, empty album — separate from anyone else's.

---

## macOS (MacBook)

### 1. Install Node.js (one-time)

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** version
   (it'll detect you're on a Mac automatically).
2. Open the downloaded `.pkg` file and click through the installer.
3. Confirm it installed: open **Terminal** (Cmd+Space, type "Terminal",
   press Enter) and type:
   ```
   node --version
   ```
   You should see something like `v22.11.0`.

### 2. Get the project files

If you were sent a **link to the GitHub repo**:
```
git clone https://github.com/AnuragKannepalli/WeddingAlbumViewer.git
cd WeddingAlbumViewer
```
(macOS usually has `git` built in — if Terminal prompts you to install
developer tools the first time you run this, accept that prompt and try
again once it finishes. Or just download the repo as a ZIP from GitHub's
green "Code" button instead.)

If you were sent a **ZIP file** directly: unzip it (double-click it in
Finder), then in Terminal navigate into that folder:
```
cd ~/Downloads/WeddingAlbumViewer
```
(adjust the path to wherever you unzipped it — drag the folder into the
Terminal window after typing `cd ` to auto-fill its path)

### 3. Install dependencies (one-time per copy)

Still in that folder in Terminal:
```
npm install
```
Needs an internet connection, takes a minute or two.

### 4. Start the app

```
npm start
```
You should see:
```
Wedding Album Viewer running at http://localhost:4173
```
Leave this Terminal window open — closing it stops the app.

### 5. Open it in your browser

Go to **http://localhost:4173** in Safari, Chrome, or Firefox.

### 6. Point it at your own photos

On the **Setup** tab, paste the full path to your own photo folder (e.g.
`/Users/YourName/Pictures/Wedding`) and click "Scan Folder". This is a
brand-new, empty album — separate from anyone else's.

---

## Each time after the first

You don't need to repeat steps 1–3. Just:
1. Open PowerShell (Windows) or Terminal (Mac) in the project folder.
2. Run `npm start`.
3. Open `http://localhost:4173`.

Your album (photos, pages, layout) is saved automatically as you work and
will be there waiting for you next time.

## Connecting OneDrive (optional)

By default you add photos by pointing Setup at a folder already on this
computer, or by using "Add from my computer" / dragging files in from File
Explorer. If you'd rather browse and pick photos straight from OneDrive
without downloading them all first, you can connect your Microsoft account.
This is a one-time setup, takes about 5 minutes, and only you (using your
own Microsoft account) can do it.

**Why this step exists:** OneDrive's own website won't let you drag a photo
out of it into another website — it only shares something Microsoft's other
apps understand, not an actual file. To browse OneDrive from inside this
app, the app needs to sign in with your Microsoft account through
Microsoft's own login screen, which requires "registering" the app with
Microsoft first (free, and doesn't require an Azure subscription).

### One-time setup: register the app with Microsoft

1. Go to **entra.microsoft.com** (or **portal.azure.com**) and sign in with
   the Microsoft account whose OneDrive you want to use.
2. Search for **"App registrations"** and click **+ New registration**.
3. Name it anything, e.g. "Wedding Album Selector".
4. Under **Supported account types**, choose *"Accounts in any
   organizational directory and personal Microsoft accounts"*.
5. Under **Redirect URI**, choose platform **"Mobile and desktop
   applications"** and enter exactly:
   ```
   http://localhost:4173/auth/onedrive/callback
   ```
6. Click **Register**.
7. On the app's Overview page, copy the **Application (client) ID** — a
   string like `12345678-abcd-1234-abcd-1234567890ab`. You'll paste this
   into the app in a moment.
8. In the left sidebar, click **Authentication**, scroll down, turn on
   **"Allow public client flows"**, and click **Save**.
9. In the left sidebar, click **API permissions** → **+ Add a permission**
   → **Microsoft Graph** → **Delegated permissions**, then search for and
   check: `Files.Read`, `Files.Read.All`, `offline_access`, `User.Read`.
   Click **Add permissions**.

### Connect it in the app

1. Open the app, go to the **Setup** tab.
2. Paste the Application (client) ID into "Microsoft App Client ID" and
   click **Save Client ID**.
3. Click **Connect OneDrive** — you'll be sent to Microsoft's sign-in page
   to log in and approve access, then sent back here.
4. Once connected, an **"Add from OneDrive…"** button appears in the
   Library tab and the photo picker — click it to browse your OneDrive
   folders and add photos directly.

This only needs to be done once per computer. Use the **Disconnect** button
on the Setup tab if you ever want to sign out.

## If something goes wrong

- **"npm not recognized" / "command not found"** — Node.js isn't installed
  correctly, or you need to close and reopen your terminal window after
  installing it.
- **"port already in use"** — the app is already running in another window;
  just open `http://localhost:4173`, no need to start it again.
- **`npm install` fails** — check your internet connection and try again.
