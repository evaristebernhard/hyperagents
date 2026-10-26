# Hyperagents UI

A standalone React + TypeScript implementation of the Hyperagent interface, built from the Figma screens.

## Run locally

1. Install Node.js 20 or newer.
2. In this repository, run npm install.
3. Run npm run dev and open the local URL printed by Vite.
4. Run npm run build to verify a production build.

## What's included

- Landing page and task composer
- Thread conversation layout with a draggable conversation/workspace split
- Browser empty state and mock multi-session workspace
- Editable project document panel
- Create Agent identity flow and settings sidebar
- Responsive layout, search overlay, and local-only interaction states

The first version is intentionally frontend-only. LLM calls, live browser control, authentication, and backend persistence are not connected. UI interactions use local React state.

## Deployment

The GitHub Actions workflow builds the app and deploys it to GitHub Pages when changes are pushed to main. In repository Settings → Pages, select GitHub Actions as the build and deployment source if it is not already selected.