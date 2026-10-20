# Celerity

A fast, free 2D animation studio for **Windows, macOS and Linux**. It works like
Adobe Animate, saves and opens **`.fla` files**, and exports SWF, video, GIF,
PNG sequences, SVG and sprite sheets.

The default workspace mirrors Animate's *Essentials* layout. Tools are on the
left, the stage is in the centre, the timeline runs along the bottom, and
Properties, Library, Color, Align and Transform are docked on the right. Every
panel can be dragged to another dock or floated, and layouts can be saved as
workspaces. The default keyboard shortcuts are Animate's, so existing muscle
memory keeps working.

---

## Quick start

You need **Node.js 20 or newer** (the LTS from <https://nodejs.org> is fine).

```bash
npm install      # installs Electron, the build tools and a bundled ffmpeg
npm start        # builds and launches the desktop app
```

### Build installers locally

```bash
npm run dist:mac     # .dmg + portable .zip
npm run dist:win     # NSIS installer .exe + portable .zip
npm run dist:linux   # AppImage + .deb + portable .zip
```

Installers are written to `release/`. Add `--x64` or `--arm64` after the
`electron-builder` command to pick an architecture. The installers register
`.fla` files so you can double-click to open them.

### Releases (GitHub Actions)

`.github/workflows/release.yml` runs typecheck and tests, then builds
**Windows, macOS and Linux for both x64 and arm64**:

| Platform | Installer | Portable |
| --- | --- | --- |
| Windows | `Celerity-Setup-<ver>-win-<arch>.exe` | `Celerity-<ver>-win-<arch>.zip` |
| macOS | `Celerity-<ver>-mac-<arch>.dmg` | `Celerity-<ver>-mac-<arch>.zip` |
| Linux | `Celerity-<ver>-linux-<arch>.AppImage`, `.deb` | `Celerity-<ver>-linux-<arch>.zip` |

When everything is built, it collects the files into a **draft release** on the
repository's Releases page. Review the draft, then publish it.

There are two ways to trigger it:

- **Push a version tag:**
  ```bash
  git tag v0.2.0 && git push origin v0.2.0
  ```
- **Run it by hand** from *Actions → Build & Release → Run workflow*. It uses
  `v<version in package.json>` unless you enter a tag.

The builds are not code-signed. On macOS, right-click the app and choose **Open**
the first time, or run `xattr -cr /Applications/Celerity.app`. On Windows,
choose **More info → Run anyway** in SmartScreen. To sign, add your
certificates as the `CSC_LINK` / `CSC_KEY_PASSWORD` secrets (electron-builder
picks them up).

### Other scripts

| Command | What it does |
| --- | --- |
| `npm run web` | Runs the editor in your normal browser at http://localhost:5178. Video export there falls back to WebM. |
| `npm test` | Runs the unit and file-format tests: timeline ops, tweens, merge-drawing geometry, motion tweens, sound/video, FLA round-trip, SWF bit-level validation, zip, GIF, sprite sheet packing. |
| `npm run typecheck` | Runs a strict TypeScript check. |
| `npm run watch` | Rebuilds on save (run `npx electron .` in a second terminal). |

---

## Features

**Merge drawing model.** Like Animate, shapes drawn on the same layer fuse when
they share a colour and cut into each other when they don't. Click a fill or a
stroke segment to select it, double-click to add the connected strokes, or
marquee part of a shape. Dragging a selection lifts it and drops it back into
the shape. Drag an edge to bend it, or a corner to move it. The Paint Bucket
fills enclosed areas, the Ink Bottle restrokes outlines, and the Eraser cuts
through fills and strokes. Press `J` (or use the toolbar button) to switch to
**Object Drawing**, where each shape stays a separate drawing object. Break
Apart (`Ctrl+B`) turns a drawing object back into a raw shape.

**Drawing tools.** All of these use Animate's keys:

- Selection `V`, Subselection `A`, Free Transform `Q`, Gradient Transform `F`
- Pen `P`, Text `T`, Line `N`, Rectangle `R` (with corner radius), Oval `O`, PolyStar (Shift+R)
- Pencil `Y` (smooth, straighten and ink modes), Brush `B` (pressure-sensitive)
- Paint Bucket `K` (fills closed areas, with gap closing), Ink Bottle `S`, Eyedropper `I`
- Eraser `E` (normal, fills, lines and objects modes)
- Hand `H` / Space, Zoom `Z`

**Fills and strokes.** Solid colours with alpha, linear and radial gradients
(with a stop editor), stroke width, caps and joins.

**Snapping and object handling.**

- Snaps to objects and to the stage edges and centre.
- Alt-drag duplicates an object.
- Shift constrains drawing and moving.
- Arrow keys nudge.

**Timeline**

- Layers, folders, mask layers and guide layers.
- Show, lock and outline toggles; layer colours; drag to reorder.
- Keyframes `F6`, blank keyframes `F7`, insert frames `F5`, remove frames `Shift+F5`, clear keyframe `Shift+F6`.
- Drag keyframes and frame ranges to move them; copy, cut and paste frames; reverse frames.
- **Motion tweens** (the object-based tweens of Animate CS4 and later): Insert › Create Motion Tween, then move, rotate, scale, skew or recolour the object on any frame of the span to add property keyframes. The motion path is drawn on the stage, and `F6` keys every property at the playhead.
- Classic tweens with ease and rotation (CW/CCW × n), and shape tweens (morphing).
- Frame labels, onion skin, looped playback (`Enter`), scrubbing and scenes.
- Simple frame scripts: `stop()`, `play()`, `gotoAndPlay()`, `gotoAndStop()`, `nextFrame()`, `prevFrame()`.

**Symbols**

- Graphic, Movie Clip and Button symbols; Convert to Symbol `F8`; New Symbol `Ctrl+F8`.
- Edit in place (double-click), with the rest of the stage dimmed; breadcrumb navigation.
- Graphic looping options (loop, play once, single frame, reverse).
- Colour effects: brightness, tint, alpha and advanced.
- Filters (drop shadow, blur, glow) and blend modes on movie clips.
- Swap symbol; Break Apart `Ctrl+B`; Group `Ctrl+G` / Ungroup.
- Distribute to Layers `Ctrl+Shift+D`.

**Library**

- Folders, previews (animated), rename, duplicate and delete.
- Drag items onto the stage.
- Import PNG, JPG, GIF, WebP, BMP and **SVG** (SVG becomes editable vectors).
- Import **sounds** (MP3, WAV, OGG, FLAC, M4A, AIFF). Drag one onto the stage, or pick it under Properties › Sound, to attach it to a keyframe. Sync can be Event, Start, Stop or Stream, with repeat or loop. Sounds play with the timeline and in Test Movie, show as waveforms in the timeline, and are mixed into exported video.
- Import **video** (FLV, MP4, MOV, WebM). It is embedded in the timeline frame by frame, like Animate's embedded video. In the desktop app it is stored as FLV, so the `.fla` opens in Animate and the SWF streams it natively.
- Select several symbols (Ctrl/Shift-click in the library, or select instances on stage) and use **File › Export › Export Selected Symbols** to export them together as one sprite sheet, one PNG sequence or one video. In a video or PNG sequence they can play one after another or side by side.
- Open External Library (copy the symbols out of another `.fla`).

**Panels and workspaces**

- Properties is context sensitive: document, tool options, selection, frame (tweens, sound, scripts) and filters.
- Color, Align (align, distribute, match size, space evenly, align to stage) and Transform.
- Drag a panel's tab to move it. Drop it on another group to add it as a tab, on a group's edge to split, on an edge of the stage to start a new column or row, or anywhere else to float it. The × on a tab bar closes the front panel, and the Window menu shows or hides each panel.
- **Window › Workspaces** (or the button at the top right) switches between *Essentials* (the default), *Classic*, *Animator*, *Designer* and *Small Screen*, and saves your own layouts. Every workspace remembers your changes until you choose *Reset*.

**Files**

- **Open/save `.fla`** in the XFL format used by Flash CS5 and later.
- Reads and writes Animate's raw "merge drawing" shapes, drawing objects, rectangle/oval primitives, symbols, folders, bitmaps (`bin/*.dat`), sounds (MP3, raw PCM and ADPCM), embedded video (FLV, or MP4/MOV/WebM behind Animate's header), static/dynamic/TLF text, masks, guides, motion tweens (`motionObjectXML` property curves, eases and colour curves), classic and shape tweens, frame sounds, labels, scripts, colour effects and filters.
- Crash recovery: unsaved work is snapshotted every 30 seconds and offered back after a crash.

