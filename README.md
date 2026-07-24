# StickShift PWA

Public distribution build of StickShift for mobile/HTTPS use.

StickShift is a human-controlled local context bridge. The application is served publicly, but the workspace a user selects remains on that user's device/storage provider and is accessed only through browser-granted file permissions. No shared corpus or central StickShift database is included in this repository.

## Install

This repository is intended to be served with GitHub Pages from the `main` branch root. Open the Pages URL in a Chromium-based browser and use **Install app** / **Add to Home screen**.

## AI setup

Inside StickShift, use **Copy AI skill** and paste the copied instructions into the AI you want to operate with StickShift.

## Public distribution boundary

This repository contains only the distributable PWA shell: `index.html`, the web app manifest, service worker, and install icons. User workspaces and OKF context are not committed here.
