# Image Merger

Combine and arrange images in your browser, then export the result as PNG, JPEG, or WebP.
You can also create one multi-page PDF with one uploaded image per page. All image
processing happens locally in your browser.

Use the save buttons to choose a location with the browser's native save dialog when
supported. Otherwise, files are downloaded using your browser's download settings.
Browsers require user interaction to access local files and cannot save without permission.

## Run locally

```sh
npm install
npm run dev
```

## Deploy to Vercel

Import this repository into Vercel. The project is configured to use Vite, run
`npm run build`, and publish the generated `dist` directory. No environment
variables or server-side functions are required.

To build and preview the production output locally:

```sh
npm run build
npm run preview
```