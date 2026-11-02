/** A separate, owner-chosen model can review and write context summaries without changing the conversation model. */
import { CompactionTask, defineExtension, hook } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

export default function compactionReview(host: PocketHost) {
    return defineExtension({
        name: "pocket-compaction-review",
        hooks: [
            hook(CompactionTask, {
                beforeCompact: (compaction, api, context) =>
                    host.compactionReview.summarize(compaction, api, context),
            }),
        ],
    });
}
