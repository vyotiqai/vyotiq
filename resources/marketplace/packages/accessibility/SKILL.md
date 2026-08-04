---
name: accessibility
description: Audit and improve UI accessibility: semantic HTML, keyboard navigation, focus, contrast, screen-reader names, and motion preferences. Use when reviewing a11y, fixing WCAG issues, ARIA, keyboard traps, or accessibility bugs.
metadata:
  version: "1.0.0"
---

# Accessibility

## Instructions
1. Prefer semantic HTML and correct roles before adding ARIA.
2. Ensure full keyboard reachability and visible focus states.
3. Give controls accessible names; do not rely on color alone.
4. Check text and interactive contrast against WCAG AA when practical.
5. Honor `prefers-reduced-motion` for non-essential animation.
6. Announce status and errors (live regions or associated text).
7. Preserve existing visual design unless redesign is requested.

## Edge cases
- Custom widgets need roles, names, and keyboard behavior that match the native control.
- Do not hide focus outlines without an equivalent visible focus style.
