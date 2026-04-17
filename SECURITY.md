# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | Yes                |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Please report security vulnerabilities by emailing **security@syrin.dev**.

Include as much of the following information as possible:

- Type of issue (e.g. data exfiltration, remote code execution, prompt injection)
- Full paths of source files related to the issue
- Location of affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

## Response SLAs

| Severity | Acknowledgment | Patch Released |
|----------|----------------|----------------|
| Critical | 24 hours       | 72 hours       |
| High     | 48 hours       | 7 days         |
| Medium   | 5 days         | 30 days        |
| Low      | 14 days        | Next release   |

## Disclosure Policy

1. We will acknowledge your report within the timeframe listed above.
2. We will confirm the issue and determine its scope.
3. We will release a fix as quickly as possible within the SLA above.
4. We will publicly disclose the issue after a patch has been released.
5. We will credit the reporter in the release notes (if desired).

## Security Architecture Notes

The Syrin SDK instruments LLM API calls at the class level. Enterprise security teams
reviewing this SDK should read our **Security Architecture Guide**:
`docs/security-architecture.md`

Key points:
- The SDK patches `openai.resources.chat.completions.Completions.create` at the class level
- Patching is reversed by `syrin_sdk.shutdown()` — original methods are fully restored
- All telemetry transmission is outbound-only to `api.syrin.dev` (or your configured backend)
- `capture_content` defaults to `False` — prompts/completions are **never** transmitted by default
- Governance actions (`stop`, `inject_message`) are **opt-in** and disabled by default

## CVE Assignment

For critical and high severity issues, we will work with MITRE to assign a CVE number
and coordinate public disclosure.

Contact: security@syrin.dev
