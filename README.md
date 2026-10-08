# dsh-git-badge

DSH web plugin that displays Git status beside workspace entries and opens the desktop Git view for the selected workspace. The host tracks workspace changes and provides a same-origin event stream; the client updates badges by workspace ID.

## Development

Run `node --test lib/*.test.js` to check the host, client, and AI integration. Install the plugin into the desired DSH profile and restart the profile after host changes.

The package is Windows desktop oriented: opening the Git view relies on the Wails runtime. The AI model used by the optional Git features must be configured separately.
