# Patrix Medical - Master Design System

This document establishes the global source of truth for the UI/UX redesign of the Patrix Medical Complaints Tracker, strictly following the `ui-ux-pro-max` guidelines.

## 1. Visual & Aesthetic Architecture

* **Design Concept**: Modern Glassmorphic Medical Dashboard.
* **Theme**: Sleek Slate Dark Mode with Calm Cyan and Health Emerald highlights.
* **Fonts**:
  - Headings: `Lexend` (Google Fonts) - optimized for readability and structure.
  - Body Text: `Source Sans 3` (Google Fonts) - highly legible sans-serif.
* **Palette (Healthcare App Profile)**:
  - Background (Dark): `#090d16` (slate black) with subtle cyan gradient backing.
  - Panel Base: `rgba(15, 23, 42, 0.6)` with 1px border.
  - Border Color: `rgba(255, 255, 255, 0.08)` (delicate, high contrast).
  - Primary Accent: Calm Cyan (`#0891b2`) / Light Cyan (`#22d3ee`).
  - Secondary Accent: Health Emerald (`#10b981`) / Soft Mint (`#a7f3d0`).
  - Warning Accent: Soft Amber (`#f59e0b`).
  - Danger Accent: Rose Red (`#f43f5e`).
  - Monospace: `Fira Code` - for console log metrics.

---

## 2. Interaction & Component Standards

* **No Emojis**: Emojis are strictly banned as UI icons. They must be replaced with custom, responsive SVG paths from Lucide/Heroicons sets.
* **Stable Hover Feedback**: Interactive cards/buttons must use transitions on color or opacity (no layout shifting scales).
* **Cursor pointer**: Add `cursor-pointer` to all interactive items (cards, row elements, close triggers).
* **Transitions**: Smooth color/opacity transitions (`transition-all duration-200 ease-in-out`).
* **Inputs & Selects**: Consistent custom border-radius (`12px`), dark slate background (`#0f172a`), with a cyan focus glow ring.

---

## 3. UI Pre-Delivery Checklist
* All emojis replaced by SVGs.
* Google fonts Lexend and Source Sans 3 imported and configured.
* Touch targets at least 44x44px.
* Hover states tested for layout stability.
