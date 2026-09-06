import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { brand, loadBrand } from './brand.js';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

/**
 * The name is resolved before anything mounts.
 *
 * One request, awaited, so the sign-in card and the header draw the right name
 * on their first paint rather than replacing it a moment later — see
 * `brand.ts`. It cannot reject: `loadBrand` swallows its own failures and
 * leaves the default, because a panel that will not open because it could not
 * learn its own name is worse than one that opens under the wrong one.
 */
//
// `.then` rather than a top-level `await`: the build targets browsers back to
// Safari 14 and esbuild refuses top-level await there. Raising the target to
// fix one line would quietly change which browsers can open the panel at all.
void loadBrand().then(() => {
  // `index.html` ships a title with no brand in it, because the file is static
  // and the same bundle serves every installation. This is where the tab gets a
  // name, and it is why the static one reads «پنل مدیریت» rather than ours.
  document.title = `پنل مدیریت ${brand()}`;

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
