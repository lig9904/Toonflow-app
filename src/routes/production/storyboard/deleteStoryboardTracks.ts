import u from "@/utils";
import { createBatchDeleteStoryboardTracksRouter } from "@/services/trackWorkspace/deleteStoryboardHttp";

export default createBatchDeleteStoryboardTracksRouter(u.db);
