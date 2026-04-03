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
