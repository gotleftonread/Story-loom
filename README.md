# Story Loom — free hosted setup

This folder is ready to deploy to **Cloudflare Pages** (free static hosting +
free serverless functions + free custom domain).

```
story-loom-site/
├── index.html              ← the app (your React/JSX code, no build step)
└── functions/
    └── api/
        └── story.js         ← serverless function that talks to Gemini,
                               keeping your API key hidden from visitors
```

## 1. Get a free Gemini API key

1. Go to https://aistudio.google.com/apikey
2. Sign in with a Google account, click "Create API key"
3. Copy the key — you'll paste it into Cloudflare, never into any file here

## 2. Put this folder on GitHub

1. Create a new repo at https://github.com/new (public or private, either works)
2. Upload these three items (`index.html`, the `functions` folder, this
   README) to the repo — either by dragging them into the GitHub web UI's
   "Add file > Upload files" screen, or via `git push` if you're comfortable
   with git

## 3. Connect it to Cloudflare Pages

1. Go to https://dash.cloudflare.com → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git**
2. Pick the repo you just created
3. Build settings: leave the build command **blank** and the output
   directory as `/` (this is a static site with no build step)
4. Before the first deploy finishes, go to **Settings → Environment
   variables** on the Pages project and add:
   - Name: `GEMINI_API_KEY`
   - Value: (the key from step 1)
5. Deploy. Cloudflare gives you a free `your-project.pages.dev` URL right away.

## 4. Add your own domain (free)

In the same Pages project: **Custom domains → Set up a custom domain**,
enter your domain, and follow the DNS instructions shown (a CNAME record,
usually — takes a few minutes to a few hours to propagate).

## Notes

- Stories are saved in each visitor's own browser (`localStorage`), not on
  a server — so a story won't follow someone between devices or browsers.
- Gemini's free tier has generous but real rate limits. If a lot of people
  use the site at once, some requests may get rate-limited — the app will
  show an error and let them retry.
- Gemini isn't Claude, so narration style/JSON-following may differ
  slightly from what you saw in Claude's chat, though the same instructions
  are sent.
