import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // Optional hardening for production (see DEPLOY-CF.md):
  // incremental cache over R2 keeps ISR/revalidate responses warm across
  // worker instances. The panel is fully dynamic (no ISR), so it is safe
  // to run without it.
  //  incrementalCache: r2IncrementalCache,
});
