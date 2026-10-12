# Design direction

## Audience and job

Networking and software students use this workbench to make a routing change and immediately connect that decision to what happened to real HTTP requests. It should feel like a practical network lab bench, not a generic cloud monitoring dashboard.

## Visual system

- **Canvas:** pale mineral `#F2F3EF`; raised surfaces `#FFFFFF`; ink `#18231F`; secondary `#69756F`.
- **Routing:** deep pine `#176B55`; highlight mint `#D8EFE4`.
- **Signals:** amber `#B66B18` for degraded, brick `#B84C3C` for failed, blue `#3C6F91` for informational.
- **Type:** system sans for readable instructions, a restrained editorial serif for lesson headlines, tabular monospace for paths, rates, and traces.
- **Shape:** crisp panels with 8px corners, fine green-gray rules, and generous whitespace. The signature is a horizontal live request trace that travels through a labeled topology and lands in a concrete service response.
- **Motion:** short request pulses only; respect reduced-motion and always retain static status labels.

## Behavior

Native buttons and labeled form fields own interactions. Preserve visible focus, associate validation with controls, keep errors in place until corrected, and announce run progress/results accessibly. Route matching and traffic behavior must be consistent between the editor, live proxy, and traces.

## Token path

This document owns visual intent and named values. The application stylesheet maps these values to CSS custom properties, and components consume those properties; do not duplicate palette literals in component styles.
