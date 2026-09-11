import express from "express";
import u from "../../../utils";
import { createImageReviewHandlers } from "../../../services/imageReviews/http";
import { getProductionImageReviewService } from "../../../services/imageReviews/runtime";

export default express.Router().post("/", createImageReviewHandlers(u.db, getProductionImageReviewService()).reviewImage);
