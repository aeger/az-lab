# SOP: Dashboard Modal / Slide-Panel Z-Index and Banner Visibility

**Status:** Active
**Created:** 2026-04-16
**Applies to:** All modal dialogs, slide-in panels, and overlay forms in ~/dashboard/

---

## Problem

The az-lab dashboard uses a sticky `SiteHeader` component with a **220px banner** at `zIndex: 100` (relative positioning). Any fixed overlay that uses a z-index ≤ 100 will be partially or fully covered by the banner, making the top portion of the form inaccessible.

This has occurred on:
- New Task form (`TaskQueueExpanded.tsx`) — used `z-50`, banner covered header row
- (Previously fixed) New Goal form (`goals/page.tsx`) — fixed to `z-[200]`

---

## Rule

**All fixed overlays, modals, slide-in panels, and dialogs MUST use `z-[200]` or higher.**

Do not use Tailwind's preset z-index utilities (`z-10`, `z-50`, `z-100`) for overlay containers — they fall below or at the banner's z-index. Always use an arbitrary value:

```tsx
// CORRECT
className="fixed inset-0 z-[200] flex items-stretch justify-end"

// WRONG — banner will cover the top of the overlay
className="fixed inset-0 z-50 flex items-stretch justify-end"
```

---

## Z-Index Reference

| Element | z-index | Notes |
|---------|---------|-------|
| SiteHeader banner | 100 | Sticky, 220px tall |
| Modals / panels | **200+** | Must exceed banner |
| Toasts / alerts | 300+ | Above modals if needed |

---

## Checklist for New Modals / Slide Panels

When adding any new overlay, panel, drawer, or dialog to the dashboard:

- [ ] Outer container uses `z-[200]` or higher
- [ ] Container is `fixed inset-0` (covers full viewport)
- [ ] Inner panel uses `flex flex-col h-full` so it fills the viewport height
- [ ] Form/content area uses `overflow-y-auto` so it scrolls within the panel
- [ ] Backdrop click handler closes the modal (attach `onClick={handleBackdrop}` to outer div, `stopPropagation` on inner panel)

---

## Reference Implementation (Goals form — confirmed working)

```tsx
// Outer overlay
<div
  className="fixed inset-0 z-[200] flex items-stretch justify-end"
  style={{ background: 'rgba(0,0,0,0.6)' }}
  onClick={handleBackdrop}
>
  // Inner panel
  <div
    className="w-full max-w-2xl bg-zinc-950 border-l border-zinc-800 flex flex-col h-full"
    style={{ animation: 'slideInRight 0.2s ease-out' }}
  >
    // Header row
    <div className="flex items-center justify-between p-4 border-b border-zinc-800">
      <h2 className="text-sm font-semibold text-zinc-200">Title</h2>
      <button onClick={onClose}>&times;</button>
    </div>
    // Scrollable content
    <form className="flex-1 p-5 space-y-4 overflow-y-auto">
      {/* fields */}
    </form>
  </div>
</div>
```

---

## History

| Date | Component | Issue | Fix |
|------|-----------|-------|-----|
| 2026-04-16 | `TaskQueueExpanded.tsx` | `z-50` → banner covered New Task form | Changed to `z-[200]` |
| (prior) | `goals/page.tsx` | Same banner overlap | Changed to `z-[200]` |
