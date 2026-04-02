# Lense

> Record. Zoom. Share.

**Lense** is a free browser-based screen recorder with a killer feature: **draw a box over any part of your screen while recording and it zooms right in.** Double-click or Esc to zoom back out.

No server. No upload. No account. Videos save directly to your machine.

---

## Features

- 🎥 Record screen + webcam overlay (circle or rectangle, draggable)
- 🔍 Draw-to-zoom: hold and drag over any area to zoom in while recording
- 🖱 Double-click anywhere to zoom back out
- 💾 Videos auto-save locally (`.webm` / `.mp4`) — plays anywhere
- 🔒 100% private — nothing leaves your browser
- ⌨️ Keyboard shortcuts: `Esc` to zoom out
- 📦 Zero dependencies, zero server

## Browser Support

| Browser | Screen Record | Webcam | Zoom |
|---------|:---:|:---:|:---:|
| Chrome 72+ | ✅ | ✅ | ✅ |
| Edge 79+ | ✅ | ✅ | ✅ |
| Firefox 66+ | ✅ | ✅ | ✅ |
| Safari 13+ | ✅ | ✅ | ✅ |
| iOS / Android | ❌* | ✅ | — |

*Mobile screen recording is blocked by OS/browser security policies — not something we can fix in code.

## Deploy to Render (free)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Static Site
3. Connect your repo — Render auto-detects `render.yaml`
4. Done. Deploys in ~30 seconds.

## Local dev

No build step needed:

```bash
# Any static file server works
npx serve .
# or
python3 -m http.server 8080
```

## File structure

```
lense/
├── index.html   # Full UI (landing + recorder)
├── style.css    # All styles + CSS variables
├── app.js       # All logic (recording, zoom, cam, timer)
├── config.js    # 
└── render.yaml  # Render static deploy config
```

## License

MIT — free to use, fork, and build on.
