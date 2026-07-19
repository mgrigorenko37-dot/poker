import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pokerRouter from "./poker";
import analysisRouter from "./analysis";
import pythonScanRouter from "./python-scan";
import telegramRouter from "./telegram";
import visionScanRouter from "./vision-scan";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pokerRouter);
router.use(analysisRouter);
router.use(pythonScanRouter);
router.use(telegramRouter);
router.use(visionScanRouter);

export default router;
