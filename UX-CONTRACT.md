# Student lab interaction contract

- The application opens directly into the lab. Session creation is automatic and anonymous; session state is in memory and can disappear on server restart or expiry.
- The selected lesson remains visible while changing rules or running traffic. Reset restores the lesson baseline and clears injected faults; routine reset is reversible and does not need a confirmation dialog.
- Configuration changes validate before activation. Invalid input remains visible with a field-level explanation, and the last valid gateway configuration stays active.
- A run has explicit pending, running, complete, and failed states. Disable duplicate run submission, preserve control dimensions, show progress, and summarize the completed run inline.
- The real proxy path is the source of response and trace data. UI estimates must not be presented as measured requests.
- Errors state the failed operation and a recovery action. A lost/expired session offers a direct restart path without a full page refresh.
- Keyboard access, visible focus, reduced motion, text labels for health states, and responsive reading of results are required.
