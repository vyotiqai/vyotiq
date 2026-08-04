---
name: security-review
description: Security-focused review of auth, secrets, injection, XSS, SSRF, path traversal, and data handling. Use when auditing security, reviewing auth/secrets, threat-modeling a change, or when the user asks for a security review.
metadata:
  version: "1.0.0"
---

# Security review

## Instructions
1. Prioritize authz/authn gaps, injection, XSS, SSRF, path traversal, and secret leakage.
2. Trace how untrusted input reaches parsers, shells, SQL, HTML, and network calls.
3. Flag secrets, tokens, and PII in logs, commits, or client bundles.
4. Note unsafe defaults (open CORS, weak crypto, missing validation).
5. Suggest concrete mitigations tied to the involved code paths.
6. Distinguish confirmed issues from speculative risks.
7. Ask 1–2 clarifying questions only when threat model or trust boundaries are unclear.