**Export / publish**

- **SWF** (`Shift+F12`): DefineShape4 vectors, gradients, bitmaps, movie clips as sprites, graphic symbols flattened like Flash does, masks (clip depths), filters and blend modes (PlaceObject3), frame labels, AS2 frame scripts, sounds (DefineSound/StartSound with sync and loops) and embedded FLV video (DefineVideoStream). An optional HTML wrapper plays the movie through Ruffle.
- **Video**: MP4 (H.264 + AAC), MOV (ProRes 4444 with alpha), WebM (VP9 with alpha + Opus), animated GIF (ffmpeg palette or the built-in encoder) and PNG sequences. The timeline's sounds become the soundtrack.
- **Sprite sheets**: packed (MaxRects) or grid layout, trimming, duplicate stacking, padding and power-of-two sizes. Data formats are JSON (Hash), JSON-Array, Phaser 3, Starling/Sparrow XML, EaselJS, cocos2d-x plist and CSS.
- **Images**: PNG (optionally transparent), JPEG and SVG.
- **Test Movie** (`Ctrl+Enter`) plays the movie with movie clips running and frame scripts applied.

---

## Keyboard shortcuts (highlights)

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| New / Open / Save / Save As | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S | ⌘N / ⌘O / ⌘S / ⇧⌘S |
| Import to Stage / Library | Ctrl+R / Ctrl+Alt+R | ⌘R / ⌥⌘R |
| Undo / Redo | Ctrl+Z / Ctrl+Y | ⌘Z / ⌘Y (or ⇧⌘Z) |
| Paste in Place | Ctrl+Shift+V | ⇧⌘V |
| Duplicate | Ctrl+D | ⌘D |
| Convert to Symbol / New Symbol | F8 / Ctrl+F8 | F8 / ⌘F8 |
| Group / Ungroup / Break Apart | Ctrl+G / Ctrl+Shift+G / Ctrl+B | ⌘G / ⇧⌘G / ⌘B |
| Frame / Keyframe / Blank Keyframe | F5 / F6 / F7 | F5 / F6 / F7 |
| Remove Frames / Clear Keyframe | Shift+F5 / Shift+F6 | ⇧F5 / ⇧F6 |
| Play / Step | Enter / , and . | Return / , and . |
| Test Movie | Ctrl+Enter | ⌘Return |
| Publish / Export Video | Shift+F12 / Ctrl+Alt+Shift+S | ⇧F12 / ⌥⇧⌘S |
| Zoom 100% / Fit / In / Out | Ctrl+1 / Ctrl+2 / Ctrl+= / Ctrl+- | ⌘1 / ⌘2 / ⌘= / ⌘- |
| Object Drawing on/off | J | J |
| Timeline / Properties / Library panel | Ctrl+Alt+T / Ctrl+F3 / Ctrl+L | ⌥⌘T / ⌘F3 / ⌘L |
| Align left…bottom | Ctrl+Alt+1…6 | ⌥⌘1…6 |
| Arrange | Ctrl(+Shift)+Up/Down | ⌘(+⇧)+↑/↓ |

