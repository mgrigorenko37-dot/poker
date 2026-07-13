import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pokerRouter from "./poker";
import analysisRouter from "./analysis";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pokerRouter);
router.use(analysisRouter);

export default router;
