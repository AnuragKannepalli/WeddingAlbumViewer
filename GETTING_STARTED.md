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

## If something goes wrong

- **"npm not recognized" / "command not found"** — Node.js isn't installed
  correctly, or you need to close and reopen your terminal window after
  installing it.
- **"port already in use"** — the app is already running in another window;
  just open `http://localhost:4173`, no need to start it again.
- **`npm install` fails** — check your internet connection and try again.
