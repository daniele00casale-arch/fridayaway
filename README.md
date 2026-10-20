# Fridayaway

Budget-first, swipe-to-decide weekend planner (flight + hotel). Concept by Daniele Casale.

- `index.html` – the app (static, no build step)
- `photos/` – destination photos (Unsplash)
- `api/lm.js` – Vercel serverless function that proxies the public lastminute.com MCP server (`https://mcp.lastminute.com/mcp`) for live packages, flights and booking links. Health check: `/api/lm?test=1`.

Independent concept, not affiliated with lastminute.com.
