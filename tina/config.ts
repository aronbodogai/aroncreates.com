import { defineConfig } from "tinacms";
import { BlogCollection } from "./collections/blog";
import { GlobalConfigCollection } from "./collections/global-config";
import { PageCollection } from "./collections/page";

const branch = process.env.WORKERS_CI_BRANCH || "main";

// No `clientId`/`token`: this site has no hosted CMS backend. The admin UI is
// built and served only by `pnpm dev` on a machine that has the repo, and
// `pnpm strip-admin` deletes it from `dist` so it never reaches production.
// Editing is local, and publishing is a git push.
export default defineConfig({
  branch,

  build: {
    outputFolder: "admin",
    publicFolder: "public",
  },
  media: {
    tina: {
      mediaRoot: "",
      publicFolder: "public",
    },
  },
  // See docs on content modeling for more info on how to setup new content models: https://tina.io/docs/schema/
  schema: {
    collections: [
      BlogCollection,
      PageCollection,
      GlobalConfigCollection,
    ],
  },
});