**Help → Keyboard Shortcuts** (F1) lists every shortcut.

---

## FLA compatibility notes

Celerity writes standard XFL: `DOMDocument.xml`, `LIBRARY/*.xml` and `bin/*.dat`
media, zipped into a `.fla`. Raw shapes are saved as merge-mode `DOMShape`
edges and drawing objects as `isDrawingObject` shapes, like Animate does.
Motion tweens are saved as `motionObjectXML` curves. Sounds keep their MP3 or
PCM data, and video is embedded as FLV.

These Animate features are **not supported yet**. Where it's possible, they are
kept in a simplified form and a note appears when the file opens:

- **Motion tweens:** custom ease curves, 3D rotation and filter animation curves are kept in the file but not animated. Motion guides (paths you draw) are not supported.
- **Sound:** envelopes (fades and in/out points) are ignored. In SWF output, stream sync is approximated by an event sound that stops at the end of its frames.
- **Video:** in the browser version, FLV video can only be previewed when ffmpeg is available (desktop app).
- **Bones/IK**, **3D**, **camera**, **bitmap fills** and **motion guides**.
- **Full ActionScript 3**. Only the simple timeline commands listed above run in Test Movie and published SWFs.
- **Pre-CS5 binary `.fla` files**. Re-save them in Animate or Flash CS5+ first.

---

## Project layout

```
src/
  core/      document model, geometry, planar (merge) shapes, timeline ops, tweens, motion tweens, sound, renderer, undo store
  io/        FLA/XFL read+write (incl. motion tweens), SWF writer, FLV, ZIP, GIF, SVG import/export, sprite sheets
  ui/        app shell, dockable workspace, stage, tools, timeline, panels, audio/video engines, dialogs, exporters
  main/      Electron main process (windows, dialogs, file I/O, ffmpeg) + preload
  renderer/  HTML/CSS entry
tests/       node:test suites (core, planar shapes, motion tweens, sound/video, file formats, incl. a bit-level SWF reader)
```

The editor has **no runtime dependencies** in the renderer. It ships its own
ZIP, GIF, SWF and XML code, so it stays small and starts fast. Rendering uses
Canvas 2D with cached `Path2D` geometry, and the timeline is drawn on a canvas
so it stays smooth with thousands of frames.

## License

MIT
