---
name: ui-ux-pro-max
description: Design, implement, review, or fix polished web and desktop interfaces with strong layout, interaction, accessibility, visual consistency, and runtime verification. Load for UI, UX, responsive layout, components, icons, themes, or visual bugs.
---

# UI/UX Pro Max

Build interfaces that feel deliberate, coherent, and native to the product. Preserve the user's requested direction and the application's established design language; do not impose a generic redesign on a focused change.

## Start with evidence

Before editing an existing interface:

1. Inspect the rendered UI or supplied reference image.
2. Locate the responsible markup, styles, event handler, and existing design tokens.
3. Identify the observable problem and acceptance criteria.
4. Reuse the established component and icon system where possible.

Do not claim a visual or interaction issue is fixed from compilation alone.

## Design decisions

- Establish hierarchy with spacing, size, weight, and contrast—not color alone.
- Use a consistent 4/8 px spacing rhythm and align related controls.
- Keep one clear primary action per region; subordinate secondary actions.
- Prefer progressive disclosure over presenting every option at once.
- Preserve stable layout bounds across hover, pressed, loading, and disabled states.
- Use SVG icons with a consistent stroke/fill language. Do not use emoji as structural icons.
- Use semantic theme tokens rather than isolated hard-coded colors.
- In dark themes, keep text readable, borders visible, and active/disabled states distinct.
- Avoid decorative animation. Motion should explain a state change and respect reduced-motion preferences.

## Interaction and feedback

- Every interactive element must use the correct semantic control (`button`, `input`, `select`, or equivalent).
- Icon-only buttons need a descriptive accessible name and a tooltip where useful.
- Toggle buttons expose their state with `aria-pressed` and a visible non-color-only state.
- Keyboard focus must be visible and follow the visual order.
- Disable controls while an incompatible operation is running; disabled controls must look disabled.
- Give immediate feedback for actions that take more than a moment. Name the current phase instead of showing an unexplained spinner.
- Errors should state what failed and how the user can recover.
- Do not rely on hover for essential behavior.

## Layout and responsiveness

- Keep flex/grid children shrinkable and prevent unintended horizontal scrolling.
- Wrap collections before truncating important labels; expose full text when truncation is unavoidable.
- Keep fixed or sticky UI from covering focused controls and scrollable content.
- Check narrow, standard, and wide layouts when the change can reflow.
- Pointer targets on desktop web should be at least 24×24 CSS pixels; frequently used controls should normally be about 32–40 px.

## Implementation workflow

1. Trace the complete interaction path before editing.
2. Make the smallest coherent change in the existing style.
3. Implement empty, loading, active, disabled, error, and success states that the component genuinely needs.
4. Run syntax and focused tests.
5. Inspect the real rendered result when a browser or application preview is available.
6. Exercise the actual interaction, keyboard behavior, and error path.
7. Compare the final runtime result with the request or reference image.

If runtime inspection is unavailable or the user explicitly asks to inspect it themselves, say exactly what was verified and leave runtime appearance as unverified.

## Final review

Before finishing, confirm:

- The requested behavior works through the real input path.
- Layout, spacing, typography, icons, and states match neighboring UI.
- Focus, accessible names, pressed/expanded state, and keyboard operation are correct.
- No content is clipped or hidden at the relevant window sizes.
- Loading and disabled feedback remain understandable without color alone.
- Tests pass, and environmental failures are distinguished from regressions.

Report the changed files, the behavior implemented, and the exact verification performed.
