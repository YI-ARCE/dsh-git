# dsh-git-badge

DSH web plugin that displays Git status beside workspace entries and opens the desktop Git view for the selected workspace. The host tracks workspace changes and provides a same-origin event stream; the client updates badges by workspace ID.

## Development

Run `node --test lib/*.test.js` to check the host, client, and AI integration. Install the plugin into the desired DSH profile and restart the profile after host changes.

The package name is `@yiarce/dsh-git-badge`. The bundle patch's `name`, the host export's `name`, and the browser module loader's `id` must all use this exact name. Keep the stable row ID `ui-git-badge` when changing package names.

For local development, install this directory through DSH's Plugin Manager. If the profile still has the old `dsh-git-badge` bundle, remove that legacy bundle first, then install this directory under its manifest name. Restart DSH if the manager reports `restart-required`, and reload the page to load the updated browser module.

The package is Windows desktop oriented: opening the Git view relies on the Wails runtime. The AI model used by the optional Git features must be configured separately.
