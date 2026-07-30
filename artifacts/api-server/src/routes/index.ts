import { Router, type IRouter } from "express";
import healthRouter from "./health";
import analysisRouter from "./analysis";
import pythonScanRouter from "./python-scan";
import telegramRouter from "./telegram";
import visionScanRouter from "./vision-scan";
import cfrRouter from "./cfr";

const router: IRouter = Router();

router.use(healthRouter);
router.use(analysisRouter);
router.use(pythonScanRouter);
router.use(telegramRouter);
router.use(visionScanRouter);
router.use(cfrRouter);

export default router;
