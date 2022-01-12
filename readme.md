# Dfinity Devtools

Warning: work in progress. A little chrome extension to decode CBOR/Candid responses from the Dfinity blockchain in Chrome devtools.

## Why?

Developing on the Dfinity Blockchain, you will see ugly responses in the chrome devtools network tab:

![bad](bad.png)

This extension decodes responses from canisters into something more readable:

![good](good.png)

### Development

For development with automatic reloading:

```sh
npm run start
```

Open the [Extensions Dashboard](chrome://extensions), enable "Developer mode", click "Load unpacked", and choose the `dist` folder.

You will see the "Dfinity" tab in your devtools window.

When you make changes in `src` the background script and any content script will reload automatically.

### Production

When it's time to publish your Chrome extension, make a production build to submit to the Chrome Web Store. This boilerplate will use the version in `package.json`, unless you add a version to `src/manifest.json`.

> Make sure you have updated the name and version of your extension in `package.json`.

Run the following line:

```sh
npm run build
```

This will create a ZIP file with your package name and version in the `releases`
folder.