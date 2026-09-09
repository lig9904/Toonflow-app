import express from "express";
import u from "@/utils";
import { createProductionHandlers } from "@/services/productionHttp";
export default express.Router().post("/", createProductionHandlers(u.db, (path) => u.oss.getSmallImageUrl(path)).updateStoryboardUrl);
