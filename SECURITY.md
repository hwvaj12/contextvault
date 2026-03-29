# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by sending an email to [security@contextvault.ai](mailto:security@contextvault.ai).

Please do **not** create a public GitHub issue for security vulnerabilities.

## Security Best Practices

When deploying ContextVault:

- **API Keys:** Keep your `X-API-Key` secret. Rotate them periodically.
- **Network:** Run behind a firewall or VPN if exposing externally.
- **Sandboxes:** Agent sandboxes are ephemeral and destroyed after each run. Do not rely on them for persistent storage.
- **Git Repos:** Workspace repos are stored at `data/workspaces/`. Ensure this directory is backed up.

## Authentication

ContextVault uses API key authentication. Each request must include:

```
X-API-Key: your-api-key
```

## Rate Limiting

Rate limiting is not currently enforced at the application level. For production deployments, implement rate limiting at your API gateway or reverse proxy.
