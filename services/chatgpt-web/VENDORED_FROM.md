# Provider provenance

This sidecar is an isolated copy of the tested ChatGPT-Web Playwright provider
from `/root/src/opencode-custom/packages/chatgpt-web` at commit
`a5fa1093630de378b14c088d8647a2100e4d67e3`.

It also includes the two locally tested hardening fixes present during the
Overleaf integration:

- only the newest trailing recovery control is authoritative;
- a dead persisted continuation URL is invalidated before fresh recovery.

No browser session, conversation map, token, `.env`, or other runtime state was
copied. Overleaf uses its own `/data` volume and login capture.
