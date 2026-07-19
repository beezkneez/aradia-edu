# CLAUDE.md

## Project
Aradia EDU - Learning Management System for Aradia Fitness staff training.
Shares the same PostgreSQL database and user auth (email+PIN) as aradia-time.

## Tech Stack
- Backend: Node.js + Express + PostgreSQL (same as aradia-time)
- Frontend: Vanilla JS SPA (single index.html, no framework)
- File uploads: multer
- Port: 3400 (aradia-time is 3000)

## UI Conventions
* **Always use toggles, never plain checkboxes.** Use the existing `admin-toggle` pattern: `<label class="admin-toggle"><input type="checkbox"><span class="slider"></span></label>` wrapped in a `toggle-row` div.
* Themes: dark (default), light, aradia - synced from user's aradia-time preference.

## Key Tables (edu_ prefix)
- edu_modules, edu_chapters, edu_pages - course content
- edu_assignments - who has access to what
- edu_progress - page-level completion tracking
- edu_module_completions - module-level completion
- edu_manuals, edu_manual_favorites - reference manuals
- edu_videos - training videos. `file_path` holds the playable source; `file_type`
  is `bunny_video` (Bunny Stream iframe embed URL) or `drive_video` (legacy Google
  Drive `/preview` URL). Every player just `<iframe src=file_path>`, including the
  read-only mirror in aradia-time — so the source is swappable with no player changes.

## Video hosting (Bunny Stream)
Admins add videos two ways from **Admin → Videos**:
1. **Upload a video file** (primary) → `POST /api/admin/uploadVideoBunny` streams the
   file to a Bunny Stream library (via a temp file, never kept on this ephemeral disk)
   and saves the Bunny embed URL. `deleteVideo` also deletes the Bunny-hosted file.
2. **Add from Google Drive link** (legacy) → stores a Drive `/preview` URL.

Env vars (set on the Railway `aradia-edu` service; also in `.env` for local dev):
- `BUNNY_STREAM_LIBRARY_ID` — the Stream video library ID.
- `BUNNY_STREAM_API_KEY` — that library's API key (from its **API** tab). Server-side only.
- `BUNNY_STREAM_CDN_HOSTNAME` — e.g. `vz-xxxx.b-cdn.net` (reserved for future direct HLS).

Without these, in-app upload returns a clear error but Drive videos still work.
Playback gating (Bunny token-auth signed URLs) is **not** enabled yet — a later increment.
